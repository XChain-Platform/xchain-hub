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
    'owner', 'source_action_index', 'admit_block_btc', 'admit_block_ltc', 'admit_block_doge',
    'finalizing_view', 'validator_signatures', 'status', 'btc_chain_id'
];

// A row signed below remote_token_admission_activation, or caught up from a peer that does
// not carry the columns, has no admission keys at all; it is stored with explicit NULLs.
const ADMIT_COLUMNS = new Set(['admit_block_btc', 'admit_block_ltc', 'admit_block_doge']);

// Nothing writes the table's batch_seq and anchor_txid columns: remote-token rows are not
// carried in the ANCHOR archive and return through the hub mirror and peer catchup.

module.exports = {
    async insertRemoteTokenSnapshot(row, btcChainId){
        const values = Object.assign({ status: 'finalized' }, row, { btc_chain_id: btcChainId });
        return this.doQuery(
            'INSERT IGNORE INTO remote_token_snapshots (' + COLUMNS.join(', ') + ') VALUES (' +
            COLUMNS.map(() => '?').join(', ') + ')',
            COLUMNS.map(column => (ADMIT_COLUMNS.has(column) && values[column] === undefined) ? null : values[column]));
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
    }
};
