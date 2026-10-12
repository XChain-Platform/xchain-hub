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
 **********************************************************************/

const remoteTokenSnapshots = require('./remote_token_snapshots.js');

module.exports = Object.assign({

    async insertListSnapshot(row){
        const cols = this.constructor.LIST_SNAPSHOT_COLUMNS;
        const res = await this.doQuery(
            'INSERT IGNORE INTO list_snapshots (' + cols.join(', ') + ') VALUES (' +
            cols.map(() => '?').join(', ') + ')',
            cols.map(c => row[c]));
        return !!(res && Number(res.affectedRows) > 0);
    },

    async getLatestListSeq(network, homeChain, homeListIndex){
        const rows = await this.doQuery(
            'SELECT MAX(seq) AS seq FROM list_snapshots ' +
            "WHERE network = ? AND home_chain = ? AND home_list_index = ? AND status = 'finalized'",
            [String(network || ''), String(homeChain || ''), Number(homeListIndex)]);
        if(!rows || rows.length === 0 || rows[0].seq == null) return 0;
        const n = Number(rows[0].seq);
        return Number.isFinite(n) ? n : 0;
    },

    async getListSnapshotAtSeq(network, homeChain, homeListIndex, seq){
        const rows = await this.doQuery(
            'SELECT * FROM list_snapshots WHERE network = ? AND home_chain = ? ' +
            'AND home_list_index = ? AND seq = ? LIMIT 1',
            [String(network || ''), String(homeChain || ''), Number(homeListIndex), Number(seq)]);
        return (rows && rows.length) ? rows[0] : null;
    },

    async findListSnapshotChain(network, homeChain, homeListIndex, uptoSeq){
        return this.doQuery(
            'SELECT seq, kind, list_type, added, removed, members_hash, name, description, meta_hash, origin_block ' +
            'FROM list_snapshots ' +
            "WHERE network = ? AND home_chain = ? AND home_list_index = ? AND seq <= ? AND status = 'finalized' " +
            'ORDER BY seq ASC',
            [String(network || ''), String(homeChain || ''), Number(homeListIndex), Number(uptoSeq)]);
    },

    async findListSnapshots(since, limit){
        return this.doQuery(
            'SELECT * FROM list_snapshots WHERE id > ? ORDER BY id ASC LIMIT ?', [since, limit]);
    },

    async getListSnapshotsMaxId(){
        return this.doQuery('SELECT MAX(id) AS max_id FROM list_snapshots');
    },

    async getListSnapshotBySnapshotId(snapshotId){
        return this.doQuery(
            'SELECT * FROM list_snapshots WHERE snapshot_id = ? LIMIT 1', [snapshotId]);
    },

    async findListSnapshotsByBatchSeq(limit){
        return this.doQuery(
            'SELECT * FROM list_snapshots WHERE batch_seq IS NULL ORDER BY snapshot_id ASC LIMIT ?', [limit]);
    },

    async updateListSnapshotArchiveBatchSeq(batchSeq, txid, snapshotId){
        return this.doQuery(
            'UPDATE list_snapshots SET batch_seq = ?, anchor_txid = COALESCE(?, anchor_txid) ' +
            'WHERE snapshot_id = ? AND batch_seq IS NULL',
            [batchSeq, txid, snapshotId]);
    }
}, remoteTokenSnapshots);
