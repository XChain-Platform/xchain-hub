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
 * XChain Hub - Oracle Publisher: start, stop and the finalized-round seam
 *
 * Bringing the publisher up in the order a restart needs (buffer, then markers,
 * then the rails), releasing every timer it owns, and the one event the oracle
 * consensus rail hands it.
 *
 ********************************************************************/

'use strict';

const { worstCaseSnapshotAgeMs } = require('../price_batch_cadence.js');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Initialize the publisher: ensure queue directory exists, load any pending rounds
    async start() {
        this._stopped = false;
        // The per-window spend ceilings were memory-only, so every restart
        // restored a full allowance. Reload the saved window before anything publishes.
        this.spendGuard.persistTo();
        // Ensure the queue directory and file exist (publisher.js, where `fs` lives).
        this.ensureQueueFile();

        // Reload the v2 round buffer. A restart between a round finalizing and its
        // window closing must not lose the round: it is the sole hub-side copy of an
        // hour of price data that has not reached a chain yet.
        this.hydrateBuffer();

        // ...and re-register the window those rounds belong to, because the grace timers
        // themselves did not survive the restart.
        this.rearmBufferedWindows();

        // Hydrate the durable at-most-once guard before subscribing to new rounds:
        // load confirmed rounds into the in-process guard and quarantine any
        // intent-only rounds so a restart can never re-broadcast an already-published
        // (or ambiguously-published) round. Best-effort; a DB error is logged inside.
        if (this.db) {
            try {
                await this.hydratePublishedMarkers();
            } catch (e) {
                logger.error(nodeUtil.format('OraclePublisher: failed to hydrate durable publish markers on startup ' +
                    '(the in-process guard still covers this lifetime): ', e));
            }
        }

        this.armPublishRails();

        logger.info('OraclePublisher started (queue: ' + this.queuePath + ', address: ' + (this.dogeAddress || '<unset>') + ')');
        this.logBatchCadence();
    },

    // The event subscription and the three timers a running publisher owns. Armed
    // after the durable state is hydrated, so nothing fires against a half-loaded
    // buffer or an unread marker table.
    armPublishRails() {
        // Subscribe to oracle finalization events
        if (this.hub.oracleConsensus) {
            this.hub.oracleConsensus.on('round:finalized', (event) => {
                this.onRoundFinalized(event).catch(err => {
                    logger.error(nodeUtil.format('OraclePublisher: onRoundFinalized error:', err));
                });
            });
        }

        // Catch-up for windows that closed while this hub was down. Every buffered
        // window except the newest is closed by definition (a higher round exists), and
        // the newest joins them when the buffer holds its last slot, so one
        // delayed sweep re-arms exactly what the restart dropped. Delayed by the
        // grace so a hub restarting mid-window still gives its peers time to come up
        // before it proposes a batch they cannot yet co-sign.
        //
        // Bounded, rather than queuing every closed window at once. A hub coming
        // back to a long backlog therefore drains it over several sweeps rather than in
        // one pass; that is the trade the bound buys, and it is the right way round,
        // because assemblies are serialized and a failing one holds the chain for a
        // whole sign timeout, so the unbounded form put the LIVE window behind every
        // stale one.
        this._scheduleBufferCatchup();

        // ...and the recurring pass, because a window that fails its signing round is
        // left un-memoized precisely so it can be re-proposed, and until now nothing
        // ever did.
        this.startBufferCatchupSweep();

        // Watch broadcasts through to a block. Without it a wire that never mines
        // leaves the rail reporting a healthy lastPublishedTxid indefinitely.
        this.startConfirmationWatchdog();
    },

    // The publish cadence next to the bound it has to fit inside, because a rail
    // that is publishing perfectly on a cadence too slow for the fee gate looks
    // healthy in every other line this class logs.
    logBatchCadence() {
        let peakMs = worstCaseSnapshotAgeMs(this.batchWindowRounds, {
            roundIntervalMs:  this.roundIntervalMs,
            graceMs:          this.batchGraceMs,
            landingReserveMs: this.batchLandingReserveMs });
        logger.info('OraclePublisher PRICE batch cadence: ' + this.batchWindowRounds +
            ' round(s)/batch = one wire per ' +
            Math.round((this.batchWindowRounds * this.roundIntervalMs) / 1000) + 's' +
            (this.batchWindowRoundsCeiling === null
                ? ' (no staleness bound resolved; window not capped)'
                : ', ceiling ' + this.batchWindowRoundsCeiling + '; newest snapshot peaks at ' +
                  (peakMs === null ? '?' : Math.round(peakMs / 1000)) + 's against a ' +
                  Math.round(this.oracleMaxPriceAgeMs / 1000) + 's fee-price staleness bound'));
    },

    // Release every timer this class owns, plus a batch signer it created itself.
    // The class had no stop() before the batch rail, because it had no timers.
    stop() {
        this._stopped = true;
        for (let state of this._windows.values()) {
            if (state.timer) clearTimeout(state.timer);
        }
        this._windows.clear();
        for (let timer of this._takeoverTimers.values()) clearTimeout(timer);
        this._takeoverTimers.clear();
        if (this._catchupTimer) { clearTimeout(this._catchupTimer); this._catchupTimer = null; }
        if (this._catchupSweepTimer) { clearTimeout(this._catchupSweepTimer); this._catchupSweepTimer = null; }
        if (this._confirmTimer) { clearInterval(this._confirmTimer); this._confirmTimer = null; }
        if (this._ownedBatchSigner) {
            try { this._ownedBatchSigner.stop(); } catch (e) { /* stopping is best-effort */ }
            this._ownedBatchSigner = null;
        }
    },

    // Called when a round is finalized. Enqueue if this node is the leader.
    async onRoundFinalized(event) {
        // item 2677 kill switch: when disabled, do not enqueue or broadcast.
        // Skip rather than queue-for-later so a disabled publisher does not silently
        // build a backlog that floods on-chain the moment it is re-enabled.
        if (!this.enabled) {
            logger.info('OraclePublisher: disabled (ORACLE_PUBLISH_ENABLED=false); skipping round ' + event.round);
            return;
        }
        // PRICE v0 BATCH RAIL, unconditional. A finalized round never rides its own
        // transaction: it goes into the buffer and leaves as part of a signed batch. There
        // is no activation gate and no v0 fallback rail here, so this hub cannot be one
        // stamp away from emitting a wire its peers index differently.
        //
        // No leader check here, deliberately: EVERY hub buffers EVERY round it finalizes,
        // because window leadership is decided at the window's anchor and that anchor is
        // not known when the window's first round finalizes. Leader election, the durable
        // queue and the broadcast happen at window assembly (_assembleWindow).
        await this.bufferFinalizedRound(event);
        this.noteWindowRound(event.round);
    },

};
