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
                if(result && Number(result.affectedRows) > 0) cleared++;
            } catch(err){
                logger.warn('StateAnchorPublisher: anchor stamp sweep could not clear transaction ' +
                            row.txid + ': ' + (err && err.message));
            }
        }
        return cleared;
    }

};
