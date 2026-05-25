/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Hub - Attestation Provider: llm
 *
 * Implements the External Attestation Framework provider interface for LLM
 * calls. Validators with the `attestation` capability staked at MIN_STAKE
 * for the llm provider tier can serve ATTESTATION_REQUESTs with
 * provider_id='llm'.
 *
 * Spec: claude/reports/specs/2026-05-24_llm-attestation-provider.md
 *
 * Provider interface (mirrored by all providers — see providers/README):
 *   fetch(payload, options)  -> Promise<{ body: Buffer, meta: string }>
 *   agree(proposals)         -> Promise<{ body, meta } | null>
 *   healthCheck()            -> Promise<{ ok, error? }>
 *
 * `agree` is async on this provider: redundancy>=3 consensus uses a
 * `judge_model` API call (spec §6.2). For redundancy=1 the single
 * proposal is returned trivially (spec §6.1).
 *
 * No SDK dependency — direct HTTPS to api.anthropic.com keeps hub deps
 * minimal. Switch to @anthropic-ai/sdk if/when we add prompt caching or
 * streaming, neither of which is in this provider's v1 scope.
 *
 ********************************************************************/

const https = require('https');

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

// Issue an Anthropic API call against the user-supplied prompt envelope.
// Returns { body: Buffer(response_text_utf8), meta: <model_used> }.
//
// Envelope shape (spec §4):
//   { prompt: string, system?: string, max_tokens?: number, format?: 'text'|'json_object', temperature?: number }
//
// Approved-model selection (spec §5):
//   LLM_DEFAULT_MODEL env override, falling back to APPROVED_MODELS[0].
//   If the env value isn't in APPROVED_MODELS, fall back rather than serve
//   an unauthorized model (the response would fail signature consensus
//   anyway since other validators would use a different model).
exports.fetch = async (payload, options) => {
    options = options || {};
    let envelope;
    try { envelope = JSON.parse(payload); }
    catch (_) { throw new Error('llm: payload must be a JSON envelope'); }

    if (!envelope.prompt || typeof envelope.prompt !== 'string')
        throw new Error('llm: envelope.prompt (string) is required');
    if (envelope.envelope_version !== undefined && Number(envelope.envelope_version) > PROMPT_ENVELOPE_VERSION)
        throw new Error('llm: unsupported envelope_version (got ' + envelope.envelope_version + ', max ' + PROMPT_ENVELOPE_VERSION + ')');

    let defaultModel = process.env.LLM_DEFAULT_MODEL || APPROVED_MODELS[0];
    if (APPROVED_MODELS.indexOf(defaultModel) === -1) defaultModel = APPROVED_MODELS[0];

    let maxTokens   = Math.min(Number(envelope.max_tokens) || MAX_TOKENS_DEFAULT, MAX_TOKENS_DEFAULT);
    let temperature = (typeof envelope.temperature === 'number') ? envelope.temperature : DEFAULT_TEMPERATURE;
    // For redundancy >= 3 the framework will run judge_model; temperature 0
    // is the highest-determinism choice. Currently the provider doesn't see
    // redundancy here (that decision is at the consensus layer); validators
    // always fetch at the envelope/default temperature and judge_model
    // declares semantic equivalence.

    let reqBody = {
        model:       defaultModel,
        max_tokens:  maxTokens,
        temperature: temperature,
        messages:    [{ role: 'user', content: envelope.prompt }]
    };
    if (envelope.system) reqBody.system = envelope.system;

    let result = await callAnthropic('/v1/messages', reqBody, options);

    // Concatenate any text segments — Anthropic returns content as an array of typed blocks
    let text = '';
    if (Array.isArray(result.content)){
        for (let c of result.content){
            if (c.type === 'text' && typeof c.text === 'string') text += c.text;
        }
    }
    if (text.length === 0) throw new Error('llm: Anthropic API returned empty text content');

    return {
        body: Buffer.from(text, 'utf8'),
        meta: defaultModel
    };
};

// Consensus strategy: judge_model (spec §6).
//
// Single-proposal case (redundancy=1): trivial — return the only proposal.
// Multi-proposal case (redundancy>=3): build a judge prompt enumerating
// candidate responses, run JUDGE_MODEL at temperature=0, parse JSON
// verdict { equivalent, canonical_index } and return the canonical
// proposal (or null on no_quorum).
exports.agree = async (proposals) => {
    if (!Array.isArray(proposals) || proposals.length === 0) return null;
    if (proposals.length === 1) {
        return { body: proposals[0].body, meta: proposals[0].meta };
    }

    let candidates = proposals.map(p => Buffer.isBuffer(p.body) ? p.body.toString('utf8') : String(p.body || ''));
    let judgePrompt = buildJudgePrompt(candidates);

    let reqBody = {
        model:       JUDGE_MODEL,
        max_tokens:  256,
        temperature: 0,
        messages:    [{ role: 'user', content: judgePrompt }]
    };

    let result;
    try {
        result = await callAnthropic('/v1/messages', reqBody, {});
    } catch (e) {
        // Judge unreachable — defer to no_quorum. Validators will retry on
        // the next request. (Spec §6.4 ack residual risk.)
        return null;
    }

    let judgeText = '';
    if (Array.isArray(result.content)){
        for (let c of result.content){
            if (c.type === 'text' && typeof c.text === 'string') judgeText += c.text;
        }
    }
    if (!judgeText) return null;

    // Judge may wrap output in markdown/prose; extract the first {...} JSON object
    let judgement;
    try {
        let m = judgeText.match(/\{[\s\S]*?\}/);
        if (!m) return null;
        judgement = JSON.parse(m[0]);
    } catch (_) {
        return null;
    }

    if (judgement.equivalent === true && judgement.canonical_index !== null && judgement.canonical_index !== undefined){
        let idx = Number(judgement.canonical_index) - 1;  // judge prompt is 1-indexed
        if (Number.isInteger(idx) && idx >= 0 && idx < proposals.length){
            return { body: proposals[idx].body, meta: proposals[idx].meta };
        }
    }
    return null;
};

// Capability self-test probe. Confirms API key is configured. Avoids
// burning the API quota on a real completion (a missing key is the only
// fixed failure mode this probe needs to catch at startup).
exports.healthCheck = async () => {
    let apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY not configured' };
    return { ok: true, status: 'key-present' };
};

// ---------- internals ----------

function buildJudgePrompt(candidates){
    let lines = [
        'You are an evaluator. Determine whether the candidate responses below are SEMANTICALLY EQUIVALENT.',
        '',
        'Candidate responses:'
    ];
    for (let i = 0; i < candidates.length; i++){
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

async function callAnthropic(apiPath, body, options){
    let apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('llm: ANTHROPIC_API_KEY not configured');

    let timeoutMs = Number(options && options.timeoutMs) || 30000;
    let data = JSON.stringify(body);

    return await new Promise((resolve, reject) => {
        let settled = false;
        let safeResolve = (v) => { if (!settled){ settled = true; resolve(v); } };
        let safeReject  = (e) => { if (!settled){ settled = true; reject(e); } };

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
                    if (json.type === 'error' || json.error){
                        let msg = (json.error && json.error.message) ? json.error.message : JSON.stringify(json);
                        safeReject(new Error('llm: Anthropic API: ' + msg));
                        return;
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
