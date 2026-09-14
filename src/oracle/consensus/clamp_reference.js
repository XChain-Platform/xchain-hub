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
 * XChain Hub - Oracle Consensus: the last-finalized price cache
 *
 * The reference the aggregation clamp and the co-sign gate measure a price against:
 * the per-pair cache, its round stamps, the round-aligned refresh, and the writers that
 * carry it forward from a stored round or from the mirror ingest stream.
 *
 ********************************************************************/

'use strict';

module.exports = {

    // Return the most recently finalized price for a coin pair from price_snapshots,
    // or null if unavailable. Used by the co-sign gate to apply a historical-deviation
    // check for pairs this hub has no live local submission for (seq 4083).
    // Synchronous best-effort: reads from the in-memory cache populated by
    // _storeSnapshot. Falls back to null when not cached (first round, cold start).
    getLastFinalizedPrice(coinPair) {
        if (!this._lastFinalizedPrices) return null;
        return this._lastFinalizedPrices.get(coinPair) || null;
    },

    // The round each cached reference came from, parallel to _lastFinalizedPrices
    // (Map<coin_pair, round>). Kept as a second map rather than boxing the value so
    // every existing reader of _lastFinalizedPrices still sees a plain price string.
    // Absent for an entry written without a round (see noteFinalizedPrice).
    lastFinalizedRoundFor(coinPair) {
        if (!this._lastFinalizedRounds) return null;
        let r = this._lastFinalizedRounds.get(coinPair);
        return Number.isFinite(r) ? r : null;
    },

    // Highest round any cached reference came from, or null when nothing is
    // stamped. This is the cache's position, which is what "behind the round being
    // judged" is measured against.
    maxCachedFinalizedRound() {
        if (!this._lastFinalizedRounds || this._lastFinalizedRounds.size === 0) return null;
        let max = null;
        for (const r of this._lastFinalizedRounds.values()) {
            if (Number.isFinite(r) && (max === null || r > max)) max = r;
        }
        return max;
    },

    // Make the reference a function of the round, not of when this process booted:
    // the timed reseed bounds staleness per hub clock, so two hubs can judge one
    // PROPOSE against different rounds and co-sign differently.

    // Fail-soft and monotonic like the seed it delegates to: carries the reference
    // FORWARD only, never clears it, never throws on the consensus path.
    async _refreshLastFinalizedForRound(round) {
        if (!Number.isInteger(round)) return;
        if (this._lastFinalizedRefreshRound === round) return;
        this._lastFinalizedRefreshRound = round;

        // The reference for round N is round N-1; anything at or past that is current.
        const cached = this.maxCachedFinalizedRound();
        if (cached !== null && cached >= round - 1) return;

        await this.seedLastFinalizedPrices({ quiet: true });

        // Still behind after a read means this hub's own database never received the
        // previous round. Diagnostic only; nothing gates on it.
        const after = this.maxCachedFinalizedRound();
        if (after === null || after < round - 1) this._staleClampReference++;
    },

    // Record one pair's finalized price, newest round wins. Returns true when the
    // entry moved. The cache means "the price from this pair's HIGHEST finalized
    // round", which is what seedLastFinalizedPrices computes; before the stamp the
    // runtime writer disagreed with the seed, so a late _storeSnapshot for an older
    // round (a locally-skipped round stored by a late PROPOSE, a replayed COMMIT)
    // walked the reference BACKWARDS. An unstamped write is trusted as current, so
    // callers that have no round keep the prior set-always behaviour.
    noteFinalizedPrice(coinPair, price, round) {
        if (!coinPair || price === null || price === undefined || price === '') return false;
        if (!this._lastFinalizedPrices) this._lastFinalizedPrices = new Map();
        if (!this._lastFinalizedRounds) this._lastFinalizedRounds = new Map();
        let r = Number(round);
        let stamped = Number.isFinite(r);
        let known = this.lastFinalizedRoundFor(coinPair);
        if (stamped && known !== null && r < known) return false;
        this._lastFinalizedPrices.set(coinPair, String(price));
        if (stamped) this._lastFinalizedRounds.set(coinPair, r);
        return true;
    },

    // Update the in-memory last-finalized-price cache after a round is stored.
    // Called at the end of _storeSnapshot. `round` is optional: the unit tests that
    // drive this directly, and any future caller without one, keep the unstamped
    // set-always behaviour. Rounds arriving by push come in through
    // noteIngestedPriceRow instead.
    updateLastFinalizedPrices(prices, round) {
        if (!this._lastFinalizedPrices) this._lastFinalizedPrices = new Map();
        for (let p of prices) {
            if (p.coinPair && p.price) this.noteFinalizedPrice(p.coinPair, p.price, round);
        }
    },

    // The last-finalized reference `round`'s aggregate was clamped against, or null when
    // this hub did not store that round (so it holds no reference for it). Read by
    // SlashDetector to widen the deviation band on pairs the clamp actually moved.
    getClampReference(round) {
        if (!this._clampReference || this._clampReference.round !== round) return null;
        return this._clampReference.prices;
    },

    // Fold a finalized price_snapshots row from the hub's DB-mirror ingest stream into
    // the clamp reference. PriceAggregator.receiveValidatedRound writes finalized rows
    // for rounds pushed from a source chain and touched nothing else, so a hub that
    // ingests rather than finalizes never advanced its reference at all. Non-finalized,
    // priceless and older-round rows are ignored by the monotonic guard above.
    noteIngestedPriceRow(row) {
        if (!row || row.status !== 'finalized') return false;
        return this.noteFinalizedPrice(row.coin_pair, row.price, row.round_number);
    }
};
