/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - Attestation Provider: llm
 *
 * Implements the External Attestation Framework provider interface for LLM
 * calls. Validators with the `attestation` capability staked at MIN_STAKE
 * for the llm provider tier can serve ATTEST v0 (request) rows with
 * provider_id='llm'.
 *
 * Provider interface (mirrored by all providers; see providers/README):
 *   fetch(payload, options)  -> Promise<{ body: Buffer, meta: string }>
 *   agree(proposals)         -> Promise<{ body, meta } | null>
 *   healthCheck()            -> Promise<{ ok, error? }>
 *
 * MULTI-VENDOR: each model in the governance-approved chain maps to a
 * vendor (inferred from the model id, overridable via additional_config
 * `model_vendors`). Vendor transports, resolved at call time per the
 * operator's configured credentials (see lib/hub-credentials.js):
 *
 *   anthropic:
 *     `claude_spawn`: shells out to the `claude` CLI. Preferred. Auth
 *                     inherits from CLAUDE_CONFIG_DIR (auto-refreshing
 *                     refresh token written by `claude login`) or
 *                     CLAUDE_CODE_OAUTH_TOKEN. Cost model: Claude Code
 *                     subscription. Determinism: CLI does not expose
 *                     temperature; redundancy>=3 still converges via the
 *                     judge_model agreement check.
 *     `anthropic_api`: direct HTTPS to api.anthropic.com using
 *                     ANTHROPIC_API_KEY. Pay-per-token API billing.
 *                     Supports temperature=0 explicitly.
 *
 *   openai:
 *     `openai_api`:  direct HTTPS to api.openai.com (chat completions)
 *                     using OPENAI_API_KEY / HUB_OPENAI_API_KEY. Serves the
 *                     fallback slots of the approved_models chain so an
 *                     Anthropic outage cannot take the whole provider down.
 *
 * Which model actually served a request is consensus-visible: fetch()
 * returns it as `meta`, which the canonical signature binds and the ATTEST
 * v1 wire records on-chain.
 *
 ********************************************************************/

const https = require('https');
const { resolveLlmVendorAuth } = require('../lib/hub_credentials');
const { runClaudePrint } = require('../lib/claude_spawn');
const SpendGuard = require('../lib/spend_guard.js');
const hubConfig = require('../config');
const { getLogger } = require('../observability');
const logger = getLogger();
const { FETCH_REASONING_TOKEN_HEADROOM, isReasoningModel, anthropicRejectsSampling, modelCarriesSystemRole } = require('./llm/models');
const LlmSettings = require('./llm/settings');
const SpendAudit = require('./llm/spend');
const MetaGates = require('./llm/meta_gates');
const JudgeAgreement = require('./llm/agree');
const { parseEnvelope, resolveFetchModel, responseBody } = require('./llm/envelope');
const { _httpStatusError, isTransientStatus, settleOnce, armRequestFailures, tallyTokens } = require('./llm/http');
const { anthropicRequestBody, anthropicText, dispatchOpenAi, dispatchClaudeSpawn } = require('./llm/transports');

const _tokenUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };

// The provider is assembled from the parts under ./llm/. None of those parts holds
// state or requires the hub modules above: this file builds one instance of each
// per load and hands it what it uses. A suite that swaps hub_credentials or
// claude_spawn in the require cache and reloads this file therefore gets fresh
// settings, spend counters and a spend guard wired to the swapped modules, and an
// instance a suite already holds keeps its own, the same as every reload gave.
const settings  = new LlmSettings({ hubConfig, logger });
const spend     = new SpendAudit({ hubConfig, logger, SpendGuard, resolveLlmVendorAuth, vendorOfModel, runLlmDispatch });
const metaGates = new MetaGates({ logger, settings });
const judge     = new JudgeAgreement({ logger, settings, spend, metaGates });
const transportDeps = { runClaudePrint, settings, _tokenUsage };

exports.armSpendGuard = (cfg, persist) => spend.armSpendGuard(cfg, persist);
exports.spendStats = (now) => spend.spendStats(now);
exports._resetSpendGuardForTest = () => spend.resetSpendGuardForTest();
exports._isReasoningModel = isReasoningModel;
exports.anthropicRejectsSampling = anthropicRejectsSampling;
exports.llmEnabled = () => settings.llmEnabled();
exports._canonicalMetaForTest = (proposals, idx, outcome, pinnedApprovedModels) =>
    metaGates.canonicalMetaForTest(proposals, idx, outcome, pinnedApprovedModels);
exports._DEFAULT_MAX_BUDGET_USD = LlmSettings.DEFAULT_MAX_BUDGET_USD;
exports.resolveMaxBudgetUsd = () => settings.resolveMaxBudgetUsd();

// Map a model id to its vendor. A BLOCK-ANCHORED per-call map is EXCLUSIVE where
// one is supplied: resolution reads that map and then id-prefix inference, never
// the module-level MODEL_VENDORS. An unpinned call keeps the live order
// (MODEL_VENDORS, then prefix inference). Unknown ids throw at call time (never
// guess a vendor: sending a prompt to the wrong API leaks it to an unintended
// third party).
//
// `pinned` is the model_vendors map read from the SAME block-anchored
// additional_config that produced pinnedModel/pinnedJudgeModel. Without it the
// vendor lookup read the live, hotReload-mutable module map while the model id
// came from the request's block, so a governance change adding a new-family id
// plus its model_vendors entry in one block split the round: hubs that had
// reloaded resolved the vendor, laggards threw and recorded provider_error.
// Same anchoring rationale as the pinnedModel clamp-avoidance in fetch().
//
// The fallthrough to MODEL_VENDORS split the round the OTHER way and had to go:
// the two maps are the same governance field read at two different anchors, since
// _setConfig rewrites MODEL_VENDORS on every hotReload. A pinned map that merely
// lacked the id therefore sent a reloaded hub and a laggard to different vendor
// endpoints, with different credentials, over one block-anchored request.
// Exclusivity buys DETERMINISM, not success: an id the anchored map cannot resolve
// now throws on every hub, which is a uniform provider_error rather than a fork.
function vendorOfModel(model, pinned) {
    let id = String(model || '');
    let anchored = !!pinned && typeof pinned === 'object';
    if (anchored) {
        if (typeof pinned[id] === 'string') return pinned[id];
    } else if (settings.MODEL_VENDORS && typeof settings.MODEL_VENDORS[id] === 'string') {
        return settings.MODEL_VENDORS[id];
    }
    if (/^claude-/.test(id))                 return 'anthropic';
    if (/^(gpt-|chatgpt-|o[0-9])/.test(id))  return 'openai';
    throw new Error('llm: cannot infer vendor for model "' + id + '"' + (anchored
        ? ' from the block-anchored additional_config.model_vendors map'
        : ' (add it to additional_config.model_vendors)'));
}
exports._vendorOfModel = vendorOfModel;
exports._setConfig = (def) => settings.setConfig(def);
exports._CONSUMED_CONFIG_KEYS = LlmSettings.CONSUMED_CONFIG_KEYS;
exports._resetUnconsumedWarnState = () => settings.resetUnconsumedWarnState();

// Issue an LLM call against the user-supplied prompt envelope.
// Returns { body: Buffer(response_text_utf8), meta: <model_used> }.
//
// Envelope shape (spec §4):
//   { prompt: string, system?: string, max_tokens?: number,
//     format?: 'text'|'json_object', temperature?: number,
//     envelope_version?: number }
exports.fetch = async (payload, options) => {
    options = options || {};
    // Kill switch: refuse to dial any billed vendor while paused.
    if (!settings.llmEnabled()) throw settings.pausedError();
    let envelope = parseEnvelope(settings, payload, options);
    let model = resolveFetchModel(settings, options);

    let maxTokens   = Math.min(Number(envelope.max_tokens) || settings.MAX_TOKENS_DEFAULT, settings.MAX_TOKENS_DEFAULT);
    // Reasoning-family fetch models (o-series / gpt-5, not gpt-5-chat) bill reasoning
    // tokens against the completion budget, so the governance-tuned content bound
    // is consumed by reasoning before any attestation content is emitted
    // (finish_reason='length', empty body -> provider_error every round). Mirror
    // agree()'s judge headroom on the fetch path so an approved OpenAI reasoning
    // fallback can actually finalize; add headroom rather than replace so the
    // governance content budget is preserved. Chat-family models are unchanged.
    if (isReasoningModel(model)) maxTokens = maxTokens + FETCH_REASONING_TOKEN_HEADROOM;
    let temperature = (typeof envelope.temperature === 'number') ? envelope.temperature : settings.DEFAULT_TEMPERATURE;
    // Bound against the vendor that will actually receive the request: Anthropic caps
    // temperature at 1 where OpenAI chat allows 2, and the model is already pinned here,
    // so the split verdict is deterministic (same pinned model, same pinned vendor map).
    if (envelope.temperature !== undefined &&
        vendorOfModel(model, options.pinnedVendors || null) === 'anthropic' && temperature > 1)
        throw new Error('llm: envelope.temperature must be a number in [0, 1] for this model');

    // Envelope output format (spec §4). 'text' (default) leaves behavior unchanged;
    // 'json_object' constrains the request per-vendor (OpenAI response_format, plus a
    // JSON system instruction that also satisfies OpenAI's "json" keyword requirement
    // and shapes the Anthropic/CLI paths, which have no hard response_format switch).
    let format = (envelope.format === undefined) ? 'text' : String(envelope.format);
    if (format !== 'text' && format !== 'json_object')
        throw new Error('llm: envelope.format must be "text" or "json_object"');

    const text = await spend.runLlm({
        prompt:      envelope.prompt,
        system:      envelope.system,
        model,
        maxTokens,
        temperature,
        format,
        timeoutMs:   options.timeoutMs,
        // Block-anchored model_vendors for this request's block, so
        // the vendor resolves from the same config that pinned the model id.
        pinnedVendors: options.pinnedVendors || null
    });

    return responseBody(text, options, model);
};

exports.modelCarriesSystemRole = modelCarriesSystemRole;
exports._setJudgeCallForTest = (fn) => judge.setJudgeCallForTest(fn);
exports.agree = (proposals, options) => judge.agree(proposals, options);

// Capability self-test probe. Confirms credential paths are configured for
// the vendors the current model chains actually use. Avoids burning quota on
// a real completion at startup; a missing/misconfigured credential is the
// fixed failure mode this probe needs to catch.
//
// Verdict: the PRIMARY model's vendor must resolve, or the hub cannot serve
// the happy path at all. Missing FALLBACK-vendor credentials degrade the
// result (reported in `vendors`/`missing`) and only fail the probe when
// governance has set require_all_vendors - the economic enforcement lever:
// a failed self-test makes this validator skip llm rounds while still being
// counted in N, so unserved rounds expire and accrue missed_count against it.
exports.healthCheck = async (ctx) => {
    // Report a deliberate operator/governance pause as its own state,
    // distinct from a credential/transport failure, so operators can tell a kill
    // switch from a real outage in the logs. Carries paused:true for callers that
    // want to treat a pause differently from an ordinary ok:false.
    if (!settings.llmEnabled()) {
        let src = (String(hubConfig.LLM_PROVIDER_ENABLED || 'true') === 'false')
            ? 'LLM_PROVIDER_ENABLED=false' : 'additional_config.enabled=false';
        return { ok: false, paused: true, error: 'llm: provider paused (' + src + ')' };
    }
    let chainModels = [...settings.APPROVED_MODELS, settings.JUDGE_MODEL, ...settings.JUDGE_FALLBACK_MODELS].filter(Boolean);
    let vendors = [];
    for (let m of chainModels) {
        let v;
        try { v = vendorOfModel(m); }
        catch (_) { return { ok: false, error: 'unmapped vendor for model "' + m + '" (set additional_config.model_vendors)' }; }
        if (vendors.indexOf(v) === -1) vendors.push(v);
    }
    if (vendors.length === 0) vendors.push('anthropic');

    let primaryVendor = vendors[0];
    try { if (settings.APPROVED_MODELS[0]) primaryVendor = vendorOfModel(settings.APPROVED_MODELS[0]); } catch (_) {}

    let resolved = {};
    let missing  = [];
    let primaryAuth = null;
    for (let v of vendors) {
        let auth = resolveLlmVendorAuth(v, ctx);
        resolved[v] = !!auth.ok;
        if (!auth.ok) missing.push(v);
        if (v === primaryVendor) primaryAuth = auth;
    }

    if (!primaryAuth || !primaryAuth.ok) {
        return { ok: false, error: (primaryAuth && (primaryAuth.detail || primaryAuth.reason)) || 'no_credential_configured',
                 vendors: resolved, missing };
    }
    if (settings.REQUIRE_ALL_VENDORS && missing.length > 0) {
        return { ok: false, error: 'missing credentials for fallback vendor(s): ' + missing.join(', ') +
                 ' (require_all_vendors is set)', vendors: resolved, missing };
    }
    let res = { ok: true, transport: primaryAuth.transport, source: primaryAuth.source,
                vendors: resolved, tokenUsage: { ..._tokenUsage } };
    if (missing.length > 0) res.missing = missing;
    return res;
};

// systemIsSoleInstruction says the `system` block is hub-authored and its contract
// depends on being the model's ONLY system content (the judge framing, which tells the
// model that nothing outside the system message is an instruction). It is deliberately
// NOT set for a requester-supplied envelope.system: replacing the CLI's baseline there
// would hand a request author the entire system role on the validator box.
async function runLlmDispatch({ prompt, system, systemIsSoleInstruction, model, maxTokens, temperature, format, timeoutMs, pinnedVendors, _usage }) {
    const vendor = vendorOfModel(model, pinnedVendors);
    const auth   = resolveLlmVendorAuth(vendor);
    if (!auth.ok) throw new Error('llm: ' + (auth.detail || auth.reason || 'no credentials'));

    // json_object mode: append a JSON instruction to the system prompt for every
    // transport (prompt shaping for Anthropic/CLI which have no hard switch, and
    // it also satisfies OpenAI's requirement that the word "json" appear in the
    // messages when response_format=json_object is set). 'text'/undefined is a no-op.
    const jsonMode = (format === 'json_object');
    let sys = system;
    if (jsonMode) {
        let instr = 'Respond with a single valid JSON object and nothing else.';
        sys = sys ? (sys + '\n\n' + instr) : instr;
    }

    if (auth.transport === 'openai_api')   return dispatchOpenAi(transportDeps, { prompt, model, maxTokens, temperature, timeoutMs, _usage }, auth, sys, jsonMode);
    if (auth.transport === 'claude_spawn') return dispatchClaudeSpawn(transportDeps, { prompt, model, timeoutMs, _usage }, sys, systemIsSoleInstruction);

    if (auth.transport === 'anthropic_api') {
        const reqBody = anthropicRequestBody(model, maxTokens, temperature, prompt, sys);
        const result = await callAnthropic('/v1/messages', reqBody, auth.apiKey, { timeoutMs });
        // Billed from here on, whichever branch below throws.
        if (_usage && result && result.usage) _usage.tokens = result.usage;
        // A Claude-family refusal stop (stop_reason: "refusal") is a MODEL-level
        // outcome, not a transport failure. Surface it with the same distinct
        // kind='refusal' error the OpenAI path raises so the outcome is recorded
        // symmetrically across vendors (otherwise it falls through to the generic
        // 'returned empty text' error, since a refusal carries no text content).
        if (result && result.stop_reason === 'refusal') {
            let err = new Error('llm: Anthropic model refusal (stop_reason=refusal)');
            err.kind = 'refusal';
            err.refusal = '';
            throw err;
        }
        let text = anthropicText(result);
        // Anthropic's truncation stops are the counterpart to OpenAI's
        // finish_reason='length': 'max_tokens' is the per-response output cap, and
        // 'model_context_window_exceeded' is the distinct context-window limit the
        // Claude 4.5+ contract added. Both mean the response is incomplete; classify
        // them the same way (kind='truncation', transient=false) so per-vendor
        // outcome classification stays symmetric.
        //
        // The max_tokens guard once also required text.length===0 and
        // model_context_window_exceeded was not handled at all, so both fell through
        // as complete answers. See openAiText in llm/transports.js for why emitted length is
        // not evidence against truncation on a path that signs its result on-chain.
        if (result && (result.stop_reason === 'max_tokens' ||
                       result.stop_reason === 'model_context_window_exceeded')) {
            let err = new Error('llm: Anthropic response truncated (stop_reason=' +
                String(result.stop_reason) + '); max_tokens or context window too low');
            err.kind = 'truncation';
            err.transient = false;
            throw err;
        }
        return text;
    }

    throw new Error('llm: unsupported transport ' + auth.transport);
}

// POST one Messages API request; resolves the parsed body of a 2xx response.
async function callAnthropic(apiPath, body, apiKey, options) {
    let timeoutMs = Number(options && options.timeoutMs) || 30000;
    let data = JSON.stringify(body);

    return await new Promise((resolve, reject) => {
        let { safeResolve, safeReject } = settleOnce(resolve, reject);

        let req = https.request({
            method:   'POST',
            hostname: 'api.anthropic.com',
            path:     apiPath,
            headers: {
                'Content-Type':       'application/json',
                'x-api-key':          apiKey,
                'anthropic-version':  '2023-06-01',
                'Content-Length':     Buffer.byteLength(data)
            },
            timeout: timeoutMs
        }, (res) => {
            let chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end',  () => {
                let str = Buffer.concat(chunks).toString('utf8');
                try {
                    let json = JSON.parse(str);
                    // Status first, body shape second: see _httpStatusError. The
                    // shape check below still runs for a 2xx carrying an error
                    // envelope, which vendors do return.
                    let statusErr = _httpStatusError(res, 'Anthropic API', json, str);
                    if (statusErr) { safeReject(statusErr); return; }
                    if (json.type === 'error' || json.error) {
                        let msg = (json.error && json.error.message) ? json.error.message : JSON.stringify(json);
                        let err = new Error('llm: Anthropic API: ' + msg);
                        err.httpStatus = res.statusCode;
                        err.transient  = isTransientStatus(res.statusCode);
                        safeReject(err);
                        return;
                    }
                    if (json.usage) tallyTokens(_tokenUsage, json.usage.input_tokens, json.usage.output_tokens);
                    safeResolve(json);
                } catch (e) {
                    // A 429/5xx from a gateway/proxy often carries a non-JSON (HTML)
                    // body and lands here; classify by status so it is not misrecorded
                    // as a hard malformed-response error.
                    let err = new Error('llm: Anthropic API: malformed response (' + str.substring(0, 200) + ')');
                    err.httpStatus = res.statusCode;
                    err.transient  = isTransientStatus(res.statusCode);
                    safeReject(err);
                }
            });
            res.on('error', (e) => { let err = new Error('llm: response error: ' + e.message); err.transient = true; safeReject(err); });
        });
        armRequestFailures(req, timeoutMs, safeReject);
        req.write(data);
        req.end();
    });
}
