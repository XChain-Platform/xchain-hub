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
 * XChain Hub - DEX Follower Verification
 *
 * The independent confirmation a peer runs before signing a leader's proposed match: the
 * bounds on its leader-choice fields, and the whole match re-derived from this hub's own
 * order books and its own reservation ledger.
 *
 ********************************************************************/

const { RELAY_MIN_FUTURE_S } = require('../../lib/relay_margin.js');
const { allCanonicalInts } = require('../../lib/canonical_int.js');
const { DEX_CANONICAL_INT_FIELDS } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
    // Independent confirmation a peer runs before signing a leader's proposed match:
    // re-fetch both chains' open cross-chain orders, confirm each leg is still open +
    // escrowed + at least minConfirmations deep, and that the pair re-derives to the
    // SAME match_id and canonical. Returns true only when our own view confirms the
    // match. A Byzantine leader cannot get us to sign a match we can't independently see.
    async validateProposedMatch(row){
        if(!this.proposedMatchInBounds(row)) return false;
        let a = await this.findOpenOffer(row.a_chain, Number(row.a_action_index));
        let b = await this.findOpenOffer(row.b_chain, Number(row.b_action_index));
        if(!a || !b) return false;
        if((a.home_network || '') !== String(row.network || '')) return false;
        if((b.home_network || '') !== String(row.network || '')) return false;
        // Re-derive the WHOLE match (kind, fill amounts, filled-before offsets, match_id)
        // independently from our own view: offers + our committed ledger. The proposer's
        // a/b are canonical (a_chain <= b_chain), so tryMatch(a, b) keeps lo=a, hi=b.
        let desc = this.tryMatch(a, b);
        if(!desc) return false;
        if(desc.loKind !== row.a_kind || desc.hiKind !== row.b_kind) return false;
        if(!this.amountsEqual(desc.loFill, row.a_amount) || !this.amountsEqual(desc.hiFill, row.b_amount)) return false;
        if(!this.amountsEqual(desc.loFilledBefore, row.a_filled_before) ||
           !this.amountsEqual(desc.hiFilledBefore, row.b_filled_before)) return false;
        // Royalty legs must match OUR OWN indexer's view of each order. The canonical is
        // built from the proposed row, so without this check a Byzantine leader could
        // strip or rewrite the legs and still collect honest signatures; the source
        // indexer stores the legs as one JSON string, so both views compare byte-equal.
        if(String(row.a_payout_legs || '') !== String(desc.lo.payout_legs || '')) return false;
        if(String(row.b_payout_legs || '') !== String(desc.hi.payout_legs || '')) return false;
        // Per-leg source-reorg fence (item 5308): a_push_generation / b_push_generation are
        // NOT part of the signed canonical or the match_id, so a Byzantine leader can stamp an
        // inflated generation that no honest post-reorg retraction (which fences on
        // <leg>_push_generation <= retraction_generation) can ever match, permanently pinning a
        // match on a rolled-back source order = a cross-chain double-spend. Re-derive each leg's
        // generation from OUR OWN open-order view and refuse a row whose fence disagrees. Honest
        // hubs read the same per-coin generation, so a synced federation never rejects; a follower
        // whose indexer briefly lags just defers signing until it catches up (same tolerance as
        // the effective_time bound above).
        if((Number(row.a_push_generation) || 0) !== (Number(desc.lo.push_generation) || 0)) return false;
        if((Number(row.b_push_generation) || 0) !== (Number(desc.hi.push_generation) || 0)) return false;
        let derivedId = this.deriveMatchId(desc.lo, desc.hi, Number(row.snapshot_block), desc.loFilledBefore, desc.hiFilledBefore);
        if(String(derivedId).toLowerCase() !== String(row.match_id).toLowerCase()) return false;
        return true;
    },

    // The gates a proposed match clears before any indexer read: a rebuilt reservation
    // ledger, two distinct chains, canonical integer spellings and the effective_time window.
    proposedMatchInBounds(row){
        // Reservation-ledger gate. The follower check below is NOT independent of the
        // leader's: it re-derives filled_before from this same this.committed, so a hub
        // whose ledger failed to rebuild would co-sign exactly the over-fill it would
        // have proposed. Refuse to sign rather than sign blind.
        if(!this._committedReady){
            logger.warn('CrossChainDex: refusing to co-sign a proposed match; the reservation ledger has not rebuilt');
            return false;
        }
        if(!row || row.a_chain === row.b_chain) return false;
        // Canonical integer spellings. These fields are signed verbatim but the
        // indexer's settlement pass rebuilds the canonical from the mirrored BIGINT row,
        // so a leader-supplied '041' for an action index passes every Number()-based
        // re-derivation below yet finalizes a match whose signatures no settling indexer
        // can reproduce - both escrows locked with no path to retry. Fail closed first;
        // an honest leader builds these with Number(), so an honest round never sees it.
        if(!allCanonicalInts(row, DEX_CANONICAL_INT_FIELDS)) return false;
        // Leader-chosen effective_time is ADOPTED (it is not part of the match_id, so a
        // follower cannot re-derive it) and signed into the canonical. Bound it to a sane
        // window of our own clock, exactly as CrossChainCallEngine.validateProposedMatch
        // does for relay rows. The window is ASYMMETRIC. Its upper half stops a Byzantine
        // leader stamping a far-future effective_time and finalizing a match whose indexer
        // settlement (applied at effective_time <= block_time) never fires, locking BOTH
        // matched escrows indefinitely (a griefing / liveness attack). Its lower half is
        // the propagation floor (#4202): a match effective at or behind our clock is
        // eligible the instant it finalizes, so the indexer that already holds the
        // mirrored row settles a block ahead of one still receiving it and the two legs'
        // settlement action indexes diverge. Honest leaders now stamp a forward margin
        // sized to the slower leg, comfortably above RELAY_MIN_FUTURE_S, so neither half
        // rejects an honest proposal (same clock-skew tolerance as the call relay).
        let now = this._nowSeconds();
        if(!Number.isFinite(Number(row.effective_time)) ||
           Number(row.effective_time) - now > 3600 ||
           Number(row.effective_time) - now < RELAY_MIN_FUTURE_S) return false;
        return true;
    },
};
