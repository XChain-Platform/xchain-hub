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
 * XChain Hub - query methods for BTC snapshot checkpoints.
 *
 * These checkpoints are intentionally separate from state_checkpoints. They
 * track which capability snapshot heights have been committed without entering
 * the state checkpoint cadence, anchoring, mirroring, or follower read paths.
 *
 ********************************************************************/

'use strict';

const COLUMNS = [
    'chain', 'network', 'block_index', 'block_hash', 'state_root',
    'state_root_version', 'validator_signatures'
];

module.exports = {
    async insertSnapshotCheckpoint(cp) {
        const result = await this.doQuery(
            'INSERT IGNORE INTO snapshot_checkpoints (' + COLUMNS.join(', ') + ') VALUES (' +
            COLUMNS.map(() => '?').join(', ') + ')',
            COLUMNS.map(column => cp[column]));
        return !!(result && Number(result.affectedRows) > 0);
    },

    async getSnapshotCheckpoint(chain, network, blockIndex) {
        const rows = await this.doQuery(
            'SELECT * FROM snapshot_checkpoints ' +
            'WHERE chain = ? AND network = ? AND block_index = ? LIMIT 1',
            [chain, network, blockIndex]);
        return rows && rows.length ? rows[0] : null;
    },

    async listUncheckpointedSnapshotBlocks(network, fromSnapshotBlock, burial, limit) {
        const requestedLimit = Number(limit);
        const cappedLimit = Number.isFinite(requestedLimit)
            ? Math.max(1, Math.min(100, Math.trunc(requestedLimit)))
            : 100;
        return this.doQuery(
            'SELECT DISTINCT cs.snapshot_block FROM capability_snapshots cs ' +
            'WHERE cs.snapshot_block >= ? AND NOT EXISTS (' +
            'SELECT 1 FROM snapshot_checkpoints sc WHERE sc.chain = ? AND sc.network = ? ' +
            'AND sc.block_index = cs.snapshot_block - ?) ' +
            'ORDER BY cs.snapshot_block ASC LIMIT ?',
            [fromSnapshotBlock, 'BTC', network, burial, cappedLimit]);
    }
};
