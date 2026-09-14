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
 * XChain Hub - llm provider: the gates on a winning proposal's `meta`
 *
 * A judge vouches for the BODY it picked, never for the model identifier the
 * proposal claims served it. These two fail-closed gates decide whether that
 * identifier may be canonicalized on-chain.
 *
 ********************************************************************/

const { markInconclusive } = require('./judge');

// canonicalizable `meta`
//
// `meta` is the model identifier that served a response. It is CONSENSUS-VISIBLE:
// the canonical signature binds it and the ATTEST v1 wire records it on-chain
// (see the header of providers/llm.js). But `proposals` arrive from other validators, and the
// judge only ever evaluates their BODIES (`candidates` in agreeJudged is built from
// p.body). Nothing looked at `meta`, so whichever proposal the judge happened to
// pick had its meta copied verbatim onto the chain: a Byzantine validator could
// put arbitrary bytes there and have the federation sign them, without ever
// having to win on content.
//
// Two independent gates, both fail-closed, mirroring the `truncated_pick`
// precedent already in agreeJudged (refuse to finalize what was not evaluated,
// rather than finalize it and hope):
//
//   1. ALLOWLIST. The value must be exactly one of the block-anchored approved
//      identifiers. Not a prefix, not a case-insensitive match, not "looks like a
//      model name": an exact member of the same set the request was pinned from.
//   2. CORROBORATION. With more than one proposal in play, at least two must
//      report the identical meta. A meta only its own author vouches for is not
//      evidence of anything, and it is precisely the shape a fabricated value
//      takes. Honest divergence (a validator that legitimately fell back to
//      another model and whose body the judge then picked) also lands here, and
//      failing closed is the right answer for that too: the round is
//      inconclusive rather than recording a claim the federation cannot support.
const META_MIN_CORROBORATION = 2;

class MetaGates {
    // `settings` is the provider instance's LlmSettings, read live on every call.
    constructor({ logger, settings }) {
        this.logger   = logger;
        this.settings = settings;
    }

    // The approved identifiers. Judge fallbacks are deliberately NOT unioned in:
    // a proposal's meta is only ever the FETCH model (fetch() returns `meta: model`,
    // pinned off the block-anchored approved_models ladder), while the judge chain
    // picks who EVALUATES bodies and never serves a fetch. Admitting a judge-fallback
    // id would widen the allowlist by values no honest proposal can carry, which is
    // exactly what gate 1 exists to refuse.
    //
    // Prefer options.pinnedApprovedModels, the SAME block-anchored
    // approved_models list AttestationRound resolved at the request's block to pin
    // the fetch model. Reading the live module-global instead left gate 1 unanchored
    // while the value it judges is anchored: a governance hotReload that DELISTS the
    // pinned model makes every honestly-served meta unrecognized, so the round maps
    // to no_quorum, and because each retry re-resolves the same block-anchored model
    // the request can never finalize and expires despite successful provider calls.
    // Same anchoring rationale as pinnedModel/pinnedJudgeModel/pinnedVendors; the
    // live set remains the fallback for callers that pin nothing (the test seam and
    // any non-round caller).
    approvedMetaSet(options){
        const pinned = options && options.pinnedApprovedModels;
        const source = (Array.isArray(pinned) && pinned.length > 0) ? pinned : this.settings.APPROVED_MODELS;
        return new Set(source.filter(m => typeof m === 'string' && m));
    }

    // Validate the winning proposal's meta. Returns the value to canonicalize, or
    // null with `options.outcome` marked inconclusive.
    canonicalMeta(proposals, idx, options){
        const raw = proposals[idx] ? proposals[idx].meta : undefined;
        // Deliberately strict about type: a non-string meta (object, Buffer, number)
        // is not something this allowlist can reason about, so it is unrecognized.
        if (typeof raw !== 'string' || raw === ''){
            this.logger.warn('llm: winning proposal carries a non-string/empty meta; failing closed');
            markInconclusive(options, 'meta_unrecognized');
            return null;
        }
        if (!this.approvedMetaSet(options).has(raw)){
            this.logger.warn('llm: winning proposal meta "' + raw + '" is not an approved model identifier; ' +
                'failing closed rather than canonicalizing an unvouched value on-chain');
            markInconclusive(options, 'meta_unrecognized');
            return null;
        }
        if (proposals.length > 1){
            let agreeing = proposals.filter(p => typeof p.meta === 'string' && p.meta === raw).length;
            if (agreeing < META_MIN_CORROBORATION){
                this.logger.warn('llm: winning proposal meta "' + raw + '" is corroborated by only ' + agreeing +
                    ' of ' + proposals.length + ' proposals; failing closed');
                markInconclusive(options, 'meta_uncorroborated');
                return null;
            }
        }
        return raw;
    }

    // Test seam for the canonicalizable-meta gate. The corroboration half only runs on the
    // judge-winner return, which needs a live judge transport to reach, so the suite
    // exercises the same function directly rather than mocking a vendor.
    // `pinnedApprovedModels` is the round's block-anchored allowlist;
    // omit it to exercise the live-module-global fallback the seam has always used.
    canonicalMetaForTest(proposals, idx, outcome, pinnedApprovedModels) {
        return this.canonicalMeta(proposals, idx, {
            outcome: outcome || {},
            pinnedApprovedModels: pinnedApprovedModels || null
        });
    }
}

module.exports = MetaGates;
