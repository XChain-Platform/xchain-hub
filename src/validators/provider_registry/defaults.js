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
 * XChain Hub - Attestation provider defaults
 *
 * The built-in provider definitions a freshly deployed hub serves, and the
 * canonicalisers that turn a governance payload into the exact strings every hub
 * must agree on. src/validators/provider_registry.js re-exports DEFAULTS,
 * parseAttestationProviderParam and normalizeMinStakeXchain under those names.
 *
 ********************************************************************/

const DEFAULTS = {
    http_get: {
        provider_id:            'http_get',
        version:                1,
        consensus_strategy:     'byte_equality',
        max_request_bytes:      2048,
        max_response_bytes:     32768,
        allowed_redundancy:     [1, 3, 5],
        min_stake_xchain:       '10000',
        per_call_base_fee_xchain: '0.01',
        // Hub-local request-fee floor (E1): requests whose on-chain FEE_AMOUNT
        // is below this are skipped by AttestationRound (they expire + refund).
        // '0' = serve everything, including feeless requests. Governance-synced
        // like every other field in this definition.
        min_fee_xchain:         '0',
        deadline_window_blocks: 100,
        additional_config:      {}
    },
    llm: {
        provider_id:            'llm',
        version:                1,
        consensus_strategy:     'judge_model',
        max_request_bytes:      8192,
        max_response_bytes:     16384,
        allowed_redundancy:     [1, 3, 5],
        min_stake_xchain:       '25000',
        per_call_base_fee_xchain: '0.50',
        min_fee_xchain:         '0',
        deadline_window_blocks: 20,
        additional_config: {
            // ORDERED fallback chain: index 0 is the primary; later entries
            // serve when the block-height escalation ladder advances (see
            // attestation_escalation.js). Single-vendor by default; adding a
            // second vendor's model here is a GOVERNANCE action (with an
            // activation block) so mixed-version fleets never diverge on the
            // pinned fetch model.
            approved_models: [
                'claude-sonnet-4-6',
                'claude-opus-4-7'
            ],
            judge_model:                 'claude-haiku-4-5',
            // Leader-local judge alternates for vendor outages (providers/llm.js).
            // Empty by default; governance populates alongside approved_models.
            judge_fallback_models:       [],
            // Explicit model-id → vendor overrides for ids the provider's
            // prefix inference can't classify.
            model_vendors:               {},
            // When true, the llm self-test fails unless credentials resolve for
            // every vendor on the chains above (validators skip llm rounds and
            // accrue missed_count until they provision fallback keys).
            require_all_vendors:         false,
            // No judge_equivalence_threshold here: the judge verdict is a strict
            // boolean (`judgement.equivalent === true` plus a canonical_index in
            // providers/llm.js agree()), never a similarity score, so a numeric
            // threshold has nothing to tune. Shipping one told operators the
            // governance proposal knob did something it never did. The unknown-key
            // warning in llm.js _setConfig catches it when an already-passed
            // proposal replays the key that deletion here cannot reach.
            max_completion_tokens:       1024,
            default_temperature:         0,
            prompt_envelope_version:     1
        }
    }
};

// Parse a governance parameter name of the form ATTESTATION_PROVIDER:<provider_id>
// into the provider_id, or null if it is not a provider-config parameter. Mirrors
// the configs-table key structure (module='ATTESTATION_PROVIDER', param_name=id) and
// parallels parseCapabilityMinStakeParam; used for the block-anchored config history.
function parseAttestationProviderParam(parameter) {
    let m = /^ATTESTATION_PROVIDER:(.+)$/.exec(String(parameter || ''));
    if (!m) return null;
    return m[1];
}

// Canonicalise a provider min_stake_xchain value to a plain decimal string, or null
// when it is absent/unparseable. Deterministic by construction (a regex, not
// Number()) so every hub in the federation derives the identical string from the
// identical governance payload: this value lands in a block-anchored history whose
// whole purpose is cross-hub agreement, and a float round-trip would reintroduce
// the divergence the anchoring removes. An unparseable value resolves to null,
// which a consensus caller must treat as "no floor configured" and fail closed on
// rather than silently substituting 0.
function normalizeMinStakeXchain(value) {
    if (value === null || value === undefined) return null;
    let s = String(value).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    return s;
}

// Canonicalise a provider consensus_strategy to a plain string, or null when it is
// absent/blank. Deliberately NOT an allowlist of the strategies this build knows:
// an unrecognised name must travel into the history verbatim so a hub running older
// code resolves the same UNKNOWN value every peer does and declines the round,
// rather than silently walking back to an older strategy and running a different
// PBFT state machine from the rest of the federation for the same block.
function normalizeConsensusStrategy(value) {
    if (value === null || value === undefined) return null;
    let s = String(value).trim();
    return s === '' ? null : s;
}

module.exports = {
    DEFAULTS,
    parseAttestationProviderParam,
    normalizeMinStakeXchain,
    normalizeConsensusStrategy
};
