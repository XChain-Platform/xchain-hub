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

module.exports = {

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

        const tip = await this.readAnchorStampSweepTip();
        if(tip === null || tip < this.anchorStampReorgDepth) return 0;

        let rows;
        try {
            rows = await this.db.findOwnAnchorCheckpointStamps(tip - this.anchorStampReorgDepth);
        } catch(err){
            logger.warn('StateAnchorPublisher: anchor stamp sweep could not read publisher markers: ' +
                        (err && err.message));
            return 0;
        }

        // A bundle's reward round is the highest snapshot block among the sections its txid stamps.
        const bundleBlocks = new Map();
        for(const row of rows || []){
            const block = Number(row.snapshot_block);
            if(row.snapshot_block === null || row.snapshot_block === undefined || !Number.isSafeInteger(block)) continue;
            const txid = String(row.txid);
            if(!bundleBlocks.has(txid) || block > bundleBlocks.get(txid)) bundleBlocks.set(txid, block);
        }
        const clearedTxids = new Set();

        let cleared = 0;
        for(const row of rows || []){
            let location;
            try {
                location = await encoder.getTxStatus(String(row.txid));
            } catch(err){
                logger.warn('StateAnchorPublisher: anchor stamp sweep could not locate transaction ' +
                            row.txid + ': ' + (err && err.message));
                continue;
            }
            if(!location || location.status !== 'unknown') continue;

            try {
                const result = await this.db.updateStateCheckpointClearStamp(
                    String(row.txid), String(row.chain), String(row.network),
                    Number(row.block_index), Number(row.checkpoint_seq));
                if(result && Number(result.affectedRows) > 0){
                    cleared++;
                    clearedTxids.add(String(row.txid));
                }
            } catch(err){
                logger.warn('StateAnchorPublisher: anchor stamp sweep could not clear transaction ' +
                            row.txid + ': ' + (err && err.message));
            }
        }

        // Retract the hub-local reward each swept bundle wrote at broadcast, since it never mined.
        for(const txid of clearedTxids){
            if(bundleBlocks.has(txid)) await this.retractSweptBundleReward(txid, bundleBlocks.get(txid));
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
