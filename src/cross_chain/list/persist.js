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
 * XChain Hub - Shared List Persistence
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {
    async writeFinalizedList(ev){
        const row = ev.row;
        const snapshotId = row.snapshot_id;
        row.validator_signatures = JSON.stringify(ev.signatures || []);
        row.finalizing_view = ev.view != null ? ev.view : 0;

        let persisted = 0;
        try {
            persisted = await this.persistCapabilitySnapshot(
                'cross_chain', Number(row.snapshot_block), row.network);
        } catch(e){
            logger.error('ListShare: snapshot persist on finalize FAILED (fail-closed; deferring ' +
                         String(snapshotId).substring(0, 16) + '... to a later round): ' +
                         (e && e.message));
            this.deferFinalizedList(snapshotId);
            return;
        }
        if(!persisted){
            logger.error('ListShare: snapshot persist wrote ZERO capability rows (fail-closed; deferring ' +
                         String(snapshotId).substring(0, 16) + '... to a later round)');
            this.deferFinalizedList(snapshotId);
            return;
        }

        let inserted;
        try {
            row.btc_chain_id = await this.resolveBtcChainId(row.network);
            inserted = await this.db.insertListSnapshot(row);
        } catch(e){
            logger.error('ListShare: finalized list snapshot write FAILED (fail-closed; deferring ' +
                         String(snapshotId).substring(0, 16) + '... to a later round): ' +
                         (e && e.message));
            this.deferFinalizedList(snapshotId);
            return;
        }

        this._inflight.delete(snapshotId);
        if(!inserted) return;
        await this.mirrorFinalizedList(snapshotId);
        this.emit('list:finalized', { snapshotId });
    },

    deferFinalizedList(snapshotId){
        this._inflight.delete(snapshotId);
        if(this.listConsensus && typeof this.listConsensus.forgetFinalized === 'function')
            this.listConsensus.forgetFinalized(snapshotId);
    },

    async mirrorFinalizedList(snapshotId){
        const broadcaster = this.broadcaster;
        if(!broadcaster) return;
        if(broadcaster.subscribers && broadcaster.subscribers.size === 0) return;

        let failure = null;
        try {
            const read = await this.db.getListSnapshotBySnapshotId(snapshotId);
            if(read && read.length){
                broadcaster.broadcastRow({ table: 'list_snapshots', row: read[0] });
                return;
            }
            failure = 'the committed row read back empty';
        } catch(e){
            failure = (e && e.message) ? e.message : String(e);
        }

        logger.error('ListShare: could not stream a committed list_snapshots row to mirror subscribers (' +
                     failure + '); forcing subscriber resync');
        try {
            if(typeof broadcaster.dropAllForResync === 'function')
                broadcaster.dropAllForResync('list_snapshots mirror gap');
        } catch(_e){}
    }
};
