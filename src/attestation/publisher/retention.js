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
 * XChain Hub - Attestation Publisher: marker retention
 *
 * Bounds the attest_published_requests table without ever pruning a marker a live
 * path can still reach. Installed on AttestationPublisher.prototype by
 * src/attestation/publisher.js.
 *
 ********************************************************************/

'use strict';

const nodeUtil = require('node:util');
const { PUBLISHED_RETENTION_DEADLINE_SAFETY, PUBLISHED_RETENTION_QUEUE_MAX } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Longest wall-clock window in which a CONFIRMED marker can still change a
    // decision, derived from live governance rather than from a baked constant.
    //
    // A confirmed marker is only ever read through durableSendGate, and that gate is
    // reachable from exactly two places: onRequestFinalized (an AttestationConsensus
    // finalization, which only fires for a request the consensus polled out of the
    // indexer's PENDING set) and the replay sweep (which reaches the gate only past
    // `pendingIds.has(rid)`). So a request whose marker no longer matters is precisely
    // one that can no longer be PENDING, and the indexer expires a request at its
    // deadline_block, at most `deadline_window_blocks` BTC blocks after the request
    // landed (xchain-indexer providerRegistry.isDeadlineAllowed).
    //
    // That window is governance-controlled JSON, so it is re-derived here through
    // ProviderRegistry.maxDeadlineWindowBlocks() the way AttestationConsensus
    // .checkNonOkSizingFloor does, never from the 100-block http_get figure in any
    // comment. Unlike that check this one is a HARD CLAMP, not a warning: an
    // undersized ring only wastes a fee, while a marker pruned too early lets the very
    // next finalization spend a SECOND fee for a response already on-chain.
    //
    // Returns 0 when no registry or no usable window is available, in which case the
    // caller falls back to the queue exclusion plus the configured window alone.
    publishedRetentionFloorMs(){
        let registry = (this.hub && this.hub.providerRegistry) ? this.hub.providerRegistry : null;
        if (!registry || typeof registry.maxDeadlineWindowBlocks !== 'function') return 0;
        let max = registry.maxDeadlineWindowBlocks();
        let blocks = Number(max && max.blocks);
        if (!Number.isFinite(blocks) || blocks <= 0) return 0;
        return blocks * this.approxBlockMs * PUBLISHED_RETENTION_DEADLINE_SAFETY;
    },

    // Bound the durable attest_published_requests marker table to the retention
    // window. Without this the table appends one row per paid ATTEST request forever,
    // and hydratePublishedMarkers re-reads all of it into memory on every restart.
    //
    // Three invariants dominate this DELETE, all load-bearing on a path that spends
    // real BTC:
    //
    //   1. `sent_at IS NOT NULL AND intent_status IS NULL` is mandatory. Either an
    //      intent-only row or a row still holding an armed intent is a QUARANTINE
    //      marker for a publication whose on-chain state is unknown after a crash;
    //      hydratePublishedMarkers turns it into a permanent operator-only hold.
    //      Pruning one would erase the sole record that it needs hand-verification,
    //      and the next finalization would broadcast it again.
    //   2. No request still on the durable WAL may be pruned, the exact analogue of
    //      OraclePublisher's queue-file clamp. The rid is a string rather than an
    //      orderable round, so the queue is excluded by identity instead of by a
    //      cutoff clamp, which is tighter than a clamp rather than looser.
    //   3. The window is floored at the re-presentability horizon
    //      (publishedRetentionFloorMs), so a configured window shorter than the
    //      longest provider deadline cannot delete a marker a live path can still
    //      reach.
    //
    // Returns the number of rows deleted. Throws on a DB error; the caller decides
    // (the sweep path treats a retention failure as non-fatal).
    async prunePublishedRequests(){
        let db = this.hubDb();
        if (!db) return 0;
        if (!this.publishedRequestsRetentionMs || this.publishedRequestsRetentionMs <= 0) return 0;

        let windowMs = Math.max(this.publishedRequestsRetentionMs, this.publishedRetentionFloorMs());

        // Invariant 2. Best-effort read; an unreadable queue returns [] and the window
        // applies on its own (an unreadable queue file is already loud elsewhere).
        let queued = [];
        for (let entry of this.readQueue()){
            let rid = String(entry && entry.requestId || '').toLowerCase();
            if (rid) queued.push(rid);
        }
        if (queued.length > PUBLISHED_RETENTION_QUEUE_MAX){
            logger.warn('AttestationPublisher: skipping the published-requests retention sweep; ' +
                queued.length + ' entries are still on the durable queue at ' + this.queuePath +
                ' (over the ' + PUBLISHED_RETENTION_QUEUE_MAX + ' exclusion cap). The queue is not draining; ' +
                'fix that first, retention is the lesser problem.');
            return 0;
        }

        // Seconds, because the cutoff is DB-clock arithmetic on both sides: sent_at is
        // written by NOW(), so comparing it against a Node-side timestamp would fold any
        // host/DB clock skew straight into the cutoff (the statement lives in
        // db.deleteSettledAttestPublishedRequests).
        let windowSec = Math.ceil(windowMs / 1000);

        let result  = await db.deleteSettledAttestPublishedRequests(windowSec, queued);
        let deleted = (result && result.affectedRows) ? Number(result.affectedRows) : 0;
        if (deleted > 0){
            this.publishedRequestsPruned += deleted;
            logger.info('AttestationPublisher: published-requests retention pruned ' + deleted +
                ' settled marker row(s) older than ' + windowSec + 's (rows holding a quarantined intent and ' +
                'anything still on the durable queue are never pruned)');
        }
        return deleted;
    },

    // Housekeeping hook for the retention sweep. Fire-and-forget with the rejection
    // swallowed: bounding the marker table must never stall, fail or retry a broadcast
    // pass that has already spent BTC. Skipped when the publisher is disabled (a paused
    // publisher touches nothing) and when nothing has been published since the last
    // sweep, since the table only grows when this hub spends.
    sweepPublishedRequestRetention(){
        if (!this.enabled || !this._markersAddedSinceSweep) return;
        if (!this.hubDb() || !this.publishedRequestsRetentionMs) return;
        this._markersAddedSinceSweep = false;
        this._retentionSweep = this.prunePublishedRequests()
            .catch((e) => {
                logger.warn(nodeUtil.format('AttestationPublisher: published-requests retention sweep failed ' +
                    '(the marker table keeps growing until it succeeds): ', e));
                return 0;
            });
    }

};
