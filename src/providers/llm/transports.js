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
 * XChain Hub - llm provider: the per-transport request shapes
 *
 * The openai_api and claude_spawn branches of runLlmDispatch, and the request
 * body of its anthropic_api branch. Each shapes the outgoing call to its
 * vendor's contract and classifies a reached model's refusal or truncation
 * distinctly from a transport failure.
 *
 ********************************************************************/

const { isReasoningModel, anthropicRejectsSampling, modelCarriesSystemRole } = require('./models');
const { callOpenAi } = require('./http');

// The chat-completions request for an OpenAI-vendor model.
function openAiRequestBody(model, maxTokens, temperature, prompt, sys, jsonMode) {
    const reqBody = {
        model,
        max_completion_tokens: maxTokens,
        messages: []
    };
    // Early o-series ids (o1-mini/o1-preview) reject a system-role message
    // outright (400). Other o-series models accept the instruction only via
    // the 'developer' role alias. gpt-* (incl. gpt-5) keeps plain 'system'.
    const isEarlyOSeries = !modelCarriesSystemRole(model);
    // Early o-series models also reject the response_format parameter (400),
    // the same restricted request shape that bans the system role. Omit it
    // for them; the appended JSON system instruction (folded into the user
    // turn below) still steers these models toward a JSON-object response.
    if (jsonMode && !isEarlyOSeries) reqBody.response_format = { type: 'json_object' };
    const isOSeries = /^o[0-9]/.test(String(model));
    let userContent = prompt;
    if (sys) {
        if (isEarlyOSeries) {
            userContent = sys + '\n\n' + prompt;
        } else {
            reqBody.messages.push({ role: isOSeries ? 'developer' : 'system', content: sys });
        }
    }
    reqBody.messages.push({ role: 'user', content: userContent });
    // OpenAI o-series reasoning models reject any explicit temperature != 1 with
    // HTTP 400 ("Unsupported value: 'temperature'"). The gpt-5 reasoning family
    // (gpt-5, gpt-5-mini, gpt-5-nano) carries the same restriction. fetch()/
    // agree() always pass a numeric temperature (DEFAULT_TEMPERATURE=0), so a
    // `typeof temperature` guard is always true and would hard-fail every
    // reasoning-model round. Gate on the model id instead: omit temperature for
    // o-series/gpt-5 and let the API default, send it for other chat models
    // (gpt-*, including the non-reasoning gpt-5-chat*) that honor it.
    const reasoningModel = isReasoningModel(model);
    if (!reasoningModel && typeof temperature === 'number') reqBody.temperature = temperature;
    return reqBody;
}

// The completion text of a chat-completions result, or the model-level outcome
// it reports instead.
function openAiText(result) {
    let choice = Array.isArray(result.choices) ? result.choices[0] : null;
    // A model refusal (choice.message.refusal populated, content null) or a
    // content_filter stop is a MODEL-level outcome, not a transport failure.
    // Surface it as a distinct error so it is recorded distinctly from an
    // empty/transport error (the round still records provider_error; only the
    // recorded error detail differs, verdict derivation is unchanged).
    let msg = choice && choice.message ? choice.message : null;
    if (msg && typeof msg.refusal === 'string' && msg.refusal.length > 0) {
        let err = new Error('llm: OpenAI model refusal: ' + msg.refusal.substring(0, 200));
        err.kind = 'refusal';
        err.refusal = msg.refusal;
        throw err;
    }
    if (choice && choice.finish_reason === 'content_filter') {
        let err = new Error('llm: OpenAI content_filter stop');
        err.kind = 'refusal';
        err.refusal = (msg && typeof msg.refusal === 'string') ? msg.refusal : '';
        throw err;
    }
    let text   = (msg && typeof msg.content === 'string') ? msg.content : '';
    // A 'length' stop is a budget-exhaustion outcome (for reasoning models, the
    // max_completion_tokens cap was consumed by internal reasoning before the
    // verdict was emitted). Classify it distinctly (kind='truncation',
    // transient=false) rather than returning the text, so the judge chain does
    // not re-ask a different model for what is a reached-judge outcome.
    //
    // This guard once also required text.length===0, which failed
    // OPEN on the case that matters. A 'length' stop means the response is
    // INCOMPLETE whether or not bytes were emitted, and a partial one reaches the
    // hub's two highest-integrity paths: fetch() signs it as the on-chain
    // attestation answer, and agree() can read a coincidentally-parseable partial
    // JSON object as a finalized verdict. Emitted length is not evidence against
    // truncation, so a partial is never salvaged.
    if (choice && choice.finish_reason === 'length') {
        let err = new Error('llm: OpenAI response truncated (finish_reason=length); max_completion_tokens too low');
        err.kind = 'truncation';
        err.transient = false;
        throw err;
    }
    return text;
}

// The Messages API request for a Claude-family model on the anthropic_api transport.
function anthropicRequestBody(model, maxTokens, temperature, prompt, sys) {
    // Shape the outgoing value to the vendor contract the way the OpenAI branch
    // above shapes its own. Both of the temperatures that can reach here are
    // already bounded (an explicit envelope value >1 throws in fetch(), and
    // _setConfig refuses an out-of-range governance default), so this is the
    // net under a future un-guarded source rather than a live behavior change;
    // a non-numeric value is passed through untouched so the vendor default
    // still applies. Clamping beats a 400 on every call, and the value is
    // identical on every hub, so no round splits on it.
    const anthropicTemperature = (typeof temperature === 'number' && Number.isFinite(temperature))
        ? Math.min(Math.max(temperature, 0), 1)
        : temperature;
    const reqBody = {
        model,
        max_tokens:  maxTokens,
        messages:    [{ role: 'user', content: prompt }]
    };
    // Omit the field entirely for the model families that removed it
    // (400, not accepted-and-ignored). Mirrors the OpenAI branch's reasoning-model
    // gate above; every other Claude model keeps the clamped explicit value, so
    // the temperature-0 contract is unchanged wherever it is actually reachable.
    if (!anthropicRejectsSampling(model)) reqBody.temperature = anthropicTemperature;
    if (sys) reqBody.system = sys;
    return reqBody;
}

// The concatenated text blocks of a Messages API result.
function anthropicText(result) {
    let text = '';
    if (Array.isArray(result.content)) {
        for (let c of result.content) {
            if (c.type === 'text' && typeof c.text === 'string') text += c.text;
        }
    }
    return text;
}

// The openai_api branch. `deps` carries the provider instance's token tally.
async function dispatchOpenAi(deps, { prompt, model, maxTokens, temperature, timeoutMs, _usage }, auth, sys, jsonMode) {
    const reqBody = openAiRequestBody(model, maxTokens, temperature, prompt, sys, jsonMode);
    const result = await callOpenAi('/v1/chat/completions', reqBody, auth.apiKey, { timeoutMs }, deps._tokenUsage);
    // The vendor is billed from here on, whichever branch below
    // throws, so the settle record carries this call's real usage.
    if (_usage && result && result.usage) _usage.tokens = result.usage;
    return openAiText(result);
}

// The claude_spawn branch. `deps` carries the provider instance's CLI runner,
// LlmSettings and token tally.
async function dispatchClaudeSpawn(deps, { prompt, model, timeoutMs, _usage }, sys, systemIsSoleInstruction) {
    const { runClaudePrint, settings, _tokenUsage } = deps;
    // The CLI doesn't expose temperature or a hard max-tokens cap;
    // redundancy>=3's judge_model step is what converges spreads.
    // Thread the resolved per-call budget so --max-budget-usd is
    // actually emitted (claude-spawn.js only appends the flag for a positive
    // number); the resolver now always yields one, so this
    // transport is capped unless env/governance widens it.
    const budget = settings.resolveMaxBudgetUsd();
    const spawnOpts = {
        prompt,
        model,
        timeoutMs:    timeoutMs || 60000
    };
    // The CLI's default carries systemPrompt to --append-system-prompt, which adds
    // to the agent persona the binary bakes in rather than replacing it. That is the
    // right shape for a requester-supplied system block (the baseline stays), but it
    // silently falsifies the judge's own claim that only its system message is a real
    // instruction: on this transport the judge block would be one layer on top of an
    // opaque prompt this codebase does not control, while the anthropic_api branch
    // in llm.js sends it as the sole system content. Take the full override for that
    // caller so the trust boundary is the same on both Claude transports.
    if (sys && systemIsSoleInstruction) spawnOpts.systemPromptOverride = sys;
    else if (sys)                       spawnOpts.systemPrompt         = sys;
    if (budget !== undefined) spawnOpts.maxBudgetUsd = budget;
    const { result, json } = await runClaudePrint(spawnOpts);
    // This branch once dropped `json` and recorded nothing, so
    // subscription spend was the one billed path with no accounting at all.
    // `claude --print --output-format json` returns total_cost_usd + usage.
    if (json) {
        if (_usage) {
            if (Number.isFinite(Number(json.total_cost_usd))) _usage.costUsd = Number(json.total_cost_usd);
            if (json.usage) _usage.tokens = json.usage;
        }
        if (json.usage) {
            _tokenUsage.inputTokens  += json.usage.input_tokens  ?? 0;
            _tokenUsage.outputTokens += json.usage.output_tokens ?? 0;
        }
        _tokenUsage.calls += 1;
    }
    return result;
}

module.exports = { anthropicRequestBody, anthropicText, dispatchOpenAi, dispatchClaudeSpawn };