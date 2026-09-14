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
 * XChain Hub - llm provider: per-model vendor contract facts
 *
 * What a model id alone decides, independent of governance config: whether
 * it is a reasoning-family model, whether its vendor removed the sampling
 * parameters, whether it can carry a system role, and the token budgets that
 * follow from those answers.
 *
 ********************************************************************/

// Judge-call token budgets. A reasoning-family judge (gpt-5 / o-series) bills
// reasoning tokens against max_completion_tokens, so the ~20-token verdict JSON
// is routinely starved by internal reasoning at the 256 budget and returns
// finish_reason 'length' with empty content, which agree() maps to no_quorum:
// the cross-vendor judge fallback then fails exactly when it is needed. Give
// reasoning judges headroom while keeping the tight bound for chat-family judges.
const JUDGE_MAX_TOKENS = 256;
const JUDGE_MAX_TOKENS_REASONING = 2048;
// Extra completion budget added to a reasoning-family fetch model on top of the
// governance content bound, so internal reasoning does not starve the emitted
// attestation content. Fetch-path counterpart to the judge reasoning budget.
const FETCH_REASONING_TOKEN_HEADROOM = 2048;

// True for OpenAI reasoning-family models: the o-series, and the gpt-5 reasoning
// ids (gpt-5 / gpt-5-mini / gpt-5-nano), which reject an explicit temperature and
// bill reasoning tokens against max_completion_tokens. gpt-5-chat* is EXCLUDED on
// purpose: it is the non-reasoning ChatGPT model, it honors an explicit
// temperature, and classifying it as reasoning would silently drop the
// temperature-0 judge contract and over-grant reasoning headroom.
// Shared by the OpenAI transport gate and the judge-budget selection in agree().
//
// The exclusion absorbs an optional `.N` version segment. `(?!-chat)`
// only rejected a LITERAL `-chat` directly after `gpt-5`, so every versioned Chat
// id (gpt-5.1-chat-latest, gpt-5.2-chat-latest, ...) cleared the lookahead and
// classified as reasoning - the exact inversion the exclusion above exists to prevent.
// Versioned REASONING ids (gpt-5.1, gpt-5.1-mini) still classify as reasoning.
function isReasoningModel(model) {
    return /^o[0-9]/.test(String(model)) || /^gpt-5(?!(?:\.\d+)?-chat)/.test(String(model));
}

// True for Claude models whose Messages API contract REMOVED the sampling
// parameters: temperature, top_p and top_k are rejected with an HTTP 400 rather
// than accepted-and-ignored. Depth on these models is governed by the effort /
// adaptive-thinking controls instead, so there is no temperature to send at all.
//
// The anthropic_api branch emitted `temperature` unconditionally while
// claude-opus-4-7 sits in the DEFAULT approved_models ladder, so every fetch that
// escalated to the fallback - and every Opus-4.7 judge call, which is pinned at
// temperature 0 - was a deterministic vendor 400 mapped to provider_error.
// Omitting the field is not a determinism regression: the parameter does not
// exist on these models, so the temperature-0 contract was never reachable there.
//
// Deliberately an exact-id list, not a version-range regex. Membership is a vendor
// fact per model id, an unrecognised id keeps today's send-temperature behavior,
// and an id admitted here in error would silently drop the temperature-0 contract
// from a model that does honor it. Entries match the bare id or a dated snapshot
// of it (claude-opus-4-7-20260101). Contract reference: the claude-api knowledge
// pack, "Thinking & Effort" and shared/error-codes.md model-specific 400s.
const ANTHROPIC_NO_SAMPLING_MODELS = [
    'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5',
    'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5', 'claude-mythos-preview'
];
function anthropicRejectsSampling(model) {
    let m = String(model || '');
    return ANTHROPIC_NO_SAMPLING_MODELS.some(id => m === id || m.startsWith(id + '-'));
}

// Single source of truth for "can this OpenAI-vendor model carry the trusted
// judge framing in a real system/developer turn". Early o-series ids
// (o1-mini/o1-preview) reject a system-role message outright, so runLlm
// falls back to concatenating it into the user turn, collapsing the
// instruction-hierarchy boundary buildJudgePrompt relies on. Mirrors the
// isEarlyOSeries test in openAiRequestBody (llm/transports.js); keep the two in lockstep.
function modelCarriesSystemRole(model){
    return !/^o1-(mini|preview)/.test(String(model));
}

module.exports = {
    JUDGE_MAX_TOKENS,
    JUDGE_MAX_TOKENS_REASONING,
    FETCH_REASONING_TOKEN_HEADROOM,
    isReasoningModel,
    anthropicRejectsSampling,
    modelCarriesSystemRole
};
