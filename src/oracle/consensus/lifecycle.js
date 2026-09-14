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
 * XChain Hub - Oracle Consensus: start, stop and round outcomes
 *
 * Bringing the engine up and down: the validator set, the clamp-reference seed and its
 * reseed timer, the gossip subscription, and the two markers that record a round as
 * finalized or as locally skipped.
 *
 ********************************************************************/

'use strict';

const { canonicalValidatorOrder } = require('../../rollcall/validator_order.js');
const { positiveIntConfig } = require('../../lib/config_int.js');
const { noteRoundLost } = require('../../consensus/diagnostics');
const hubConfig = require('../../config');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Canonicalize the set's ORDER on the way in, so _getLeader's
    // legacy live-set path (`validatorSet[round % N]`, taken whenever a round
    // has no usable block-locked snapshot) elects the same leader on every hub
    // for identical membership. The snapshot path was already fixed by
    // sorting the member pubkeys; this closes the same hole on the fallback.
    // See validator_order.js.
    setValidatorSet(validators) {
        this.validatorSet = canonicalValidatorOrder(validators);
    },

    async start() {
        // Seed the in-memory last-finalized-price cache from price_snapshots so a
        // cold-started hub applies the same historical-deviation co-sign band a
        // warm hub does (seq 4382). Without this, getLastFinalizedPrice returns
        // null on every pair until the hub itself stores a round, so a freshly
        // restarted hub would co-sign a Byzantine price for any pair it does not
        // locally submit that a long-running hub would withhold on. Local accept-
        // gate only: no signed bytes change, no reindex.
        await this.seedLastFinalizedPrices();

        // Re-run the seed on a timer so the clamp reference tracks the DATABASE, not
        // this process's own finalize history (item 5834). The cache had exactly two
        // writers, the start-time seed and _storeSnapshot, so every round this hub sat
        // out (co-sign reject before pendingRounds.set, commit-quorum timeout eviction,
        // a below-minSubmissions skip) left it clamping against an ever-older reference
        // while its peers moved on. The seed is idempotent, fail-soft and monotonic, so
        // re-running it can only carry the reference FORWARD to rows this hub already
        // holds. It bounds the staleness window rather than closing it: a round-aligned
        // re-read on the consensus path is a separate, deliberate change.
        // Cadence only, NOT a federation-uniform value: it decides how promptly a hub
        // catches up to rows it already holds, never what any hub clamps to. A longer
        // interval degrades toward the pre-fix staleness, a shorter one costs one
        // indexed query. So it needs no flag day and no regtest-only gate.
        this._reseedIntervalMs = positiveIntConfig(hubConfig.ORACLE_CLAMP_RESEED_MS, 60000,
            'ORACLE_CLAMP_RESEED_MS');
        this._reseedTimer = setInterval(() => {
            // In-flight guard, the convention XChainHub.refreshTransportSignerSet uses:
            // the query is an unbounded round trip and a bare setInterval stacks passes.
            if (this._reseedRunning) return;
            this._reseedRunning = true;
            this.seedLastFinalizedPrices({ quiet: true })
                .catch(() => { /* seedLastFinalizedPrices never rejects; belt and braces */ })
                .then(() => { this._reseedRunning = false; });
        }, this._reseedIntervalMs);
        if (this._reseedTimer.unref) this._reseedTimer.unref();

        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);
        logger.info('Oracle consensus engine started');
    },

    // Populate _lastFinalizedPrices with the most-recently-finalized price per
    // coin_pair from price_snapshots. Mirrors the cache keying in
    // updateLastFinalizedPrices (key = coin_pair, value = price string) and the
    // "latest finalized = highest round_number" ordering used by hub.getPrice().
    // Fail-soft: an empty table or a query error leaves the cache empty (the prior
    // cold-start behavior), so this can never block hub startup.
    async seedLastFinalizedPrices(opts) {
        if (!this._lastFinalizedPrices) this._lastFinalizedPrices = new Map();
        try {
            // One row per coin_pair: the price from that pair's highest finalized
            // round. The subquery picks the max finalized round per pair, then the
            // join reads that round's price for the pair. round_number rides along so
            // the entry can be stamped and the merge below can stay monotonic.
            let rows = await this.db.findLatestPriceSnapshotPerPair();
            let seeded = 0;
            for (let r of (rows || [])) {
                if (r.coin_pair && r.price !== null && r.price !== undefined) {
                    // Merge, never replace the map: a truncated or partial read must not
                    // drop a pair's reference, since an absent reference means NO clamp
                    // at all and an unbounded aggregate is worse than a stale bound.
                    if (this.noteFinalizedPrice(r.coin_pair, r.price, r.round_number)) seeded++;
                }
            }
            if (seeded > 0 && !(opts && opts.quiet))
                logger.info('Oracle: seeded last-finalized-price cache with ' + seeded + ' pair(s) from price_snapshots');
        } catch (e) {
            logger.warn(nodeUtil.format('Oracle: could not seed last-finalized-price cache (continuing with empty cache):',
                e && e.message ? e.message : e));
        }
    },

    async stop() {
        if (this._reseedTimer) {
            clearInterval(this._reseedTimer);
            this._reseedTimer = null;
        }
        if (this._messageHandler) {
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        for (let [round, pending] of this.pendingRounds) {
            if (pending.timer) clearTimeout(pending.timer);
        }
        for (let [, t] of this.leaderTimers) clearTimeout(t);
        this.leaderTimers.clear();
        // An armed watchdog is an open round with no outcome, and nothing re-arms it
        // after a restart: record each one and write its skipped row best-effort
        // (upgradable, so a federation that finalizes without this hub still wins).
        let inFlight = [];
        for (let [round, w] of this.roundWatchdogs) {
            if (w && w.timer) clearTimeout(w.timer);
            if (this.finalized.has(round) || this.locallySkipped.has(round)) continue;
            inFlight.push([round, w]);
        }
        this.roundWatchdogs.clear();
        for (let [round, w] of inFlight) {
            noteRoundLost({
                phase: 'shutdown', round, cause: 'stopped_with_round_in_flight',
                seat: (w && w.seat) || 'unknown', ...((w && w.seatInfo) || {}),
                pending: this.pendingRounds.has(round)
            });
            logger.warn('Oracle: stopping with round ' + round + ' open and unfinalized; recording it as skipped');
        }
        if (inFlight.length) {
            await Promise.allSettled(inFlight.map(([round, w]) =>
                this.storeSkippedRound(round, w && w.btcBlockHeight, w && w.btcBlockTime,
                    'hub stopped with round in flight').catch(err =>
                    logger.error(nodeUtil.format('Oracle: Error storing in-flight round ' + round + ' at stop:',
                        err && err.message ? err.message : err)))));
        }
        this.pendingRounds.clear();
        this.roundReadyAt.clear();
        this.earlyMessages.clear();
        this.earlyMessageTtl.clear();
    },

    // Record a finalized round under the bounded FIFO ring (L1). Evicts the
    // oldest round once the window is full so `finalized` cannot grow unbounded
    // over the process lifetime.
    markFinalized(round) {
        // A round that genuinely finalizes supersedes any local skip marker for it
        // (the 'skipped' price_snapshots rows were upgraded to 'finalized' by
        // _storeSnapshot), so clear it from locallySkipped (stress-sweep #7).
        if (this.locallySkipped.delete(round)) {
            let i = this._locallySkippedOrder.indexOf(round);
            if (i !== -1) this._locallySkippedOrder.splice(i, 1);
        }
        if (this.finalized.has(round)) return;
        // The round reached a durable outcome, so the abandonment watchdog has
        // nothing left to record. Disarmed here as well as in
        // clearRoundTracking, because the single-node finalize path never calls
        // that.
        this.disarmRoundWatchdog(round);
        this.finalized.add(round);
        this._finalizedOrder.push(round);
        if (this._finalizedOrder.length > this.finalizedMax) {
            let oldest = this._finalizedOrder.shift();
            this.finalized.delete(oldest);
        }
    },

    // Record a round this hub stored as 'skipped' for a local reason (stress-sweep
    // #7). Unlike markFinalized this does NOT block a later federation PROPOSE from
    // processing; it only prevents this hub from re-skipping the same round and lets
    // getSubmissionsInfo/health distinguish a local skip from a true finalize.
    // Bounded by the same insertion-order ring as `finalized`.
    markLocallySkipped(round) {
        if (this.finalized.has(round) || this.locallySkipped.has(round)) return;
        this.locallySkipped.add(round);
        this._locallySkippedOrder.push(round);
        if (this._locallySkippedOrder.length > this.finalizedMax) {
            let oldest = this._locallySkippedOrder.shift();
            this.locallySkipped.delete(oldest);
        }
        // Announce the durable skip, mirroring 'round:finalized'. This is the only
        // place a round becomes a non-finalized row in price_snapshots, and the guard
        // above makes it exactly-once per round, so it is the event that carries the
        // same semantic hydrateFreshnessCounters rebuilds from the durable record
        // (item 4942). Emitted after the state change so a listener observing back
        // through getSubmissionsInfo sees the round already marked.
        this.emit('round:skipped', { round: round });
    }
};
