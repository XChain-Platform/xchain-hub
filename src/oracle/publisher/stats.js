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
 * XChain Hub - Oracle Publisher: the publish rail's health snapshot
 *
 * What getoraclepublisherstatus reports. Every field is a cheap in-memory read
 * except queueDepth, which touches the durable queue file.
 *
 ********************************************************************/

'use strict';

const { worstCaseSnapshotAgeMs } = require('../price_batch_cadence.js');

module.exports = {

    // Snapshot of the publish rail's health for operator diagnostics. Intended to
    // be surfaced through a JSON-RPC status method (e.g. getoraclepublisherstatus)
    // alongside the sibling publishers' getStats accessors. All fields are cheap,
    // in-memory reads; queueDepth touches the durable queue file.
    getStats() {
        let queueDepth = 0;
        try { queueDepth = this.readQueue().length; } catch (e) { queueDepth = null; }
        let oldestUnconfirmed = this.oldestUnconfirmedPublish();
        // Assembled in the order the fields were always emitted, because this object is
        // a status RPC's payload: each helper below contributes its own block and the
        // reads inside them (the signer's stats, the pending-window walk) therefore
        // still happen in the order they did.
        return Object.assign({
            queueDepth:          queueDepth,
            published:           this.publishedCount,
            abandoned:           this.abandonedCount,
            oversizedDrops:      this.oversizedDrops,
            quarantined:         this._quarantinedRounds.size,
            // Marker-table retention: the configured window plus the lifetime prune
            // count, so an operator can tell a bounded table from one whose sweep has
            // been failing (pruned stuck at 0 while rounds keep publishing).
            publishedRoundsRetentionRounds: this.publishedRoundsRetentionRounds,
            publishedRoundsPruned:          this.publishedRoundsPruned,
            lastPublishedRound:  this.lastPublishedRound,
            lastPublishedTxid:   this.lastPublishedTxid,
            lastObservedBalance: this.lastObservedBalance
        }, this.landingStats(oldestUnconfirmed), this.takeoverStats(),
           this.rotationStats(), this.batchRailStats(), this.cadenceStats());
    },

    // Landing, not sending: whether what this hub broadcast reached a block, and what
    // the address holds at depth.
    landingStats(oldestUnconfirmed) {
        return {
            // Landing, not sending. lastPublishedTxid above answers only "what did we
            // broadcast last": these answer whether it reached a block. A non-zero
            // unconfirmedPublishes with an oldestUnconfirmedAgeMs in the hours is a
            // wedged publisher, whatever the rest of this snapshot reports.
            unconfirmedPublishes:    this._pendingConfirmations.size,
            oldestUnconfirmedTxid:   oldestUnconfirmed ? oldestUnconfirmed.txid  : null,
            oldestUnconfirmedRound:  oldestUnconfirmed ? oldestUnconfirmed.round : null,
            oldestUnconfirmedAgeMs:  oldestUnconfirmed ? oldestUnconfirmed.ageMs : null,
            confirmedPublishes:      this.confirmedPublishes,
            confirmationCheckIntervalMs: this.confirmCheckIntervalMs,
            confirmationCheckFailures:   this.confirmationCheckFailures,
            lastConfirmationCheckAt:     this.lastConfirmationCheckAt,
            // Confirmed-UTXO reserve as last read. confirmedUtxos at 0 while
            // unconfirmedUtxos is non-zero is the condition that defers a pass, and
            // noConfirmedUtxoDeferrals counts how often it has.
            confirmedUtxos:          this.lastUtxoReserve ? this.lastUtxoReserve.confirmed   : null,
            unconfirmedUtxos:        this.lastUtxoReserve ? this.lastUtxoReserve.unconfirmed : null,
            noConfirmedUtxoDeferrals: this.noConfirmedUtxoDeferrals,
            lastNoConfirmedUtxoAt:    this.lastNoConfirmedUtxoAt,
            deadLetterPath:      this.deadLetterPath,
            enabled:             this.enabled
        };
    },

    // The takeover rail: armed only when a failover window is configured AND this hub
    // has proof it would see a leader's batch land.
    takeoverStats() {
        return {
            // Takeover rail: armed only when a failover window is configured AND this
            // hub has proof it would see a leader's batch land. takeoverAttempts
            // climbing while takeoverPublished stays flat means windows are being
            // re-assembled but not reaching chain.
            takeoverFailoverWindowBlocks: this.failoverWindowBlocks,
            takeoverArmed:                this.failoverWindowBlocks > 0 && this._observationProven,
            takeoverPending:              this._takeoverTimers.size,
            takeoverAttempts:             this.takeoverAttempts,
            takeoverPublished:            this.takeoverPublished,
            // takeoverDeferred climbing means armed followers are correctly
            // holding off a window whose leader may have a tx in flight; a value that
            // climbs without takeoverPublished ever moving means leaders are broadcasting
            // batches that never mine, which is a fee/mempool problem, not a hub one.
            takeoverDeferred:             this.takeoverDeferred,
            takeoverAmbiguousCooldownMs:  this.takeoverAmbiguousCooldownMs
        };
    },

    // The leader-rotation view, and why this hub is not publishing as a NAMED state
    // rather than an absence.
    rotationStats() {
        return {
            // Leader-rotation view (item 3218): last finalized round's rank state
            // plus lifetime leader/follower-window counts, so a monitor can tell a
            // healthy-but-never-leader hub from a genuinely idle one and spot a dark
            // peer publisher (this hub's follower count climbs while its leader
            // rounds never land on-chain elsewhere).
            // Why this hub is not publishing, as a NAMED state rather than an absence.
            // Every field below reads null both for a hub whose publisher set will not
            // resolve (a wedge) and for a hub that is simply not in that set (nothing
            // wrong at all), because the rank state they come from is written only after
            // the membership test passes. These two answer the question those cannot:
            //
            //   in_set         this hub was in the publisher set at the last window it
            //                  elected on, so a backlog here is a real stall
            //   not_in_set     the set resolved and this hub was not in it; a backlog is
            //                  expected and must not degrade anything
            //   set_unresolved the set itself would not resolve, so membership is
            //                  unknowable right now (fail-closed, logged separately)
            //   unknown        no election has run yet in this process, which is what a
            //                  freshly restarted hub honestly reports until the first
            //                  window closes
            //
            // set_unresolved is read off the dark-snapshot flag the resolver already
            // maintains, so it costs no state of its own and it outranks the remembered
            // role: while the snapshot is dark, the last successful election is history,
            // not the current answer.
            publisherRole:       this._snapshotDark ? 'set_unresolved' : (this._publisherRole || 'unknown'),
            // Has this hub EVER published, in a form a consumer can gate on without
            // reading a round number. Both terms are durable across a restart:
            // lastPublishedRound is hydrated from the marker table at startup, and the
            // confirmed marker below is the intent-excluded evidence behind it.
            everPublished:       (Number.isFinite(Number(this.lastPublishedRound)) && Number(this.lastPublishedRound) > 0)
                                 || this._durableEverPublishedRound !== null,
            myRank:              this._lastRankState ? this._lastRankState.myRank : null,
            leaderRank:          this._lastRankState ? this._lastRankState.leaderRank : null,
            isLeader:            this._lastRankState ? this._lastRankState.isLeader : null,
            publisherCount:      this._lastRankState ? this._lastRankState.publisherCount : null,
            lastRankRound:       this._lastRankState ? this._lastRankState.round : null,
            leaderRounds:        this._leaderRounds,
            followerRounds:      this._followerRounds
        };
    },

    // The PRICE batch rail: what published, what is still waiting, and whether the
    // backlog is draining.
    batchRailStats() {
        return {
            // PRICE batch rail (spec section 7). batchUnpublishableCount is the
            // machine-checkable half of the loud ceiling: a non-zero value means a
            // single round plus its signature set no longer fits any wire form, which
            // no split can rescue.
            batchWindowsPublished:   this.batchWindowsPublished,
            lastPublishedWindow:     this.lastPublishedWindow,
            batchSplitCount:         this.batchSplitCount,
            batchUnpublishableCount: this.batchUnpublishableCount,
            // Surfaced from the signing round, so one status call answers "is the rail
            // stalled because nobody will co-sign?" without a second accessor.
            batchSignTimeouts:       this.batchSignTimeouts(),
            batchBufferDepth:        this._buffer.size,
            batchBufferPath:         this.bufferPath,
            batchWindowRounds:       this.batchWindowRounds,
            // The stuck-backlog reading. A closed window still buffered and
            // not yet assembled in this process is a window that attempted and produced
            // no wire; a count that does not fall across sweeps is a federation that
            // cannot agree on content, which no other field here shows.
            batchWindowsAwaitingRetry: this.pendingCatchupWindows().length,
            batchCatchupSweeps:        this.batchCatchupSweeps,
            // Drain observability. batchWindowsAwaitingRetry alone cannot tell a rail
            // that is walking its backlog from one pinned on the same four windows:
            // batchCatchupCursor moves on every sweep that spends a slot, and
            // batchCatchupRetiredWindows counts windows given up on rather than published.
            // A non-zero retired count is a real loss of history and belongs in a report,
            // not just a log line.
            batchCatchupCursor:         this._catchupCursor,
            batchCatchupRetiredWindows: this.batchCatchupRetiredWindows,
            batchCatchupBacklogIntervalMs: this.batchCatchupBacklogIntervalMs,
            // Landed-batch pruning. bufferedWindowsPending climbing while
            // both pruned counters stay flat is a hub that hears no batch pushes AND
            // cannot reach its landing-chain indexer; chainReconcileFailures says which.
            landedBatchPrunedRounds:   this.landedBatchPrunedRounds,
            chainReconcileRuns:        this.chainReconcileRuns,
            chainReconcilePrunedRounds: this.chainReconcilePrunedRounds,
            chainReconcileFailures:    this.chainReconcileFailures,
            bufferedWindowsPending:    this.pendingCatchupWindows().length,
            batchCatchupIntervalMs:    this.batchCatchupIntervalMs
        };
    },

    // The cadence contract with the fee gate, in one place, plus the spend guard.
    cadenceStats() {
        return {
            // The cadence contract with the fee gate, in one place.
            // batchWorstCaseSnapshotAgeSeconds ABOVE oracleMaxPriceAgeSeconds means
            // native-coin fees go unpriceable between batches, which is invisible in
            // every other field here: the rail reports perfect health while it happens.
            batchWindowRoundsCeiling:         this.batchWindowRoundsCeiling,
            batchCadenceSeconds:              Math.round((this.batchWindowRounds * this.roundIntervalMs) / 1000),
            batchWorstCaseSnapshotAgeSeconds: (() => {
                let ms = worstCaseSnapshotAgeMs(this.batchWindowRounds, {
                    roundIntervalMs:  this.roundIntervalMs,
                    graceMs:          this.batchGraceMs,
                    landingReserveMs: this.batchLandingReserveMs });
                return ms === null ? null : Math.round(ms / 1000);
            })(),
            oracleMaxPriceAgeSeconds: this.oracleMaxPriceAgeMs === null
                ? null : Math.round(this.oracleMaxPriceAgeMs / 1000),
            spendGuard:          this.spendGuard.stats()
        };
    },

    // The signer's own timeout counter, read without constructing a signer: getStats is
    // a cheap diagnostic and must not start a P2P handler as a side effect.
    batchSignTimeouts() {
        let signer = (this.hub && this.hub.oracleBatchSigner) || this._ownedBatchSigner;
        if (!signer || typeof signer.getStats !== 'function') return 0;
        try {
            let s = signer.getStats();
            return (s && Number.isFinite(Number(s.batchSignTimeouts))) ? Number(s.batchSignTimeouts) : 0;
        } catch (e) {
            return 0;
        }
    },

};
