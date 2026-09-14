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
 * XChain Hub - Oracle Consensus: the round-abandonment watchdog
 *
 * Every seat that watches a round open arms one, so a round that dies between opening
 * and finalizing still leaves a durable skipped record here rather than only on whichever
 * hub happened to take an early skip branch.
 *
 ********************************************************************/

'use strict';

const { FALLBACK_GRACE_MS } = require('./constants.js');
const { noteRoundLost } = require('../../consensus/diagnostics');
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// How many times the watchdog defers to a still-live pending round before writing
// the skipped record anyway. Each deferral is one more finalization window, so a
// round stuck behind the armFinalizeRetry DB-outage self-heal gets a bounded
// chance to land its snapshot first. Bounded, because the point of the watchdog is
// that SOMETHING durable is written: an unbounded deferral is the silence it exists
// to end (a later quorum still upgrades the skipped rows to finalized).
const ROUND_ABANDON_MAX_REARMS = 3;

module.exports = {

    // Record the first time we saw this round as ready to finalize. The
    // receiver-side leader-timeout grace in _handlePropose measures from here.
    // Opportunistically evicts entries for rounds that never finalized (the rare
    // stuck case) so the map can't grow unbounded.
    markRoundReady(round) {
        let now = Date.now();
        let ttl = this.finalizationTimeout * 2 + this.leaderTimeout;
        for (let [r, ts] of this.roundReadyAt) {
            if (now - ts > ttl) this.roundReadyAt.delete(r);
        }
        if (!this.roundReadyAt.has(round)) this.roundReadyAt.set(round, now);
    },

    // Forget per-round leader-timeout bookkeeping once the round is done.
    clearRoundTracking(round) {
        this.roundReadyAt.delete(round);
        let t = this.leaderTimers.get(round);
        if (t) {
            clearTimeout(t);
            this.leaderTimers.delete(round);
        }
        this.disarmRoundWatchdog(round);
    },

    // --- Round-abandonment watchdog ---

    // How long after a round opens here this hub waits before calling it lost.
    // Derived from the round's own timer ladder (leader timeout -> fallback grace
    // -> finalization window) plus slack, so it is always the LAST timer to fire
    // and never pre-empts a round that is still legitimately in flight.
    roundAbandonMs() {
        return this.leaderTimeout + FALLBACK_GRACE_MS + this.finalizationTimeout
             + this.roundAbandonGraceMs;
    },

    // Arm the watchdog for a round this hub has observed OPEN: it saw a usable
    // submission set at the block boundary, or a peer's PROPOSE opened the round
    // here. Idempotent per round, and a no-op once the round already has a durable
    // outcome (finalized, or a skipped row already stored).
    //
    // btcBlockHeight/btcBlockTime are the round's real BTC anchor, carried so the
    // skipped row this may eventually write names the SAME (round, reference_block,
    // block_timestamp) every other hub writes. Re-deriving them at fire time would
    // stamp each hub's rows with its own wall clock and make the per-round presence
    // digests differ for a round every hub actually agreed on.
    armRoundWatchdog(round, btcBlockHeight, btcBlockTime) {
        if (this.finalized.has(round) || this.locallySkipped.has(round)) return;
        if (this.roundWatchdogs.has(round)) return;
        let entry = {
            timer:          null,
            btcBlockHeight: btcBlockHeight,
            btcBlockTime:   btcBlockTime,
            rearms:         0
        };
        this.roundWatchdogs.set(round, entry);
        this.scheduleRoundWatchdog(round, entry, this.roundAbandonMs());
    },

    scheduleRoundWatchdog(round, entry, delay) {
        entry.timer = setTimeout(() => this.onRoundAbandoned(round), delay);
        // A watchdog must never be the reason the process stays alive; stop() is
        // what tears it down on a clean shutdown, matching the leader timers.
        if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
    },

    disarmRoundWatchdog(round) {
        let entry = this.roundWatchdogs.get(round);
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        this.roundWatchdogs.delete(round);
    },

    // Stamp the seat this hub currently holds in an open round on its watchdog
    // entry, so the round_lost record names what the hub was waiting on. The seat
    // moves as the round progresses (follower -> fallback proposer); the last stamp
    // is the one the record carries. No-op once the round has an outcome.
    noteRoundSeat(round, seat, info) {
        let entry = this.roundWatchdogs.get(round);
        if (!entry) return;
        entry.seat     = seat;
        entry.seatInfo = info || null;
    },

    // The round opened here and never reached a durable outcome. Write the skipped
    // record so this hub's absence of a snapshot is a stated fact rather than a
    // hole, and so hub-to-hub presence comparison (getoracleroundpresence) can tell
    // "we all lost this round" apart from "this hub never saw it".
    onRoundAbandoned(round) {
        let entry = this.roundWatchdogs.get(round);
        if (!entry) return;
        if (this.finalized.has(round) || this.locallySkipped.has(round)) {
            this.roundWatchdogs.delete(round);
            return;
        }
        // Still in flight (a late PROPOSE re-opened it, or armFinalizeRetry is
        // re-driving a quorum-signed round behind a DB stall). Give it another
        // finalization window, bounded, then record regardless.
        let pending = this.pendingRounds.get(round);
        if (pending && entry.rearms < ROUND_ABANDON_MAX_REARMS) {
            entry.rearms++;
            this.scheduleRoundWatchdog(round, entry,
                this.finalizationTimeout + this.roundAbandonGraceMs);
            return;
        }
        this.roundWatchdogs.delete(round);
        this._abandonedRounds++;
        this._lastAbandonedRound = round;
        logger.warn('Oracle: Round ' + round + ' opened here but never finalized; ' +
            'recording it as abandoned so this hub holds a durable record of the round.');
        // Structured twin of the line above: seat and anchor as fields, plus the counter.
        noteRoundLost({
            phase: 'finalize', round, cause: 'abandoned_in_flight',
            seat: entry.seat || 'unknown', ...(entry.seatInfo || {}),
            rearms: entry.rearms, pending: !!pending,
            reference_block: entry.btcBlockHeight, block_timestamp: entry.btcBlockTime
        });
        // NOT markFinalized: the skip is local and reprocessable, so a late
        // federation quorum still upgrades these rows to 'finalized' (#7).
        this.storeSkippedRound(round, entry.btcBlockHeight, entry.btcBlockTime,
            'round abandoned before finalization').catch(err =>
                logger.error(nodeUtil.format('Oracle: Error storing abandoned round ' + round + ':',
                    err && err.message ? err.message : err)));
    }
};
