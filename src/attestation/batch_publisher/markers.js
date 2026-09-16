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
 * AttestationBatchPublisher: durable markers and files
 *
 * The per-window marker rows that make publishing at-most-once, and the buffer and
 * dead-letter files an operator replays from. Installed on
 * AttestationBatchPublisher.prototype by src/attestation/batch_publisher.js.
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // ------------------------------------------------------------ durable markers

    async getMarker(windowStart){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function') return null;
        let rows = await db.findAttestPublishedBatchesByNetwork(this.network, windowStart);
        return (rows && rows.length) ? rows[0] : null;
    },

    // Load every window this hub has already resolved. Only the intent-only rows need
    // remembering in memory: they are the ones the sweep must refuse, once each rather
    // than once per pass.
    async hydrateMarkers(){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function') return;
        let rows = await db.findAttestPublishedBatchesByNetworkAndStatus(this.network, 'intent');
        for(let r of (rows || [])) this._quarantined.add(Number(r.window_start));
        if(this._quarantined.size > 0)
            logger.error('AttestationBatchPublisher: ' + this._quarantined.size + ' window(s) carry a ' +
                'publish-intent marker with no outcome; they are NOT re-published automatically. ' +
                'Operator: verify each on chain and replay by hand if absent.');
    },

    // Idempotent: an existing row for the window is left exactly as it is, so a replay
    // can never downgrade a `sent` or `landed` marker back to an intent.
    async recordIntent(window, batchKey){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function') return;
        await db.setAttestPublishedBatchByNetwork(this.network, window.window_start, window.window_end, batchKey, window.row_count, 'intent');
    },

    // Withdraw an intent-only marker. The status guard is the whole safety of the
    // statement: it can only ever remove a row that says "no outcome recorded", so it
    // cannot erase evidence of a window this hub or the federation has paid for.
    async clearIntent(windowStart){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function') return;
        await db.deleteAttestPublishedBatch(this.network, windowStart, 'intent');
    },

    // The DOGE is already spent by the time this runs, so a failure here is logged
    // rather than thrown: the intent row means a restart quarantines the window instead
    // of paying for it twice.
    async markSent(windowStart, txid, rowCount){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function') return;
        try {
            await db.updateAttestPublishedBatch('sent', txid, rowCount, this.network, windowStart, 'intent');
        } catch(e){
            logger.error('AttestationBatchPublisher: window ' + windowStart + ' was broadcast but its ' +
                'durable sent marker could not be persisted; a restart will QUARANTINE (not re-publish) it. ' +
                'Operator: confirm the txid on chain. Error: ' + (e && e.message));
        }
    },

    async recordDeadLetter(windowStart, windowEnd, rowCount){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function') return;
        this.stats.windowsDeadLettered++;
        try {
            await db.setAttestPublishedBatchByNetworkAndWindowStart(this.network, windowStart, windowEnd, rowCount, 'deadletter');
        } catch(e){
            logger.error('AttestationBatchPublisher: could not record the dead-letter marker for window ' +
                          windowStart + ': ' + (e && e.message));
        }
    },

    // Called by the receive half when a batch for this window is parsed off DOGE and
    // pushed back (D72). Authoritative for the WHOLE federation: any hub's batch landing
    // covers the window, so a hub that never published one stops considering it.
    async recordLandedWindow(windowStart, windowEnd, txidOrNull, rowCount){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function') return;
        this.stats.landedRecorded++;
        this._quarantined.delete(Number(windowStart));
        await db.setAttestPublishedBatchByNetworkAndWindowStartAndWindowEnd(this.network, windowStart, windowEnd, rowCount, txidOrNull, 'landed');
    },

    // ------------------------------------------------------------ the files

    // What a window was built from, appended when it publishes. Not a queue: the
    // durable marker is the at-most-once guard, and this is the operator's copy of the
    // content, which the mirror table would otherwise have to be re-derived from.
    bufferWindow(window, batchKey, encoded){
        this.append(this.bufferPath, {
            window_start: window.window_start, window_end: window.window_end,
            batch_key: batchKey, row_count: window.row_count,
            btc_block_height: window.btc_block_height,
            total_chunks: encoded.totalChunks, inflated_bytes: encoded.inflatedBytes,
            request_ids: window.rows.map(r => r.request_id), at: Date.now()
        });
    },

    // Append-only give-up sink, never truncated. Best-effort: a write failure here must
    // not stop the CRITICAL log or the durable marker that keeps the window from looping.
    deadLetter(record, reason){
        this.append(this.deadLetterPath, Object.assign({}, record,
            { deadLetteredAt: Date.now(), reason: reason }));
    },

    append(file, record){
        try {
            let fd = fs.openSync(file, 'a');
            fs.writeSync(fd, JSON.stringify(record) + '\n');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
        } catch(e){
            logger.error('AttestationBatchPublisher: failed to append to ' + file + ': ' + (e && e.message));
        }
    }

};
