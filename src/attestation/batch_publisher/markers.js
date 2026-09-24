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
const { MAX_CATCHUP_WINDOWS } = require('./constants.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

// An age in seconds as the two coarsest units that still locate it. A four-day marker
// and a four-hour one have to read differently at a glance, because the age is the
// whole difference between an operator action item and a reconciliation record.
function formatAge(seconds){
    let secs = Math.max(0, Math.floor(Number(seconds) || 0));
    let d = Math.floor(secs / 86400);
    let h = Math.floor((secs % 86400) / 3600);
    let m = Math.floor((secs % 3600) / 60);
    if(d > 0) return d + 'd' + h + 'h';
    if(h > 0) return h + 'h' + m + 'm';
    return m + 'm' + (secs % 60) + 's';
}

module.exports = {

    // ------------------------------------------------------------ durable markers

    async getMarker(windowStart){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function') return null;
        let rows = await db.findAttestPublishedBatchesByNetwork(this.network, windowStart);
        let marker = (rows && rows.length) ? rows[0] : null;
        // `tracking` records when this hub began owing coverage; it is not an outcome
        // for that window. Returning it as absent keeps the ordinary retry path live.
        return marker && String(marker.status) === 'tracking' ? null : marker;
    },

    // The oldest window a marker can still matter for: pendingWindows builds candidates
    // only at current - 1..MAX_CATCHUP_WINDOWS. The current window only ever advances, so
    // a floor taken at boot cannot exclude a window a later sweep would consider.
    catchupFloorWindow(currentWindow){
        return Number(currentWindow) - MAX_CATCHUP_WINDOWS * this.windowS;
    },

    // Quarantine the windows a crash left with an intent and no outcome, bounded to the
    // catch-up horizon: an intent-only row is remembered so the sweep refuses it once
    // rather than per pass, and a window the sweep cannot propose needs no refusal.
    //
    // `nowSec` is the clock the horizon is measured from, defaulting to this hub's.
    async hydrateMarkers(nowSec){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function') return;
        let current = this.windowStartFor(Number.isFinite(nowSec) ? Number(nowSec) : this.nowSeconds());
        let floor   = this.catchupFloorWindow(current);
        let rows = await db.findAttestPublishedBatchesByNetworkAndStatusSince(
            this.network, 'intent', floor);
        let agedRows = await db.getAttestPublishedBatchesCountByNetworkAndStatusBefore(
            this.network, 'intent', floor);
        let agedSummary = (agedRows && agedRows[0]) || {};
        if(!Number.isFinite(Number(agedSummary.count))){
            let oldest = Number(agedSummary.oldest);
            agedSummary.count = agedSummary.oldest !== null &&
                agedSummary.oldest !== undefined && Number.isFinite(oldest) && oldest < floor ? 1 : 0;
        }

        let live = [];
        for(let r of (rows || [])){
            let start = Number(r.window_start);
            // A row whose window_start does not read as a number cannot be matched against
            // any window the sweep proposes, so it is neither quarantined nor counted.
            if(!Number.isFinite(start)) continue;
            if(start >= floor) live.push(start);
        }
        live.sort((a, b) => a - b);
        for(let start of live) this._quarantined.add(start);
        this.reportHydratedMarkers(live, agedSummary, current);

        // Absence on its own cannot separate "the publisher has never run" from "the
        // publisher ran but produced no outcome". Mark the in-progress window as the
        // durable coverage floor so a later table read can tell them apart. The insert
        // is deliberately a no-op on an existing terminal row.
        if(live.length === 0 && (Number(agedSummary.count) || 0) === 0)
            await db.setAttestPublishedBatchByNetwork(
                this.network, current, this.windowEndFor(current), null, 0, 'tracking');
    },

    // Two kinds of marker at two severities. A window inside the horizon is an action item
    // and names its age, because a count with no age leaves a four-day-old marker reading
    // like a fresh one; a window below it is a record and must not read as an alarm.
    reportHydratedMarkers(live, agedSummary, currentWindow){
        if(live.length > 0)
            logger.error('AttestationBatchPublisher: ' + live.length + ' window(s) carry a ' +
                'publish-intent marker with no outcome; they are NOT re-published automatically. ' +
                'Operator: verify each on chain and replay by hand if absent. Windows: ' +
                live.map(s => s + ' (' + this.markerAge(s, currentWindow) + ')').join(', ') + '.');
        let agedCount = Number(agedSummary.count) || 0;
        if(agedCount > 0)
            logger.info('AttestationBatchPublisher: ' + agedCount + ' publish-intent marker(s) lie below ' +
                'the ' + MAX_CATCHUP_WINDOWS + '-window catch-up horizon and are NOT an action item: no ' +
                'sweep can propose those windows again. Oldest ' +
                this.markerAge(agedSummary.oldest, currentWindow) + ', newest ' +
                this.markerAge(agedSummary.newest, currentWindow) + '.');
    },

    // A marker's age in the two units that decide what to do with it: windows closed
    // since, which is what the catch-up horizon is measured in, and wall-clock, which is
    // what an operator reading the line has.
    markerAge(windowStart, currentWindow){
        let secs    = Math.max(0, Number(currentWindow) - Number(windowStart));
        let windows = this.windowS > 0 ? Math.round(secs / this.windowS) : 0;
        return windows + ' window(s) / ' + formatAge(secs) + ' old';
    },

    // A tracking row becomes the pre-send intent; an existing outcome row is left
    // exactly as it is, so a replay cannot downgrade `sent` or `landed` to intent.
    async recordIntent(window, batchKey){
        let db = this.hubDb();
        if(!db || typeof db.doQuery !== 'function') return;
        // A tracking row licenses no spend and must become the real pre-send marker.
        // Delete it under a status guard before the insert. A concurrent landed row is
        // untouched, and the intent insert's duplicate-key no-op preserves it.
        await db.deleteAttestPublishedBatch(this.network, window.window_start, 'tracking');
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
