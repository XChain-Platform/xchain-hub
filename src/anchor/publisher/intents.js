/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * ANCHOR publisher - durable broadcast intents
 *
 * The at-most-once markers for anchor and archive sends: recorded before a
 * broadcast, settled or withdrawn after it, pruned once confirmed and past the TTL.
 *
 ********************************************************************/

'use strict';

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();
const { ANCHOR_MARKER_RETENTION_TTL_SAFETY } = require('./constants.js');

module.exports = {

    // Durable at-most-once for the anchor spend (anchor_published_checkpoints).
    //
    // The existence check above closes a lost ACK only where it can SEE the earlier send,
    // and getanchoraction resolves a txid through mined blocks, so an anchor sitting in
    // the DOGE mempool reads as DEFINITIVELY ABSENT. Everything else that knows a send
    // went out is in memory (broadcastWithRetry's lastErr / ambiguous-poll loop) and
    // `anchor_txid` is stamped only after the broadcast returns. A crash in between
    // therefore leaves the row still matching the `anchor_txid IS NULL` selector with
    // nothing anywhere recording that DOGE already paid, and the next flush rebuilds a
    // FRESH PSBT from different UTXOs: a second fee, and two anchors that can both
    // confirm.
    //
    // These four methods are the restart-surviving half, ported from the three sibling
    // effectors that already carry it (OraclePublisher's oracle_published_rounds,
    // AttestationPublisher's attest_published_requests, AttestationRelay's
    // WAL). Intent is armed before the send, confirmed after it, and withdrawn when the
    // send definitively never went out; a surviving intent HOLDS the row rather than
    // re-broadcasting.
    //
    // Two deliberate choices. It does not re-broadcast the earlier bytes: that turns on
    // how this encoder classifies a duplicate submission, which is not established here,
    // and holding costs latency where guessing costs money. And the hold is bounded by
    // anchorIntentTtlMs, because an unbounded marker for a never-mined tx would suppress
    // a needed re-anchor forever, which is the failure the announcement queues above are
    // TTL-bounded for as well.

    // Read the durable marker for a checkpoint, or null when none exists. Throws on a DB
    // error so the caller FAILS CLOSED (the row stays pending) rather than spending on a
    // checkpoint whose publish history it could not read.
    async getAnchorIntent(row){
        let rows = await this.db.findAnchorPublishedCheckpoints(row.chain, row.network, Number(row.checkpoint_seq));
        return (rows && rows.length > 0) ? rows[0] : null;
    },

    // Does this marker still cover a send that might be live? Measured from intent_at,
    // which is written BEFORE the broadcast, so the window starts at the earliest moment
    // money could have moved. An unreadable stamp holds (fail closed): the TTL is a
    // liveness bound, not a licence to spend.
    anchorIntentHolds(marker){
        if(!marker) return false;
        let at = marker.intent_at ? new Date(marker.intent_at).getTime() : NaN;
        if(!Number.isFinite(at)) return true;
        return (Date.now() - at) < this.anchorIntentTtlMs;
    },

    // Durably arm broadcast intent before the send. Re-arming refreshes the window
    // rather than leaving the row untouched: the caller reaches this only when no
    // unexpired intent holds the checkpoint AND `anchor_txid` is still NULL, so the
    // marker being overwritten is an expired one and the write is this retry opening its
    // own window. Throws on a DB error so the caller fails closed.
    async recordAnchorIntent(row){
        await this.db.setAnchorPublishedCheckpoint(row.chain, row.network, Number(row.checkpoint_seq));
    },

    // Record that the broadcast returned a txid. Logged, never thrown: the DOGE fee is
    // already spent, and the surviving intent-only row makes the next flush HOLD instead
    // of re-broadcasting, which is the fail-safe direction.
    async markAnchorSent(row, txid){
        try {
            await this.db.updateAnchorPublishedCheckpoint(txid || null, row.chain, row.network, Number(row.checkpoint_seq));
        } catch(e){
            logger.error(nodeUtil.format('StateAnchorPublisher: anchor for ' + row.chain + '/' + row.network + ' @ ' +
                          row.block_index + ' broadcast as ' + txid + ' but its durable sent marker could not be ' +
                          'persisted; the intent still holds the row, so nothing re-broadcasts. Error:', e && e.message));
        }
    },

    // Withdraw an intent for a send that DEFINITIVELY never went out (a pre-send build,
    // sign, ceiling or RPC-rejection failure). Without this a routine failure would hold
    // the checkpoint for the whole TTL, which is worse than the replay risk the marker
    // exists for. Scoped `AND sent_at IS NULL` so a confirmed marker can never be deleted
    // by a late or misordered call. Logged, never thrown: leaving the row is fail-closed.
    async withdrawAnchorIntent(row){
        try {
            await this.db.deleteAnchorPublishedCheckpoint(row.chain, row.network, Number(row.checkpoint_seq));
        } catch(e){
            logger.warn('StateAnchorPublisher: could not withdraw the broadcast intent for ' + row.chain + '/' +
                         row.network + ' @ ' + row.block_index + '; it will hold the row until the TTL expires: ' +
                         (e && e.message));
        }
    },

    // Durable at-most-once for the ARCHIVE spend (anchor_published_archives).
    //
    // Same failure and the same remedy as the checkpoint marker above, with one
    // structural difference that changes the key. A checkpoint is re-selected under its
    // OWN identity (chain, network, checkpoint_seq) after a crash, so its marker can be
    // read by that identity. An archive is not: the rows re-select as "pending" and the
    // rebuild draws a FRESH batch_seq (two v1 anchors sharing one seq corrupt chunk
    // reassembly), so a marker read by batch_seq could never match the round it has to
    // stop. The hold is therefore per-NETWORK over any UNSETTLED intent, and settled_at
    // is what keeps a finished round from blocking the next one.
    //
    // The archive path DOES have a mined-state fallback, just not through
    // getanchoraction, which serves CHECKPOINT_VERSIONS only. getarchiveanchor answers
    // "did we already publish THIS batch" from the batch's own content (checkpoint
    // identity + crc + count + author), and publishArchive passes it to
    // broadcastWithRetry as the head's existsCheck via findExistingArchiveAnchor, plus
    // findExistingArchiveChunk per continuation chunk. What that lookup cannot see is a
    // send that has not mined yet: it answers from parsed on-chain actions, so an archive
    // still in the DOGE mempool reads as definitively absent. This marker covers exactly
    // that window, together with the ambiguous-send defer, and it is read before the
    // batch seq is even drawn, which is why the hold is unconditional within the TTL
    // rather than conditional on a mined lookup.

    // Read the newest unsettled marker for a network, or null when none exists. Throws on
    // a DB error so the caller FAILS CLOSED (rows stay pending) rather than spending on a
    // batch whose publish history it could not read.
    async getLiveArchiveIntent(network){
        let rows = await this.db.getAnchorPublishedArchive(String(network));
        return (rows && rows.length > 0) ? rows[0] : null;
    },

    // Durably arm archive-broadcast intent before the v1 send. The upsert form matches the
    // checkpoint twin: the caller reaches this only when no unexpired intent holds the
    // network, so an existing row for this seq is a stale one and the write is this round
    // opening its own window. Throws on a DB error so the caller fails closed.
    async recordArchiveIntent(network, batchSeq){
        await this.db.setAnchorPublishedArchive(String(network), Number(batchSeq));
    },

    // Record that the v1 broadcast returned a txid. Logged, never thrown: the DOGE fee is
    // already spent, and an intent-only row left behind makes the next round HOLD instead
    // of re-archiving, which is the fail-safe direction.
    async markArchiveSent(network, batchSeq, txid){
        try {
            await this.db.updateAnchorPublishedArchiveByNetwork(txid || null, String(network), Number(batchSeq));
        } catch(e){
            logger.error(nodeUtil.format('StateAnchorPublisher: archive batch ' + batchSeq + ' broadcast as ' + txid +
                          ' but its durable sent marker could not be persisted; the intent still holds the ' +
                          'network, so nothing re-archives. Error:', e && e.message));
        }
    },

    // Close the window once the round's bookkeeping has landed, so the next round is not
    // blocked for the full TTL by a batch that completed normally. Scoped `AND sent_at IS
    // NOT NULL` so it can only ever close a marker whose broadcast actually returned.
    // Logged, never thrown: an unsettled marker costs latency (the TTL), never money.
    async settleArchiveIntent(network, batchSeq){
        try {
            await this.db.updateAnchorPublishedArchiveByNetworkAndBatchSeq(String(network), Number(batchSeq));
        } catch(e){
            logger.warn('StateAnchorPublisher: could not settle the archive intent for batch ' + batchSeq +
                         '; it will hold ' + network + ' archiving until the TTL expires: ' + (e && e.message));
        }
    },

    // Withdraw an intent for a v1 send that DEFINITIVELY never went out (a pre-send build,
    // sign, ceiling or RPC-rejection failure). Without this a routine failure would stall
    // archiving for the whole TTL, which is worse than the replay risk the marker exists
    // for. Scoped `AND sent_at IS NULL` so a confirmed marker can never be deleted by a
    // late or misordered call. Logged, never thrown: leaving the row is fail-closed.
    async withdrawArchiveIntent(network, batchSeq){
        try {
            await this.db.deleteAnchorPublishedArchive(String(network), Number(batchSeq));
        } catch(e){
            logger.warn('StateAnchorPublisher: could not withdraw the archive broadcast intent for batch ' +
                         batchSeq + '; it will hold ' + network + ' archiving until the TTL expires: ' +
                         (e && e.message));
        }
    },

    // ----- Retention for the two anchor marker tables -----
    //
    // Both tables appended one row per DOGE-spending broadcast and removed one only on
    // a definitive pre-send failure (withdrawAnchorIntent / withdrawArchiveIntent,
    // both `sent_at IS NULL`), so a confirmed marker persisted for the life of the
    // deployment while the oracle_published_rounds sibling was swept.
    //
    // Two invariants dominate these DELETEs, both load-bearing on a money-bearing path:
    //
    //   1. `sent_at IS NOT NULL` is mandatory. A sent_at NULL row that survived is the
    //      AMBIGUOUS-send record: publishPendingCheckpoints deliberately keeps the
    //      intent when the failure could have reached the DOGE node (the `if(!(e &&
    //      e.anchorAmbiguousSend))` guard), and the empty-txid path keeps it too. That
    //      row is the only durable trace that DOGE may already have paid, so it is
    //      retained forever regardless of age, exactly as the oracle sibling retains
    //      its quarantine rows.
    //   2. The cutoff never rises above `now - anchorIntentTtlMs`. This is the
    //      re-presentability floor and it is exact rather than estimated, because the
    //      TTL is the SAME quantity the read paths already measure. Every read of
    //      either table goes through anchorIntentHolds, which is false for any marker
    //      whose intent_at is older than the TTL, so a row this DELETE can reach is one
    //      that already changes no decision. anchor_published_archives is stricter
    //      still: getLiveArchiveIntent only ever selects `settled_at IS NULL`, so a
    //      settled row is not read at all.
    //
    // The cutoff is measured on intent_at, not sent_at, because intent_at is the column
    // anchorIntentHolds measures and the one the floor is expressed in.
    //
    // Returns the total number of rows deleted across both tables. Throws on a DB
    // error; the caller treats a retention failure as non-fatal.
    async pruneAnchorMarkers(){
        if(!this.db) return 0;
        if(!this.anchorMarkerRetentionMs || this.anchorMarkerRetentionMs <= 0) return 0;

        // Invariant 2, as a hard clamp rather than a warning: an anchor marker pruned
        // inside the hold window lets the next flush rebuild a second PSBT for a
        // checkpoint DOGE may already have paid for.
        let ttlFloorMs = (Number.isFinite(this.anchorIntentTtlMs) && this.anchorIntentTtlMs > 0)
            ? this.anchorIntentTtlMs * ANCHOR_MARKER_RETENTION_TTL_SAFETY
            : 0;
        let windowSec = Math.ceil(Math.max(this.anchorMarkerRetentionMs, ttlFloorMs) / 1000);

        // DB-clock arithmetic on both sides: intent_at is written by CURRENT_TIMESTAMP,
        // so a Node-side cutoff would fold host/DB clock skew into the window.
        // Checkpoints first, then archives, the order the sweep has always run in; each
        // table has its own fixed statement, so no table name is assembled into SQL here.
        let deleted = 0;
        let res = await this.db.deleteAnchorPublishedCheckpointsSentBefore(windowSec);
        deleted += (res && res.affectedRows) ? Number(res.affectedRows) : 0;
        res = await this.db.deleteAnchorPublishedArchivesSentBefore(windowSec);
        deleted += (res && res.affectedRows) ? Number(res.affectedRows) : 0;
        if(deleted > 0){
            this.anchorMarkersPruned += deleted;
            logger.info('StateAnchorPublisher: anchor-marker retention pruned ' + deleted +
                        ' confirmed marker row(s) older than ' + windowSec + 's (intent-only rows, which are ' +
                        'the ambiguous-send record, are never pruned)');
        }
        return deleted;
    },

    // Housekeeping hook for the retention sweep. Fire-and-forget with the rejection
    // swallowed: bounding the marker tables must never stall, fail or retry a flush
    // that has already spent DOGE.
    sweepAnchorMarkerRetention(){
        if(!this.db || !this.anchorMarkerRetentionMs) return;
        this._retentionSweep = this.pruneAnchorMarkers()
            .catch(e => {
                logger.warn('StateAnchorPublisher: anchor-marker retention sweep failed ' +
                             '(the marker tables keep growing until it succeeds): ' + (e && e.message));
                return 0;
            });
    }

};
