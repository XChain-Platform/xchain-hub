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
 * XChain Hub - Oracle Publisher: the window scheduler and the catch-up sweep
 *
 * What closes a window, what serializes the assemblies, and the bounded recurring
 * sweep that re-proposes windows a signing round left unpublished. The bound and
 * the rotating cursor are what keep a backlog drainable without starving the live
 * window behind it.
 *
 ********************************************************************/

'use strict';

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Bound on the assembled-window memo below. It only exists to stop one process
// re-assembling a window it already handled, so it needs to cover the buffer's
// own horizon and nothing more; the durable per-round markers are the real
// at-most-once guard.
const ASSEMBLED_WINDOW_MEMO_MAX = 4096;

// Windows re-proposed per catch-up sweep. Assemblies are serialized on
// _windowChain and each one can hold it for a whole ORACLE_BATCH_SIGN_TIMEOUT_MS, so a
// backlog of a hundred windows must not be attempted in one pass: the live window
// queued behind it would wait out every one of them.
const CATCHUP_WINDOWS_PER_SWEEP = 4;

module.exports = {

    // ----- The window scheduler -----

    windowIndexOf(round) {
        return Math.floor(parseInt(round) / this.batchWindowRounds);
    },

    // Called for every round this hub buffers. Two things close a window: its LAST
    // slot finalizing, or a round of a HIGHER window arriving (which proves the lower
    // one can receive nothing more). Skipped rounds make the second case the normal
    // one at the end of an hour, so both are needed.
    noteWindowRound(round) {
        let w = this.windowIndexOf(round);
        if (!Number.isFinite(w)) return;
        for (let lower of Array.from(this._windows.keys())) {
            if (lower < w) this.armWindowTimer(lower);
        }
        if (!this._windows.has(w)) this._windows.set(w, { timer: null });
        if (parseInt(round) % this.batchWindowRounds === this.batchWindowRounds - 1) {
            this.armWindowTimer(w);
        }
    },

    // Arm the grace timer for a window, once. Never re-armed: extending it on every
    // late arrival would let a steady trickle of stragglers postpone an hour of price
    // data indefinitely.
    armWindowTimer(windowIndex) {
        let state = this._windows.get(windowIndex);
        if (!state) { state = { timer: null }; this._windows.set(windowIndex, state); }
        if (state.timer) return;
        // Already handled. Drop the tracking entry too, or a window that assembled
        // early keeps a row in _windows that every later round re-walks.
        if (this._assembledWindows.has(windowIndex)) { this._windows.delete(windowIndex); return; }
        state.timer = setTimeout(() => {
            state.timer = null;
            this._windows.delete(windowIndex);
            this.queueWindowAssembly(windowIndex);
        }, this.batchGraceMs);
        if (state.timer.unref) state.timer.unref();
    },

    // Serialize assemblies onto one chain. The signing round holds a single in-flight
    // slot, so two windows assembling at once would have the second one silently
    // clobber the first's round.
    queueWindowAssembly(windowIndex) {
        this._windowChain = this._windowChain.then(() =>
            this.assembleWindow(windowIndex).catch(e =>
                logger.error(nodeUtil.format('OraclePublisher: window ' + windowIndex + ' assembly failed:', e))));
        return this._windowChain;
    },

    scheduleBufferCatchup() {
        if (this._buffer.size === 0) return;
        this._catchupTimer = setTimeout(() => {
            this._catchupTimer = null;
            this.reconcileThenSweep();
        }, this.batchGraceMs);
        if (this._catchupTimer.unref) this._catchupTimer.unref();
    },

    // One catch-up pass: first shed every buffered window the landing chain already
    // carries, THEN re-propose what is left. Never throws: the sweep must run even
    // when the reconcile cannot, or a hub with no indexer would never catch up.
    async reconcileThenSweep() {
        try { await this.reconcileBacklogAgainstChain(); }
        catch (e) { logger.error(nodeUtil.format('OraclePublisher: backlog reconcile against the chain failed:', e)); }
        try { return this.sweepBufferCatchup(); }
        catch (e) { logger.error(nodeUtil.format('OraclePublisher: buffer catch-up sweep failed:', e)); return 0; }
    },

    // Is this window's LAST slot in the buffer? That round is the one whose arrival
    // closes the window live, so holding it is proof the window is closed even when no
    // higher round exists yet and no timer survived to say so.
    windowLastSlotBuffered(windowIndex) {
        return this._buffer.has(windowIndex * this.batchWindowRounds + this.batchWindowRounds - 1);
    },

    // Every closed window this hub still holds buffered rounds for, has not already
    // assembled in this process, and has no grace timer of its own already pending.
    //
    // Every window below the highest is closed by construction, because a higher round
    // exists. Excluding the highest outright, on the theory that it may still
    // be open, is true only while its last slot is missing. A window whose last
    // round is buffered has closed, and excluding it meant a restart inside its grace
    // orphaned it: the timer died with the process, and nothing re-proposed the window
    // until some later round happened to open a higher one. So the highest
    // is included exactly when the buffer proves it closed.
    //
    // A window whose grace timer is still pending is skipped, because that timer owns
    // it: assembling early would publish a wire without the straggler rounds the grace
    // exists to collect.
    //
    // _assembledWindows is what keeps this cheap on the second and later sweeps: a
    // window this hub followed, published, or found empty is memoized there, so what
    // survives the filter is exactly the windows that ATTEMPTED and produced no wire.
    pendingCatchupWindows() {
        if (this._buffer.size === 0) return [];
        let windows = Array.from(new Set(
            Array.from(this._buffer.keys()).map(r => this.windowIndexOf(r)))).sort((a, b) => a - b);
        let highest = windows[windows.length - 1];
        return windows.filter(w => {
            if (this._assembledWindows.has(w)) return false;
            let state = this._windows.get(w);
            if (state && state.timer) return false;
            return w < highest || this.windowLastSlotBuffered(w);
        });
    },

    // Put back what a restart dropped. _windows is memory-only, so after a restart the
    // scheduler knows nothing about the rounds hydrateBuffer just reloaded, and the
    // "a higher window's round arrived, so close the lower ones" path (noteWindowRound)
    // walks exactly that map: a window whose last slot was SKIPPED before the restart
    // would never be closed by the round that proves it can receive nothing more.
    //
    // Only the highest buffered window is re-registered, and deliberately unarmed. Every
    // window below it is already closed and belongs to the bounded catch-up sweep;
    // registering those here would let one higher round arm them all at once and put the
    // live window behind a queue of stale assemblies, which is the starvation the
    // per-sweep bound exists to prevent. The highest is the one window the sweep cannot
    // reach while it is still open, so it is the one the scheduler must remember.
    rearmBufferedWindows() {
        if (this._buffer.size === 0) return;
        let highest = -Infinity;
        for (let r of this._buffer.keys()) {
            let w = this.windowIndexOf(r);
            if (Number.isFinite(w) && w > highest) highest = w;
        }
        if (!Number.isFinite(highest)) return;
        if (this._assembledWindows.has(highest)) return;
        if (!this._windows.has(highest)) this._windows.set(highest, { timer: null });
    },

    // One catch-up pass, oldest window first. Bounded, because each attempt can run a
    // signing round that costs up to ORACLE_BATCH_SIGN_TIMEOUT_MS and they are
    // serialized on _windowChain: an unbounded sweep over a long backlog would occupy
    // that chain for hours and starve the live window queued behind it.
    // Slots are spent from a rotating cursor rather than always on the head of the
    // backlog, and a window that has failed long enough is retired instead of taking a
    // slot forever. Both exist because of the same measurement: at four windows an hour,
    // always the oldest four, a hub holding 697 closed windows re-proposed windows 10-13
    // for ever and proposed window 14 never once.
    sweepBufferCatchup() {
        let pending = this.pendingCatchupWindows();
        if (pending.length === 0) return 0;
        this.batchCatchupSweeps++;

        // Resume where the last sweep stopped, wrapping when the cursor has passed
        // everything still pending.
        let start = 0;
        while (start < pending.length && pending[start] < this._catchupCursor) start++;
        if (start >= pending.length) start = 0;

        let take = [];
        let retired = [];
        for (let i = 0; i < pending.length && take.length < CATCHUP_WINDOWS_PER_SWEEP; i++) {
            let w = pending[(start + i) % pending.length];
            // Retiring costs no slot: a hopeless window must not displace a window that
            // could still publish, which is the whole point of retiring it.
            if (this.retireExhaustedWindow(w)) { retired.push(w); continue; }
            let seen = this._catchupAttempts.get(w);
            if (seen) seen.count++;
            else      this._catchupAttempts.set(w, { count: 1, firstAt: Date.now() });
            take.push(w);
        }
        if (take.length === 0 && retired.length === 0) return 0;
        if (take.length > 0) this._catchupCursor = take[take.length - 1] + 1;

        if (pending.length > take.length) {
            logger.warn('OraclePublisher: ' + pending.length + ' closed window(s) are still ' +
                'buffered and unpublished; re-proposing ' + take.length + ' of them this sweep ' +
                '(from window ' + (take.length ? take[0] : '-') + ', resuming at ' +
                this._catchupCursor + ' next sweep)' +
                (retired.length ? '; retired ' + retired.length + ' window(s) that will never be co-signed' : ''));
        }
        for (let w of take) this.queueWindowAssembly(w);
        return take.length;
    },

    // Retire one window from the catch-up sweep when it has failed enough attempts, for
    // long enough, that the federation is not going to co-sign it. True when it was
    // retired this call.
    //
    // Retirement is a memo entry, NOT a deletion: the buffered rounds stay exactly where
    // they are, so the observation prune, a takeover and the ORACLE_BATCH_BUFFER_MAX_ROUNDS
    // bound all behave as before, and nothing this hub holds is thrown away. All it
    // changes is that the window stops consuming a re-proposal slot the windows behind
    // it need.
    retireExhaustedWindow(windowIndex) {
        if (this.catchupMaxAttempts <= 0) return false;
        let seen = this._catchupAttempts.get(windowIndex);
        if (!seen || seen.count < this.catchupMaxAttempts) return false;
        if ((Date.now() - seen.firstAt) < this.catchupRetireAfterMs) return false;

        let first = windowIndex * this.batchWindowRounds;
        let last  = first + this.batchWindowRounds - 1;
        this.batchCatchupRetiredWindows++;
        this.noteAssembled(windowIndex);   // also clears the attempt record
        logger.warn('OraclePublisher: window [' + first + ',' + last + '] has failed ' + seen.count +
            ' batch-signing round(s) over ' + Math.round((Date.now() - seen.firstAt) / 60000) +
            ' minute(s) and is retired from the catch-up sweep: no quorum of the price-capable set ' +
            'will reproduce its content, so re-proposing it only starves the windows behind it. Its ' +
            'rounds stay buffered; batchCatchupRetiredWindows in getoraclepublisherstatus counts this.');
        return true;
    },

    // The recurring half of the catch-up, and the half that was missing.
    //
    // A window whose signing round times out below quorum is deliberately NOT memoized,
    // so that it can be re-proposed (spec section 7). Nothing re-proposed it: the
    // sweep ran exactly once per process, ORACLE_BATCH_GRACE_MS after start(). A window
    // that failed once therefore stayed unpublished until an operator happened to
    // restart the hub, and its rounds stayed buffered until the ORACLE_BATCH_BUFFER_MAX_ROUNDS
    // bound eventually shed them unpublished. Measured on public testnet 2026-09-02:
    // window [102,107] refused by three peers at the 2026-09-01 boot and never
    // attempted again in the 11 hours since, with 744 rounds back to round 21 still
    // sitting in the leader's buffer.
    //
    // Deliberately a slow loop, not a tight retry. The refusal it recovers from is
    // either transient (a peer down) or content drift that reconcileBufferedWindow
    // repairs from price_snapshots, and neither is fixed by asking again sooner; what
    // a fast retry WOULD buy is a signing round per window per interval across the
    // whole federation, plus a refusal line per peer per attempt in every log.
    // A self-rescheduling timeout rather than an interval, because the cadence is not
    // fixed: an idle rail waits the full ORACLE_BATCH_CATCHUP_INTERVAL_MS, and a rail
    // with a backlog deeper than one sweep comes straight back at the backlog cadence.
    // Each tick also AWAITS the assemblies it queued before re-arming, so the number of
    // catch-up assemblies outstanding on _windowChain is still capped at
    // CATCHUP_WINDOWS_PER_SWEEP no matter how short the cadence gets. That cap is what
    // the serialization argument was ever about; the hour of idling between sweeps
    // protected nothing and cost the fleet a backlog it could not walk.
    startBufferCatchupSweep() {
        if (this._catchupSweepTimer) return;
        this.armCatchupSweep(this.batchCatchupIntervalMs);
    },

    armCatchupSweep(delayMs) {
        this._catchupSweepTimer = setTimeout(() => {
            this._catchupSweepTimer = null;
            this.runCatchupSweepTick();
        }, delayMs);
        if (this._catchupSweepTimer.unref) this._catchupSweepTimer.unref();
    },

    async runCatchupSweepTick() {
        // A tick supersedes whatever was armed: the timer path has already cleared it,
        // and a caller driving a sweep by hand must not leave a second one pending.
        if (this._catchupSweepTimer) { clearTimeout(this._catchupSweepTimer); this._catchupSweepTimer = null; }
        try {
            await this.reconcileThenSweep();
            // The assemblies this sweep queued, so the next tick cannot pile a second
            // sweep's worth onto the chain behind them.
            await this._windowChain;
        } catch (e) {
            logger.error(nodeUtil.format('OraclePublisher: buffer catch-up sweep failed:', e));
        }
        if (this._stopped) return;
        let backlog = this.pendingCatchupWindows().length;
        this.armCatchupSweep(backlog > CATCHUP_WINDOWS_PER_SWEEP
            ? this.batchCatchupBacklogIntervalMs
            : this.batchCatchupIntervalMs);
    },

    noteAssembled(windowIndex) {
        // A window that reached an assembly outcome is no longer a failing one, whether
        // it published, was followed, or was found empty. Keeping its attempt record
        // would retire the NEXT window to reuse the index after the memo evicts.
        this._catchupAttempts.delete(windowIndex);
        this._assembledWindows.set(windowIndex, true);
        while (this._assembledWindows.size > ASSEMBLED_WINDOW_MEMO_MAX) {
            this._assembledWindows.delete(this._assembledWindows.keys().next().value);
        }
    },

};
