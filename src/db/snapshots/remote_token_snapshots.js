/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const COLUMNS = [
    'snapshot_id', 'snapshot_block', 'network', 'coin', 'tick', 'decimals',
    'owner', 'source_action_index', 'finalizing_view', 'validator_signatures',
    'status', 'btc_chain_id'
];

module.exports = {
    async insertRemoteTokenSnapshot(row, btcChainId){
        const values = Object.assign({ status: 'finalized' }, row, { btc_chain_id: btcChainId });
        return this.doQuery(
            'INSERT IGNORE INTO remote_token_snapshots (' + COLUMNS.join(', ') + ') VALUES (' +
            COLUMNS.map(() => '?').join(', ') + ')',
            COLUMNS.map(column => values[column]));
    },

    async getRemoteTokenSnapshotById(snapshotId){
        return this.doQuery(
            'SELECT * FROM remote_token_snapshots WHERE snapshot_id = ? LIMIT 1',
            [String(snapshotId)]);
    },

    async getLatestRemoteTokenSnapshot(network, coin, tick){
        return this.doQuery(
            "SELECT * FROM remote_token_snapshots WHERE network = ? AND coin = ? AND tick = ? AND status = 'finalized' " +
            'ORDER BY snapshot_block DESC, source_action_index DESC, snapshot_id DESC LIMIT 1',
            [String(network), String(coin).toUpperCase(), String(tick)]);
    },

    async findRemoteTokenSnapshots(since, limit){
        return this.doQuery(
            'SELECT * FROM remote_token_snapshots WHERE id > ? ORDER BY id ASC LIMIT ?',
            [Number(since) || 0, Number(limit)]);
    },

    async getRemoteTokenSnapshotsMaxId(){
        return this.doQuery('SELECT MAX(id) AS max_id FROM remote_token_snapshots');
    },

    async findRemoteTokenSnapshotsByBatchSeq(limit){
        return this.doQuery(
            'SELECT * FROM remote_token_snapshots WHERE batch_seq IS NULL ' +
            'ORDER BY snapshot_block ASC, coin ASC, tick ASC, snapshot_id ASC LIMIT ?',
            [Number(limit)]);
    },

    async updateRemoteTokenSnapshotArchiveBatchSeq(batchSeq, txid, snapshotId){
        return this.doQuery(
            'UPDATE remote_token_snapshots SET batch_seq = ?, anchor_txid = COALESCE(?, anchor_txid) ' +
            'WHERE snapshot_id = ? AND batch_seq IS NULL',
            [Number(batchSeq), txid, String(snapshotId)]);
    }
};
