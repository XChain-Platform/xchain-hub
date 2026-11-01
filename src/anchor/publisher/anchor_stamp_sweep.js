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
 * ANCHOR publisher - abandoned transaction stamp sweep
 *
 * A successful broadcast stamps state_checkpoints immediately, while the
 * transaction is still in the DOGE mempool. If that transaction later disappears,
 * the stamp would otherwise suppress the checkpoint forever. The durable publisher
 * marker proves which stamps came from this hub and records the DOGE height at send
 * time. Once a full reorg-depth horizon has passed, the encoder can distinguish a
 * transaction still in the mempool or chain from one unknown to both.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability');
const logger = getLogger();

// Bounds on one sweep. flush() holds its _flushing latch across the sweep, so an unbounded
// serial walk (rows times encoder latency) let one slow encoder hold the latch past a
// rank-wake tick. Each txid is looked up once (a bundle stamps one row per section), at
// most MAX_LOOKUPS txids per sweep, and nothing is started or awaited past BUDGET_MS. A
// rotating cursor lets the next sweep resume where a capped one stopped. Instance fields
// anchorStampSweepMaxLookups and anchorStampSweepBudgetMs override the defaults.
const DEFAULT_SWEEP_MAX_LOOKUPS = 32;
const DEFAULT_SWEEP_BUDGET_MS = 60000;
const TIMED_OUT = Symbol('anchor-stamp-sweep-timed-out');

function positiveIntOr(value, fallback){
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

// Resolve with the lookup's result, or TIMED_OUT once ms pass; a late reply is dropped.
function settleWithin(lookup, ms){
    let timer;
    const deadline = new Promise(resolve => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
        if(timer.unref) timer.unref();
    });
    return Promise.race([lookup, deadline]).finally(() => clearTimeout(timer));
}

// Order txids from the cursor onward: just after the last txid looked up, or, when that txid
// left the set (its stamps were cleared), at the position it held, so no tail is starved.
function rotateFromCursor(txids, cursor){
    if(!cursor || txids.length === 0) return txids;
    const at = txids.indexOf(cursor.txid);
    const start = at >= 0 ? (at + 1) % txids.length : cursor.index % txids.length;
    return txids.slice(start).concat(txids.slice(0, start));
}

module.exports = {

    // flush() re-entered while an earlier flush still holds _flushing (a rank-wake or interval
    // tick landing inside a long sweep). The tick is only a delayed retry, but it was silent;
    // count it for getAnchorStats and log how long the latch has been held.
    noteFlushSkippedInFlight(){
        this.flushesSkippedInFlight = (this.flushesSkippedInFlight || 0) + 1;
        const heldMs = this._flushStartedAt ? Date.now() - this._flushStartedAt : null;
        logger.warn('StateAnchorPublisher: flush skipped, the previous flush is still running' +
                    (heldMs === null ? '' : ' after ' + heldMs + 'ms') +
                    ' (' + this.flushesSkippedInFlight + ' skipped so far)');
        return { anchored: [], archive: 'none', skipped: 'already_flushing' };
    },

    async readAnchorStampSweepTip(){
        try {
            const result = await this.indexerCall('DOGE', 'getlatestblock', {});
            const raw = result && result.block_index;
            const tip = Number(raw);
            if(raw === null || raw === undefined || raw === '' ||
               !Number.isSafeInteger(tip) || tip < 0) return null;
            return tip;
        } catch(err){
            logger.warn('StateAnchorPublisher: anchor stamp sweep could not read the DOGE tip: ' +
                        (err && err.message));
            return null;
        }
    },

    async sweepAnchorStamps(){
        const signer = this.resolveSigner();
        const encoder = signer && signer.encoder;
        if(!encoder || typeof encoder.getTxStatus !== 'function') return 0;

        const rows = await this.readAnchorStampSweepRows();
        if(!rows) return 0;

        // A bundle's reward round is the highest snapshot block among the sections its txid stamps.
        const bundleBlocks = new Map();
        const rowsByTxid = new Map();
        for(const row of rows){
            const txid = String(row.txid);
            if(!rowsByTxid.has(txid)) rowsByTxid.set(txid, []);
            rowsByTxid.get(txid).push(row);
            const block = Number(row.snapshot_block);
            if(row.snapshot_block === null || row.snapshot_block === undefined || !Number.isSafeInteger(block)) continue;
            if(!bundleBlocks.has(txid) || block > bundleBlocks.get(txid)) bundleBlocks.set(txid, block);
        }

        const vanished = await this.lookupAnchorStampTxids(encoder, Array.from(rowsByTxid.keys()));
        let cleared = 0;
        const clearedTxids = [];
        for(const txid of vanished){
            const n = await this.clearAnchorStampRows(txid, rowsByTxid.get(txid));
            cleared += n;
            if(n > 0) clearedTxids.push(txid);
        }
        // Retract the hub-local reward each swept bundle wrote at broadcast, since it never mined.
        for(const txid of clearedTxids){
            if(bundleBlocks.has(txid)) await this.retractSweptBundleReward(txid, bundleBlocks.get(txid));
        }
        return cleared;
    },

    // This hub's stamps buried past the reorg horizon, or null when the tip or markers are unreadable.
    async readAnchorStampSweepRows(){
        const tip = await this.readAnchorStampSweepTip();
        if(tip === null || tip < this.anchorStampReorgDepth) return null;
        try {
            return (await this.db.findOwnAnchorCheckpointStamps(tip - this.anchorStampReorgDepth)) || [];
        } catch(err){
            logger.warn('StateAnchorPublisher: anchor stamp sweep could not read publisher markers: ' +
                        (err && err.message));
            return null;
        }
    },

    // Look each txid up once, from the rotating cursor, within the lookup cap and the time
    // budget. Returns the txids the encoder reports unknown to both mempool and chain. A failed
    // lookup fails closed (the stamp stays); a lookup still pending at the budget ends the sweep.
    async lookupAnchorStampTxids(encoder, txids){
        const maxLookups = positiveIntOr(this.anchorStampSweepMaxLookups, DEFAULT_SWEEP_MAX_LOOKUPS);
        const budgetMs = positiveIntOr(this.anchorStampSweepBudgetMs, DEFAULT_SWEEP_BUDGET_MS);
        const startedAt = Date.now();
        const vanished = [];
        let looked = 0;
        for(const txid of rotateFromCursor(txids, this._anchorStampSweepCursor)){
            if(looked >= maxLookups) return vanished;
            const remaining = budgetMs - (Date.now() - startedAt);
            if(remaining <= 0) break;
            looked++;
            this._anchorStampSweepCursor = { txid, index: txids.indexOf(txid) };
            let location;
            try {
                location = await settleWithin(Promise.resolve().then(() => encoder.getTxStatus(txid)), remaining);
            } catch(err){
                logger.warn('StateAnchorPublisher: anchor stamp sweep could not locate transaction ' +
                            txid + ': ' + (err && err.message));
                continue;
            }
            if(location === TIMED_OUT){
                logger.warn('StateAnchorPublisher: anchor stamp sweep could not locate transaction ' +
                            txid + ': no reply within the ' + budgetMs + 'ms sweep budget');
                break;
            }
            if(location && location.status === 'unknown') vanished.push(txid);
        }
        if(looked < txids.length)
            logger.warn('StateAnchorPublisher: anchor stamp sweep stopped at its ' + budgetMs + 'ms budget after ' +
                        looked + ' of ' + txids.length + ' transaction(s); the next sweep resumes after the last one');
        return vanished;
    },

    // Clear every section stamp a vanished txid holds. Returns how many stamps were cleared.
    async clearAnchorStampRows(txid, rows){
        let cleared = 0;
        for(const row of rows){
            try {
                const result = await this.db.updateStateCheckpointClearStamp(
                    txid, String(row.chain), String(row.network),
                    Number(row.block_index), Number(row.checkpoint_seq));
                if(result && Number(result.affectedRows) > 0) cleared++;
            } catch(err){
                logger.warn('StateAnchorPublisher: anchor stamp sweep could not clear transaction ' +
                            txid + ': ' + (err && err.message));
            }
        }
        return cleared;
    },

    // Delete this hub's unarchived anchor_bundle row for a bundle whose transaction vanished.
    // publish_bundle.js recordOwnBundleReward writes that row when DOGE accepts the broadcast,
    // and the superseded slot is never republished, so the row would outlive its anchor and an
    // unscoped hub would archive it. Never throws: the stamp is already cleared either way.
    async retractSweptBundleReward(txid, snapshotBlock){
        const tracker = this.hub && this.hub.rewardTracker;
        const me = this.identity ? String(this.identity.getPubkeyHex()).toLowerCase() : null;
        if(!tracker || typeof tracker.withAnchorLock !== 'function' || !me) return false;
        try {
            // Keep the row while another stamp at this block may still back it (a split bundle)
            const others = await this.db.countOtherAnchorStampsAtSnapshotBlock(snapshotBlock, txid);
            if(others > 0){
                logger.info('StateAnchorPublisher: anchor stamp sweep kept the anchor_bundle reward at ' +
                            snapshotBlock + '; ' + others + ' other stamp(s) remain at that block');
                return false;
            }
            // Serialize with recordAnchorReward under the per-anchor key it locks its writes on
            const result = await tracker.withAnchorLock('anchor_bundle|' + Number(snapshotBlock),
                () => this.db.deleteUnarchivedValidatorReward(me, Number(snapshotBlock), 'anchor_bundle', 0));
            const removed = !!(result && Number(result.affectedRows) > 0);
            if(removed)
                logger.warn('StateAnchorPublisher: anchor stamp sweep retracted the anchor_bundle reward at ' +
                            snapshotBlock + ' for vanished transaction ' + txid);
            return removed;
        } catch(err){
            logger.warn('StateAnchorPublisher: anchor stamp sweep could not retract the anchor_bundle reward at ' +
                        snapshotBlock + ' for ' + txid + ': ' + (err && err.message));
            return false;
        }
    }

};
