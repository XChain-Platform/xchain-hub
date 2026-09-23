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
 * AttestationBatchPublisher: choosing and building a window
 *
 * The catch-up floor, the closed windows still owed, one window's path from its
 * mirror rows to a signed, encoded batch, and the row normalization every canonical
 * reads. Installed on AttestationBatchPublisher.prototype by
 * src/attestation/batch_publisher.js.
 *
 ********************************************************************/

'use strict';

const abw = require('../../lib/attest_batch_wire.js');
// Picks the row field set the encoded body carries from the batch's own anchor (signing.js).
const { isAdmissionEra } = require('../../consensus/gates/mirror_admission_gate.js');
const { MAX_CATCHUP_WINDOWS } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // The oldest window this hub will consider. A hub with no markers at all is NEW, and
    // backfilling windows that closed before it existed would publish empty coverage
    // heads for hours it has no rows for, so it starts at the window in progress when it
    // booted. A hub that HAS markers floors on its OLDEST one: everything below that
    // predates its participation, and everything above is decided per window by
    // pendingWindows's own marker lookup. Null means no floor, which is what a direct
    // sweep with no start() gets.
    //
    // THE FLOOR IS NOT A COMPLETION WATERMARK, and deriving it from the NEWEST marker
    // made it one. sweep() walks on past a window publishWindow could not do (a failed
    // anchor read, no signing quorum, the spend guard, or simply not this hub's rank
    // yet), so a newer window can carry a marker while an older one carries none. A floor
    // at newest+windowS then reads that newer marker as proof the older window resolved,
    // and the restart drops it below the floor forever even though it is still inside the
    // catch-up horizon. Flooring on the oldest marker keeps the anti-backfill job the
    // comment above describes and makes no claim about completion.
    async resolveFloorWindow(){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function') return this.windowStartFor(this.nowSeconds());
        let rows = await db.getAttestPublishedBatch(this.network);
        let oldest = (rows && rows.length) ? Number(rows[0].oldest) : NaN;
        let newest = (rows && rows.length) ? Number(rows[0].newest) : NaN;
        // Read by pendingWindows only to tell a routine catch-up from a coverage GAP: a
        // pending window BELOW a marker this hub already holds is one the sweep left
        // behind, and without this marker that condition is silent.
        this._newestMarkerWindow = (Number.isFinite(newest) && newest > 0) ? newest : null;
        if(Number.isFinite(oldest) && oldest > 0) return oldest;
        return this.windowStartFor(this.nowSeconds());
    },

    // The closed windows with no durable marker, oldest first, bounded. `age` is how
    // many windows have closed since: it is the rank a hub must be at or below to
    // publish, which is what staggers the fallback when the elected leader is dark.
    async pendingWindows(nowSec){
        let current = this.windowStartFor(nowSec);
        let out = [];
        for(let i = MAX_CATCHUP_WINDOWS; i >= 1; i--){
            let start = current - i * this.windowS;
            if(start < 0) continue;
            if(this._floorWindow !== null && start < this._floorWindow) continue;
            let marker = await this.getMarker(start);
            if(marker && String(marker.status) !== 'intent') continue;   // sent, landed or dead-lettered
            if(marker){
                // Intent with no outcome: a crash between the send and the sent marker.
                // Never re-published automatically, because the transaction may be in a
                // mempool this hub cannot see and a second head is a second fee.
                if(!this._quarantined.has(start)){
                    this._quarantined.add(start);
                    this.stats.windowsQuarantined++;
                    logger.error('AttestationBatchPublisher: window ' + start + ' carries a publish-intent ' +
                        'marker with no outcome; its on-chain state is unknown after a crash. It will NOT ' +
                        're-publish automatically. Operator: check the DOGE address for an ATTEST v5 batch ' +
                        'covering this window and replay by hand if none landed.');
                }
                continue;
            }
            // A pending window older than a marker this hub already holds is a window an
            // earlier sweep gave up on and walked past. Say so once per window: nothing
            // else reports it, and only the oldest-marker floor keeps it retryable.
            if(this._newestMarkerWindow !== null && start < this._newestMarkerWindow &&
               !this._coverageGaps.has(start)){
                this._coverageGaps.add(start);
                this.stats.coverageGapsDetected++;
                logger.error('AttestationBatchPublisher: window ' + start + ' has no batch marker while ' +
                    'window ' + this._newestMarkerWindow + ' does; an earlier sweep left it behind. It is ' +
                    'being retried now, but a window that falls out of the ' + MAX_CATCHUP_WINDOWS +
                    '-window catch-up horizon needs a manual replay.');
            }
            out.push({ windowStart: start, age: i - 1 });
        }
        return out;
    },

    // Publish one window, or leave it for a later attempt. Returns true only when a
    // batch for this window actually went out.
    async publishWindow(windowStart, age){
        let windowEnd = this.windowEndFor(windowStart);

        let rows;
        try {
            rows = await this.selectWindowRows(windowStart, windowEnd);
        } catch(e){
            logger.warn('AttestationBatchPublisher: cannot read window ' + windowStart +
                         ' from attestation_responses (' + (e && e.message) + '); deferring');
            this.stats.windowsDeferred++;
            return false;
        }

        if(rows.length > abw.ATTEST_BATCH_MAX_ROWS){
            this.deadLetterOverCap(windowStart, windowEnd, rows.length);
            await this.recordDeadLetter(windowStart, windowEnd, rows.length);
            return false;
        }

        let anchor = await this.resolveAnchor();
        if(anchor === null){
            this.warnNoAnchor(windowStart);
            this.stats.windowsDeferred++;
            return false;
        }

        let window = {
            network:          this.network,
            window_start:     windowStart,
            window_end:       windowEnd,
            row_count:        rows.length,
            btc_block_height: anchor,
            rows:             rows
        };
        let batchKey = abw.computeBatchKey(window);

        // Publisher election, before any signing round: five hubs holding the same rows
        // would otherwise pay five fees for five identical batches. Rank is hash order
        // over the same capability set the batch is judged against, keyed on the batch
        // key so the election is per window rather than per hub.
        let election = await this.electionRank(anchor, batchKey);
        if(election === null){
            logger.warn('AttestationBatchPublisher: cannot resolve the attestation set at anchor ' + anchor +
                         '; deferring window ' + windowStart);
            this.stats.windowsDeferred++;
            return false;
        }
        // The set this batch is judged against goes into the mirror NOW, before any
        // rank decision: a follower that never becomes leader still mirrors it, and an
        // off-BTC verifier reads whichever hub it follows.
        await this.persistAttestationSnapshot(anchor);
        if(election.rank > age){
            // Not this hub's turn yet. A window nobody lands is picked up by the next
            // rank one window later, so a dark leader costs a window's coverage a delay
            // rather than the window itself.
            return false;
        }

        return await this.signAndBroadcastWindow(window, batchKey);
    },

    // OVER-ROWS IS A DEAD LETTER, NOT A TRUNCATION. The row cap is consensus: a
    // batch carrying more rows is invalid on every node, and silently dropping the
    // overflow would publish a head whose coverage claim is false. So the window is
    // recorded loudly and left for an operator, and the rows stay in the mirror.
    deadLetterOverCap(windowStart, windowEnd, rowCount){
        this.deadLetter({ window_start: windowStart, window_end: windowEnd, row_count: rowCount },
            'row count ' + rowCount + ' exceeds ATTEST_BATCH_MAX_ROWS (' + abw.ATTEST_BATCH_MAX_ROWS + ')');
        logger.error('AttestationBatchPublisher: CRITICAL - window ' + windowStart + '-' + windowEnd +
            ' holds ' + rowCount + ' terminal responses, over the ' + abw.ATTEST_BATCH_MAX_ROWS +
            '-row consensus cap; the window is dead-lettered to ' + this.deadLetterPath +
            ' and NOT published. Chain coverage for this window is missing until an operator splits it.');
    },

    // The second half of publishWindow, from the signing round on: a window this hub
    // has decided it is this one's turn to publish either reaches a quorum and goes out
    // as encoded wires, or leaves the table untouched for a later attempt.
    async signAndBroadcastWindow(window, batchKey){
        let windowStart = window.window_start;
        let windowEnd   = window.window_end;
        let rows        = window.rows;

        let signed = await this.collectBatchSignatures(window, batchKey);
        if(!signed.met){
            // NOTHING IS PUBLISHED WITHOUT A QUORUM, and the window is deliberately left
            // with no marker: the rows are unchanged in the table, so a later attempt
            // rebuilds byte-identical content and asks again.
            this.stats.windowsDeferred++;
            logger.warn('AttestationBatchPublisher: window ' + windowStart + '-' + windowEnd +
                         ' reached no batch quorum; it stays unpublished and is retried');
            return false;
        }
        window.sigs = signed.sigs;

        let encoded = abw.encodeAttestBatch(window, isAdmissionEra);
        if(!encoded.ok){
            this.deadLetter({ window_start: windowStart, window_end: windowEnd,
                               row_count: rows.length, reason: encoded.reason },
                'wire encoding refused the window: ' + encoded.status);
            logger.error('AttestationBatchPublisher: CRITICAL - window ' + windowStart + '-' + windowEnd +
                ' cannot be encoded (' + encoded.status + '); dead-lettered to ' + this.deadLetterPath +
                ' and NOT published. Chain coverage for this window is missing.');
            await this.recordDeadLetter(windowStart, windowEnd, rows.length);
            return false;
        }

        // Claim at broadcastWindow's existing pre-send intent point. The unique
        // (network, window_start) marker is the cross-publisher mutex: only the INSERT
        // that creates it may send. A marker read followed by a send is not sufficient,
        // because several validators can all complete that read before any one sends.
        let claimed = Object.create(this);
        claimed.recordIntent = async (candidate, key) => {
            if(!(await this.claimWindowForBroadcast(candidate, key))){
                let error = new Error('window already has a durable publication claim');
                error.code = 'ATTEST_BATCH_WINDOW_CLAIMED';
                throw error;
            }
        };
        return await this.broadcastWindow.call(claimed, window, batchKey, encoded);
    },

    // Atomically acquire the durable pre-send marker. setAttestPublishedBatchByNetwork
    // uses INSERT with a duplicate-key no-op, so affectedRows separates the sole
    // creator from every competing publisher. This runs inside broadcastWindow after
    // its pipeline, balance and spend reservations have passed, preserving the rule
    // that a window unable to attempt a send leaves no intent marker.
    async claimWindowForBroadcast(window, batchKey){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function')
            throw new Error('no hub DB for durable batch-window claim');

        // A tracking row is a coverage floor, not a publication claim. The guarded
        // delete cannot remove an intent or outcome installed by a competing path.
        await db.deleteAttestPublishedBatch(this.network, window.window_start, 'tracking');
        let result = await db.setAttestPublishedBatchByNetwork(
            this.network, window.window_start, window.window_end,
            batchKey, window.row_count, 'intent');
        return !!(result && Number(result.affectedRows) === 1);
    },

    // ------------------------------------------------------------ the mirror read

    // The window's terminal rows, in the applier's own order. Every codec row field is
    // selected by name from the codec's own list, so a field added to the wire cannot
    // be silently absent here; the statement and that ordering argument now live in
    // db.findAttestationResponsesInBatchWindow.
    //
    // One row over ATTEST_BATCH_MAX_ROWS is read on purpose, so the caller can tell a
    // full window from one that overflows the cap.
    //
    // NORMALIZED ON READ. The driver may hand a BIGINT back as a number, a string or a
    // BigInt depending on how the pool is configured, and the row goes straight into
    // JSON.stringify inside the signed canonical, where '120' and 120 are different
    // bytes. So every numeric column is coerced here, once, and every text column is
    // stringified; a verifier rebuilding from the wire sees the same spellings.
    async selectWindowRows(windowStart, windowEnd){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function') throw new Error('no hub DB');
        let rows = await db.findAttestationResponsesInBatchWindow(
            this.network, windowStart, windowEnd, abw.ATTEST_BATCH_MAX_ROWS + 1);
        return (rows || []).map(r => this.normalizeRow(r));
    },

    normalizeRow(r){
        let intOrNull = (v) => {
            if(v === null || v === undefined) return null;
            let n = Number(v);
            return Number.isFinite(n) ? Math.trunc(n) : null;
        };
        return {
            network:              String(r.network),
            request_id:           String(r.request_id).toLowerCase(),
            request_action_index: intOrNull(r.request_action_index),
            request_block_index:  intOrNull(r.request_block_index),
            provider_id:          String(r.provider_id == null ? '' : r.provider_id),
            status:               String(r.status),
            response_payload:     String(r.response_payload == null ? '' : r.response_payload),
            response_hash:        String(r.response_hash).toLowerCase(),
            meta:                 r.meta == null ? '' : String(r.meta),
            effective_time:       intOrNull(r.effective_time),
            // Carried so an admission-era batch signs the row's real admission height; a
            // row read without it would sign null and rebuild on chain as a legacy row.
            // Below the activation the wire drops the field, so this changes no bytes there.
            admit_block_btc:      intOrNull(r.admit_block_btc),
            signer_pubkeys:       String(r.signer_pubkeys == null ? '[]' : r.signer_pubkeys),
            signatures:           String(r.signatures == null ? '[]' : r.signatures),
            widen:                intOrNull(r.widen) || 0
        };
    },

    // Project onto the codec's field list, in the codec's order. Called on the way into
    // every canonical so the publisher and the verifier serialize the same object even
    // if a read ever hands back a column the wire does not carry.
    wireRows(rows){
        return rows.map(r => {
            let out = {};
            for(let f of abw.ATTEST_BATCH_ROW_FIELDS) out[f] = r[f];
            return out;
        });
    }

};
