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
 * XChain Hub - Oracle Round Lifecycle
 *
 * Bring-up and tear-down of the round loop: the gossip subscription, the
 * consensus event wiring, the durable rehydrate of the freshness counters, and
 * the shutdown sweep that records every round left in flight.
 *
 ********************************************************************/

const { noteRoundLost } = require('../../consensus/diagnostics');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Start the oracle round system
    async start() {
        // Idempotent: a second start() without an intervening stop() would install
        // a duplicate round loop (and leak the first). If any scheduling timer is
        // already live, this instance is running; do nothing.
        if (this.initialRoundTimer || this.boundaryTimer || this.roundTimer) {
            return;
        }

        // Rehydrate freshness counters from the durable record before the timer
        // begins, so a restart reflects the real feed state instead of a clean slate.
        await this.hydrateFreshnessCounters();

        // Subscribe to gossip messages
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);

        // Reset the stall gauges only when a round actually finalizes (reaches
        // commit quorum), not merely when this hub broadcast its own submission.
        // During a consensus/quorum stall the local price fetch keeps succeeding, so
        // stamping freshness on submission would hide the stall from the dashboard's
        // early-stall gauge. Finalization is the real success signal, and it matches
        // the semantic hydrateFreshnessCounters rebuilds from the durable record.
        if (this.oracleConsensus && typeof this.oracleConsensus.on === 'function') {
            this._finalizedHandler = () => this.markRoundFinalized();
            this.oracleConsensus.on('round:finalized', this._finalizedHandler);
            // Symmetric wiring for the increment: the streak advances on the same
            // durable event the reset does, so the live gauge and the hydrated value
            // share one semantic (item 4942).
            this._skippedHandler = () => this.noteRoundSkipped();
            this.oracleConsensus.on('round:skipped', this._skippedHandler);
        }

        // Start the round timer; it handles both the first run and the aligned cadence
        this.startRoundTimer();

        logger.info('Oracle round system started (interval: ' + (this.roundInterval / 1000) + 's, window: ' + (this.submissionWindow / 1000) + 's)');
    },

    // Rehydrate consecutiveSkippedRounds and lastSuccessfulRoundTime from
    // price_snapshots so they survive a restart. The constructor initialises both
    // to a clean-slate value (0 / null); without this step a hub that restarts
    // mid-outage would present zero skipped rounds and no last-success time even
    // though the durable record shows otherwise, masking the gap from /health and
    // the diagnostics RPC. price_snapshots is durable, so this is purely an
    // observability rehydrate, never a recompute of price data.
    async hydrateFreshnessCounters() {
        try {
            // (a) Most recent finalized round and its wall-clock time. created_at is
            // a TIMESTAMP; convert to epoch ms to match the live value, which is set
            // from Date.now() on each successful round.
            let lastRows = await this.db.getPriceSnapshotByStatus();

            let lastFinalizedRound = -1;
            if (lastRows && lastRows.length) {
                lastFinalizedRound           = Number(lastRows[0].round_number);
                this.lastSuccessfulRoundTime = Number(lastRows[0].ms);
            }

            // (b) Distinct rounds recorded after the last finalized round that did
            // NOT finalize: the consecutive trailing skip streak. With no finalized
            // round at all (lastFinalizedRound = -1) this counts every recorded
            // non-finalized round.
            let skipRows = await this.db.getPriceSnapshotsCountUnfinalizedAfterRound(lastFinalizedRound);
            this.consecutiveSkippedRounds = (skipRows && skipRows.length) ? Number(skipRows[0].skipped) : 0;
        } catch (err) {
            // Non-fatal: a hydration failure must not block oracle startup. Leave the
            // constructor defaults (0 / null) in place and continue.
            logger.warn(nodeUtil.format('Oracle: failed to hydrate freshness counters on start:', err));
        }
    },

    // Stop the oracle round system
    async stop() {
        if (this._messageHandler) {
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        if (this._finalizedHandler && this.oracleConsensus && typeof this.oracleConsensus.removeListener === 'function') {
            this.oracleConsensus.removeListener('round:finalized', this._finalizedHandler);
            this._finalizedHandler = null;
        }
        if (this._skippedHandler && this.oracleConsensus && typeof this.oracleConsensus.removeListener === 'function') {
            this.oracleConsensus.removeListener('round:skipped', this._skippedHandler);
            this._skippedHandler = null;
        }
        if (this.initialRoundTimer) {
            clearTimeout(this.initialRoundTimer);
            this.initialRoundTimer = null;
        }
        if (this.boundaryTimer) {
            clearTimeout(this.boundaryTimer);
            this.boundaryTimer = null;
        }
        if (this.roundTimer) {
            clearInterval(this.roundTimer);
            this.roundTimer = null;
        }
        // An armed finalization timer is a submitted round nothing rehydrates after a
        // restart (the round number is wall-clock derived, so a restarted hub resumes
        // at the current one): record each and write its upgradable skipped row.
        let inFlight = [...this.finalizationTimers.keys()];
        for (let t of this.finalizationTimers.values()) clearTimeout(t);
        this.finalizationTimers.clear();
        if (inFlight.length) {
            let btcBlockHeight = this.currentBtcBlockHeight;
            let btcBlockTime   = this.currentBtcBlockTime;
            await Promise.allSettled(inFlight.map(round => {
                noteRoundLost({ phase: 'shutdown', round, cause: 'stopped_before_finalization' });
                logger.warn('Oracle: stopping with round ' + round + ' submitted but not finalized; recording it as skipped');
                if (!this.oracleConsensus || typeof this.oracleConsensus.storeSkippedRound !== 'function') return null;
                return this.oracleConsensus.storeSkippedRound(round, btcBlockHeight, btcBlockTime,
                    'hub stopped before finalization').catch(err =>
                    logger.error(nodeUtil.format('Oracle: Failed to store skipped round ' + round + ' at stop:',
                        err && err.message ? err.message : err)));
            }));
        }
    }

};
