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
 * XChain Hub - Oracle Publisher: rank-staggered takeover of a silent leader's window
 *
 * Opt-in and default off. A follower steps in only when it can PROVE it would
 * have seen the leader succeed, and defers while a leader's transaction may still
 * be in flight, because both mistakes pay the DOGE fee twice.
 *
 ********************************************************************/

'use strict';

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Bound on the ambiguous-send memo. Each entry only has to outlive one
// takeoverAmbiguousCooldownMs, so this is generous by orders of magnitude.
const AMBIGUOUS_WINDOW_MEMO_MAX = 256;

module.exports = {

    // ----- Rank-staggered takeover -----

    // Arm this hub to re-assemble a window its leader may never publish. The delay is
    // the hub's DISTANCE from the leader in the rotation, not its absolute rank, so
    // the set steps in one at a time in a deterministic order every hub computes
    // identically from the same snapshot: rank leader+1 first, then leader+2, and so
    // on. Each step is failoverWindowBlocks blocks of continued silence.
    scheduleTakeover(windowIndex, myRank, leaderRank, publisherCount) {
        if (!this.failoverWindowBlocks) return;             // opt-in, default off
        if (!publisherCount || publisherCount < 2) return;  // nobody to take over from
        if (this._takeoverTimers.has(windowIndex)) return;
        let offset = ((myRank - leaderRank) % publisherCount + publisherCount) % publisherCount;
        if (offset === 0) return;                           // that is the leader itself
        let delay = offset * this.failoverWindowBlocks * this.approxBlockMs;
        let timer = setTimeout(() => {
            this._takeoverTimers.delete(windowIndex);
            this.attemptTakeover(windowIndex).catch(err =>
                logger.error(nodeUtil.format('OraclePublisher: takeover attempt for window ' + windowIndex + ' failed:', err)));
        }, delay);
        if (timer.unref) timer.unref();
        this._takeoverTimers.set(windowIndex, timer);
    },

    // Step in for a silent leader, or decline. Declines for four distinct reasons,
    // each of which must stay distinguishable in the log from "took over". Only one of
    // them is temporary: the ambiguity cooldown re-arms itself and comes back.
    async attemptTakeover(windowIndex) {
        if (!this.enabled) return false;
        let first = windowIndex * this.batchWindowRounds;
        let last  = first + this.batchWindowRounds - 1;

        // 1. The leader published after all. Nothing to do; prune our copy.
        if (await this.pruneObservedWindow(first, last) > 0) return false;
        if (await this.windowObservedOnChain(first, last)) return false;

        // 2. FAIL CLOSED when this hub has never observed ANY batch on chain. The
        // observation feed is the indexer pushing landed PRICE actions back to this
        // hub, and a hub that receives no pushes cannot tell "the leader published
        // and I did not hear" from "the leader is dark". Taking over on that
        // ambiguity double-pays DOGE and puts a duplicate batch on chain, so a hub
        // with an unproven feed declines every takeover and says so once.
        if (!(await this.observationFeedProven())) {
            if (!this._takeoverDarkWarned) {
                this._takeoverDarkWarned = true;
                logger.warn('OraclePublisher: declining takeover of window ' + windowIndex + ' and every ' +
                    'later one: this hub has never observed an on-chain PRICE batch, so it cannot tell a ' +
                    'silent leader from a deaf follower. Point this network\'s indexer HUB_API_URL at this ' +
                    'federation so landed batches are pushed back, then takeover arms itself.');
            }
            return false;
        }

        // 3. An ambiguous in-flight batch defers this attempt and re-arms it.
        if (this.takeoverDeferredForAmbiguity(windowIndex, first, last)) return false;

        // 4. Nothing published it and we can prove we would have seen it. Re-assemble
        // the identical window, bypassing the leader check but nothing else: quorum
        // signing, coverage, the spend guard and the at-most-once markers all still
        // apply, and the queue's own guards stop a second wire for rounds already sent.
        this._assembledWindows.delete(windowIndex);
        await this.assembleWindow(windowIndex, { takeover: true });
        return true;
    },

    // AMBIGUOUS IN-FLIGHT BATCH. "Not on chain" cannot tell a leader
    // that never broadcast from one whose tx is sitting unmined in the DOGE
    // mempool, and re-publishing over the second pays the fee twice for a window
    // that is already in flight. Two local facts make the send ambiguous: a
    // co-signature this hub HANDED the leader (the last thing it needed before
    // broadcasting) and an ambiguous send of this hub's own for the same window.
    // Either starts the cooldown. When the cooldown elapses and the window is
    // STILL absent from the observed-on-chain view above, the tx demonstrably
    // never mined and takeover is safe. Same shape as AttestationPublisher's
    // _ambiguousSends deferral, which this rail was missing.
    //
    // True when this attempt deferred, which the caller reports as a decline.
    takeoverDeferredForAmbiguity(windowIndex, first, last) {
        let ambiguousAt = this.takeoverAmbiguityAt(windowIndex, first, last);
        if (ambiguousAt !== null && this.takeoverAmbiguousCooldownMs > 0) {
            let waited = Date.now() - ambiguousAt;
            if (waited < this.takeoverAmbiguousCooldownMs) {
                this.takeoverDeferred++;
                let remaining = this.takeoverAmbiguousCooldownMs - waited;
                logger.warn('OraclePublisher: deferring takeover of window ' + windowIndex +
                    ' for ~' + Math.ceil(remaining / 1000) + 's: a batch covering rounds ' + first +
                    '..' + last + ' may already be in flight (evidence ~' + Math.round(waited / 1000) +
                    's ago), and re-publishing over an unmined leader tx pays the DOGE fee twice');
                // Re-arm, or the deferral is a CANCELLATION: the timer that brought us
                // here is already gone, so a leader that turns out to have been dark
                // after all would never be covered by this hub.
                this.rearmTakeover(windowIndex, remaining);
                return true;
            }
            // Cooldown spent with the window still off chain: whatever was in flight
            // never mined. Drop the mark so a later pass does not re-derive it.
            this._ambiguousWindows.delete(windowIndex);
        }
        return false;
    },

    // The most recent local evidence that a batch covering [first,last] may ALREADY be
    // on the wire, or null when there is none. Two sources, both of which mean "a tx
    // may exist that this hub cannot see yet":
    //
    //   - this hub's own ambiguous send for the window (processQueue dead-letters it
    //     rather than retrying, precisely because the DOGE node may have taken it);
    //   - the co-signature this hub gave the window's leader, which is the last thing
    //     the leader was waiting on. A leader that never asked cannot have broadcast,
    //     so a window with no co-signature is genuine silence and takes over at once.
    //
    // The signer is read through the hub, never through getBatchSigner(): that
    // accessor CONSTRUCTS and starts a signer as a side effect, which a read-only
    // question must not do (same pattern as batchSignTimeouts).
    takeoverAmbiguityAt(windowIndex, first, last) {
        let newest = this._ambiguousWindows.has(windowIndex)
            ? this._ambiguousWindows.get(windowIndex)
            : null;
        let signer = (this.hub && this.hub.oracleBatchSigner) || this._ownedBatchSigner;
        if (signer && typeof signer.coSignedAt === 'function') {
            let ts = null;
            try {
                ts = signer.coSignedAt(first, last);
            } catch (e) {
                logger.warn(nodeUtil.format('OraclePublisher: cannot read the batch signer\'s co-signature memo ' +
                    'for rounds ' + first + '..' + last + ': ', e && e.message));
                ts = null;
            }
            if (Number.isFinite(ts) && (newest === null || ts > newest)) newest = ts;
        }
        return newest;
    },

    // Remember that a batch wire for this window left the process AMBIGUOUSLY, so a
    // takeover armed against the same window defers instead of duplicating the spend.
    noteAmbiguousWindow(windowIndex) {
        if (!Number.isFinite(windowIndex)) return;
        this._ambiguousWindows.delete(windowIndex);
        this._ambiguousWindows.set(windowIndex, Date.now());
        while (this._ambiguousWindows.size > AMBIGUOUS_WINDOW_MEMO_MAX) {
            this._ambiguousWindows.delete(this._ambiguousWindows.keys().next().value);
        }
    },

    // Put the deferred takeover back on the clock. Deliberately not scheduleTakeover:
    // that one computes the rank stagger from scratch, and this window's stagger has
    // already been served; what is left to wait out is only the cooldown remainder.
    rearmTakeover(windowIndex, delay) {
        if (this._takeoverTimers.has(windowIndex)) return;
        let timer = setTimeout(() => {
            this._takeoverTimers.delete(windowIndex);
            this.attemptTakeover(windowIndex).catch(err =>
                logger.error(nodeUtil.format('OraclePublisher: deferred takeover attempt for window ' + windowIndex + ' failed:', err)));
        }, Math.max(1, delay));
        if (timer.unref) timer.unref();
        this._takeoverTimers.set(windowIndex, timer);
    },

    // Is any round in [first,last] already carried by a batch this hub has seen land
    // on chain? Fail CLOSED on a DB error (report observed), so an unreadable hub DB
    // suppresses takeover instead of licensing a blind duplicate broadcast.
    async windowObservedOnChain(first, last) {
        if (!this.db) return true;
        try {
            let rows = await this.db.hasPriceSnapshotsByRoundNumber(first, last);
            return !!(rows && rows.length);
        } catch (e) {
            logger.warn(nodeUtil.format('OraclePublisher: cannot check whether rounds ' + first + '..' + last +
                ' are already on chain; declining takeover: ', e && e.message));
            return true;
        }
    },

    // Has a landed batch EVER reached this hub? Memoized true only: a feed that is
    // dark now can come up later, and a fresh federation legitimately has nothing to
    // observe until its first window lands, so this arms itself rather than needing
    // an operator to flip it.
    async observationFeedProven() {
        if (this._observationProven) return true;
        if (!this.db) return false;
        try {
            let rows = await this.db.hasPriceSnapshotsByConsensusProof();
            if (rows && rows.length) this._observationProven = true;
        } catch (e) {
            logger.warn(nodeUtil.format('OraclePublisher: cannot confirm the on-chain observation feed; ' +
                'takeover stays disarmed: ', e && e.message));
        }
        return this._observationProven;
    },

};
