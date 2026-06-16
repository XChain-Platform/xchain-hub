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
 * Spec: claude/reports/specs/2026-05-24_llm-attestation-provider.md
 *
 * Provider interface (mirrored by all providers — see providers/README):
 *   fetch(payload, options)  -> Promise<{ body: Buffer, meta: string }>
 *   agree(proposals)         -> Promise<{ body, meta } | null>
 *   healthCheck()            -> Promise<{ ok, error? }>
 *
 * Two transports are supported and resolved at call time per the operator's
 * configured credentials (see lib/hub-credentials.js):
 *
 *   `claude_spawn`  — shells out to the `claude` CLI. Preferred. Auth
 *                     inherits from CLAUDE_CONFIG_DIR (auto-refreshing
 *                     refresh token written by `claude login`) or
 *                     CLAUDE_CODE_OAUTH_TOKEN. Cost model: Claude Code
 *                     subscription. Determinism: CLI does not expose
 *                     temperature; redundancy>=3 still converges via the
 *                     judge_model agreement check.
 *
 *   `anthropic_api` — direct HTTPS to api.anthropic.com using
 *                     ANTHROPIC_API_KEY. Pay-per-token API billing.
 *                     Supports temperature=0 explicitly.
 *
 ********************************************************************/

const https = require('https');
const { resolveHubLlmAuth } = require('../lib/hub-credentials');
const { runClaudePrint } = require('../lib/claude-spawn');

const _tokenUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };

// Provider-def-injected configuration. ProviderRegistry calls _setConfig
// after loading the def from the configs table; these defaults are the
// spec §3 fallbacks for first-startup before any governance proposal.
let APPROVED_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-7'];
let JUDGE_MODEL     = 'claude-haiku-4-5';
let MAX_TOKENS_DEFAULT  = 1024;
let DEFAULT_TEMPERATURE = 0;
let PROMPT_ENVELOPE_VERSION = 1;

// Allow ProviderRegistry to inject the registered provider def at load time
// so governance-controlled `additional_config` takes effect without a hub
// restart. Called from ProviderRegistry.load() / .hotReload().
exports._setConfig = (def) => {
    if (!def || !def.additional_config) return;
    let ac = def.additional_config;
    if (Array.isArray(ac.approved_models) && ac.approved_models.length > 0)
        APPROVED_MODELS = ac.approved_models.slice();
    if (ac.judge_model)                JUDGE_MODEL             = String(ac.judge_model);
    if (Number(ac.max_completion_tokens))  MAX_TOKENS_DEFAULT  = Number(ac.max_completion_tokens);
    if (typeof ac.default_temperature === 'number') DEFAULT_TEMPERATURE = ac.default_temperature;
    if (Number(ac.prompt_envelope_version)) PROMPT_ENVELOPE_VERSION = Number(ac.prompt_envelope_version);
};

// Issue an LLM call against the user-supplied prompt envelope.
// Returns { body: Buffer(response_text_utf8), meta: <model_used> }.
//
// Envelope shape (spec §4):
//   { prompt: string, system?: string, max_tokens?: number,
//     format?: 'text'|'json_object', temperature?: number,
//     envelope_version?: number }
exports.fetch = async (payload, options) => {
    options = options || {};
    let envelope;
    try { envelope = JSON.parse(payload); }
    catch (_) { throw new Error('llm: payload must be a JSON envelope'); }

    if (!envelope.prompt || typeof envelope.prompt !== 'string')
        throw new Error('llm: envelope.prompt (string) is required');
    if (envelope.envelope_version !== undefined && Number(envelope.envelope_version) > PROMPT_ENVELOPE_VERSION)
        throw new Error('llm: unsupported envelope_version (got ' + envelope.envelope_version + ', max ' + PROMPT_ENVELOPE_VERSION + ')');

    // The fetch model is supplied by the caller as options.pinnedModel, resolved
    // from the block-anchored provider config at the request's block so every
    // validator fetches with the SAME model. The per-operator process.env
    // LLM_DEFAULT_MODEL override is deliberately NOT consulted here: it was an
    // un-governed divergence source (different validators fetching with different
    // models produce more divergent bodies, making the leader's judge return
    // equivalent=false and the round fail to no_quorum).
    let model = options.pinnedModel || APPROVED_MODELS[0];
    if (APPROVED_MODELS.indexOf(model) === -1) model = APPROVED_MODELS[0];

    let maxTokens   = Math.min(Number(envelope.max_tokens) || MAX_TOKENS_DEFAULT, MAX_TOKENS_DEFAULT);
    let temperature = (typeof envelope.temperature === 'number') ? envelope.temperature : DEFAULT_TEMPERATURE;

    const text = await _runLlm({
        prompt:      envelope.prompt,
        system:      envelope.system,
        model,
        maxTokens,
        temperature,
        timeoutMs:   options.timeoutMs
    });

    if (!text || text.length === 0) throw new Error('llm: returned empty text');
    return {
        body: Buffer.from(text, 'utf8'),
        meta: model
    };
};

// Consensus strategy: judge_model (spec §6).
//
// Single-proposal case (redundancy=1): trivial — return the only proposal.
// Multi-proposal case (redundancy>=3): build a judge prompt enumerating
// candidate responses, run JUDGE_MODEL at temperature=0, parse JSON
// verdict { equivalent, canonical_index } and return the canonical
// proposal (or null on no_quorum).
exports.agree = async (proposals, options) => {
    options = options || {};
    if (!Array.isArray(proposals) || proposals.length === 0) return null;
    if (proposals.length === 1) {
        return { body: proposals[0].body, meta: proposals[0].meta };
    }

    // The judge model is supplied by the leader as options.pinnedJudgeModel,
    // resolved from the block-anchored provider config at the request's block, so
    // it does not depend on this hub's module-mutable JUDGE_MODEL (which a
    // governance hotReload can change mid-round). Fall back to JUDGE_MODEL only
    // when no pinned value is provided (e.g. a non-consensus caller).
    let judgeModel = options.pinnedJudgeModel || JUDGE_MODEL;

    let candidates = proposals.map(p => Buffer.isBuffer(p.body) ? p.body.toString('utf8') : String(p.body || ''));
    let judgePrompt = _buildJudgePrompt(candidates);

    let judgeText;
    try {
        judgeText = await _runLlm({
            prompt:      judgePrompt,
            model:       judgeModel,
            maxTokens:   256,
            temperature: 0
        });
    } catch (_) {
        // Judge unreachable — defer to no_quorum. Validators will retry on
        // the next request. (Spec §6.4 ack residual risk.)
        return null;
    }

    if (!judgeText) return null;

    // Judge may wrap output in markdown/prose; extract the first {...} JSON object.
    let judgement;
    try {
        let m = judgeText.match(/\{[\s\S]*?\}/);
        if (!m) return null;
        judgement = JSON.parse(m[0]);
    } catch (_) {
        return null;
    }

    if (judgement.equivalent === true && judgement.canonical_index !== null && judgement.canonical_index !== undefined) {
        let idx = Number(judgement.canonical_index) - 1;  // judge prompt is 1-indexed
        if (Number.isInteger(idx) && idx >= 0 && idx < proposals.length) {
            return { body: proposals[idx].body, meta: proposals[idx].meta };
        }
    }
    return null;
};

// Capability self-test probe. Confirms at least one credential path is
// configured. Avoids burning quota on a real completion at startup — a
// missing/misconfigured credential is the only fixed failure mode this
// probe needs to catch.
exports.healthCheck = async (ctx) => {
    const auth = resolveHubLlmAuth(ctx);
    if (!auth.ok) return { ok: false, error: auth.detail || auth.reason || 'no_credential_configured' };
    return { ok: true, transport: auth.transport, source: auth.source, tokenUsage: { ..._tokenUsage } };
};

// ---------- internals ----------

// Pick the configured transport and execute the LLM call.
// Returns the response text (string). Throws on transport-level failure.
async function _runLlm({ prompt, system, model, maxTokens, temperature, timeoutMs }) {
    const auth = resolveHubLlmAuth();
    if (!auth.ok) throw new Error('llm: ' + (auth.detail || auth.reason || 'no credentials'));

    if (auth.transport === 'claude_spawn') {
        // The CLI doesn't expose temperature or a hard max-tokens cap;
        // redundancy>=3's judge_model step is what converges spreads.
        const { result } = await runClaudePrint({
            prompt,
            model,
            systemPrompt: system,
            timeoutMs:    timeoutMs || 60000
        });
        return result;
    }

    if (auth.transport === 'anthropic_api') {
        const reqBody = {
            model,
            max_tokens:  maxTokens,
            temperature,
            messages:    [{ role: 'user', content: prompt }]
        };
        if (system) reqBody.system = system;
        const result = await _callAnthropic('/v1/messages', reqBody, auth.apiKey, { timeoutMs });
        let text = '';
        if (Array.isArray(result.content)) {
            for (let c of result.content) {
                if (c.type === 'text' && typeof c.text === 'string') text += c.text;
            }
        }
        return text;
    }

    throw new Error('llm: unsupported transport ' + auth.transport);
}

function _buildJudgePrompt(candidates) {
    let lines = [
        'You are an evaluator. Determine whether the candidate responses below are SEMANTICALLY EQUIVALENT.',
        '',
        'Candidate responses:'
    ];
    for (let i = 0; i < candidates.length; i++) {
        lines.push((i + 1) + '. ' + candidates[i]);
    }
    lines.push('');
    lines.push('Return ONLY a JSON object on one line with two keys:');
    lines.push('- "equivalent": true if all candidates convey the same answer; false otherwise.');
    lines.push('- "canonical_index": when equivalent=true, the 1-indexed candidate to use as the canonical response. Pick the shortest/clearest. When equivalent=false, null.');
    lines.push('');
    lines.push('Example: {"equivalent": true, "canonical_index": 2}');
    lines.push('Example: {"equivalent": false, "canonical_index": null}');
    return lines.join('\n');
}

async function _callAnthropic(apiPath, body, apiKey, options) {
    let timeoutMs = Number(options && options.timeoutMs) || 30000;
    let data = JSON.stringify(body);

    return await new Promise((resolve, reject) => {
        let settled = false;
        let safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
        let safeReject  = (e) => { if (!settled) { settled = true; reject(e); } };

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
                    if (json.type === 'error' || json.error) {
                        let msg = (json.error && json.error.message) ? json.error.message : JSON.stringify(json);
                        safeReject(new Error('llm: Anthropic API: ' + msg));
                        return;
                    }
                    if (json.usage) {
                        _tokenUsage.inputTokens  += json.usage.input_tokens  ?? 0;
                        _tokenUsage.outputTokens += json.usage.output_tokens ?? 0;
                        _tokenUsage.calls        += 1;
                    }
                    safeResolve(json);
                } catch (e) {
                    safeReject(new Error('llm: Anthropic API: malformed response (' + str.substring(0, 200) + ')'));
                }
            });
            res.on('error', (e) => safeReject(new Error('llm: response error: ' + e.message)));
        });
        req.on('error',   (e) => safeReject(new Error('llm: request error: ' + e.message)));
        req.on('timeout', ()  => { req.destroy(); safeReject(new Error('llm: timeout after ' + timeoutMs + 'ms')); });
        req.write(data);
        req.end();
    });
}
