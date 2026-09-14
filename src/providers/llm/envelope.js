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
 * XChain Hub - llm provider: the fetch() request and response boundary
 *
 * What fetch() accepts from a requester before any vendor is chosen (the
 * prompt envelope and its fallback policy), which model serves it, and the
 * size cap its response must fit before it is signed.
 *
 ********************************************************************/

// Parse and validate the requester's prompt envelope (spec §4) against the provider's
// LlmSettings. Returns the parsed envelope; throws on the first rule it breaks.
function parseEnvelope(settings, payload, options) {
    let envelope;
    try { envelope = JSON.parse(payload); }
    catch (_) { throw new Error('llm: payload must be a JSON envelope'); }

    if (!envelope.prompt || typeof envelope.prompt !== 'string')
        throw new Error('llm: envelope.prompt (string) is required');
    if (envelope.envelope_version !== undefined && Number(envelope.envelope_version) > settings.PROMPT_ENVELOPE_VERSION)
        throw new Error('llm: unsupported envelope_version (got ' + envelope.envelope_version + ', max ' + settings.PROMPT_ENVELOPE_VERSION + ')');

    // Reject an out-of-shape requester numeric at this boundary rather than forwarding it.
    // A negative max_tokens survives the clamp below - Number(-1) is truthy,
    // so the `||` default never fires - and on a reasoning model the headroom add turns it
    // POSITIVE again, producing a silently wrong budget instead of a vendor 400.
    if (envelope.max_tokens !== undefined) {
        let mt = Number(envelope.max_tokens);
        if (!Number.isInteger(mt) || mt < 1)
            throw new Error('llm: envelope.max_tokens must be a positive integer');
    }
    if (envelope.temperature !== undefined) {
        if (typeof envelope.temperature !== 'number' || !Number.isFinite(envelope.temperature) ||
            envelope.temperature < 0 || envelope.temperature > 2)
            throw new Error('llm: envelope.temperature must be a number in [0, 2]');
    }
    // Same boundary rule for the optional system prompt: a non-string would otherwise
    // string-coerce into '[object Object]' on the json_object path and fail per
    // transport (spawn argv vs vendor 400) on the text path. Omission stays legal.
    if (envelope.system !== undefined && typeof envelope.system !== 'string')
        throw new Error('llm: envelope.system must be a string');

    // Requester-controlled fallback policy. 'any' (default): serve from any
    // approved model on the chain. 'strict': the requesting contract only
    // trusts the PRIMARY model (its prompts were engineered against it); when
    // the escalation ladder has advanced past rank 0 the fetch fails instead,
    // and the round records provider_error / the request expires + refunds.
    // options.modelRank is the pinned model's rank on the block-anchored
    // approved_models ladder (0 = primary), supplied by AttestationRound.
    let fallbackPolicy = (envelope.fallback === undefined) ? 'any' : String(envelope.fallback);
    if (fallbackPolicy !== 'any' && fallbackPolicy !== 'strict')
        throw new Error('llm: envelope.fallback must be "any" or "strict"');
    if (fallbackPolicy === 'strict' && Number(options.modelRank) > 0)
        throw new Error('llm: fallback_policy_strict - request only accepts the primary approved model');
    return envelope;
}

// The model this fetch is served by.
function resolveFetchModel(settings, options) {
    // The fetch model is supplied by the caller as options.pinnedModel, resolved
    // from the block-anchored provider config at the request's block so every
    // validator fetches with the SAME model. The per-operator process.env
    // LLM_DEFAULT_MODEL override is deliberately NOT consulted here: it was an
    // un-governed divergence source (different validators fetching with different
    // models produce more divergent bodies, making the leader's judge return
    // equivalent=false and the round fail to no_quorum).
    let model = options.pinnedModel || settings.APPROVED_MODELS[0];
    // A block-anchored pinnedModel is the consensus-agreed model for this request's
    // block and must be honored as-is. Clamping it against the live, governance-mutable
    // APPROVED_MODELS forks updated vs laggard validators across a hotReload: the updated
    // node swaps to APPROVED_MODELS[0] while the laggard keeps the pinned value. Only the
    // no-pin fallback needs the approved-list guard (APPROVED_MODELS[0] is always in it).
    if (!options.pinnedModel && settings.APPROVED_MODELS.indexOf(model) === -1) model = settings.APPROVED_MODELS[0];
    return model;
}

// The signed fetch() result for a vendor's response text.
function responseBody(text, options, model) {
    if (!text || text.length === 0) throw new Error('llm: returned empty text');

    // Enforce the caller's response-size cap the same way http_get does. Every
    // peer's PROPOSE/PREPARE gate silently drops a body over the provider def's
    // max_response_bytes (AttestationConsensus.maxBodyB64Length), so an over-cap
    // body fetched here would cost this validator's proposal (or quorum) with no
    // diagnostic attributable to the provider. Fail loudly at the point of fetch
    // instead. Do NOT truncate: a clipped LLM response is semantically invalid and
    // would still poison the attestation, just visibly.
    let body = Buffer.from(text, 'utf8');
    let maxBytes = Number(options.maxResponseBytes) || 0;
    if (maxBytes > 0 && body.length > maxBytes)
        throw new Error('llm: response ' + body.length + ' bytes exceeds maxResponseBytes cap ' + maxBytes);
    return {
        body: body,
        meta: model
    };
}

module.exports = { parseEnvelope, resolveFetchModel, responseBody };