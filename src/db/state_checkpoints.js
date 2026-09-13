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
 * XChain Hub - query methods for the state checkpoint table.
 *
 * Owns src/sql/state_checkpoints.sql.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

// The newest anchor-eligible, not-yet-anchored checkpoint per (chain, network): its
// checkpoint ORDINAL (seq divided by the cadence step) is divisible by the anchor stride.
// Moved here from src/StateAnchorPublisher.js:1065.
//
// The SQL is unchanged from the per-chain era ON PURPOSE (D24). The
// `anchor_txid IS NULL` predicate sits OUTSIDE the MAX subquery: pushing it in
// would resurrect older un-anchored seqs that the chained hashes have already
// superseded. Do not move it.
const PENDING_ANCHOR_CHECKPOINTS_SQL =
    'SELECT sc.* FROM state_checkpoints sc JOIN (' +
    '  SELECT chain, network, MAX(checkpoint_seq) AS max_seq FROM state_checkpoints' +
    '  WHERE MOD(FLOOR(checkpoint_seq / ?), ?) = 0 GROUP BY chain, network' +
    ') t ON sc.chain = t.chain AND sc.network = t.network AND sc.checkpoint_seq = t.max_seq ' +
    'WHERE sc.anchor_txid IS NULL';

module.exports = {
    // Inserts a row into state_checkpoints.
    // Moved here from src/StateCheckpointEngine.js:907.
    async createStateCheckpoint(chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root, block_merkle_version, validator_signatures) {
        return this.doQuery('INSERT IGNORE INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root, block_merkle_version, validator_signatures) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root, block_merkle_version, validator_signatures]);
    },

    // Reads rows from state_checkpoints.
    // Moved here from src/api.js:2174.
    async findStateCheckpointsById(since, limit) {
        return this.doQuery('SELECT id, chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root, block_merkle_version, validator_signatures, created_at FROM state_checkpoints WHERE id > ? ORDER BY id ASC LIMIT ?', [since, limit]);
    },

    // Reads rows from state_checkpoints.
    // Moved here from src/StateCheckpointEngine.js:370.
    async findStateCheckpointsByNetwork(network) {
        return this.doQuery('SELECT chain, MAX(block_index) AS last_finalized_block, MAX(checkpoint_seq) AS last_seq FROM state_checkpoints WHERE network = ? GROUP BY chain', [network]);
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/StateAnchorPublisher.js:2562.
    async getLatestStateCheckpoint() {
        return this.doQuery(`SELECT * FROM state_checkpoints ORDER BY (chain = 'BTC') DESC, checkpoint_seq DESC, snapshot_block DESC, block_index DESC LIMIT 1`);
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/StateAnchorPublisher.js:1815, src/StateAnchorPublisher.js:2168, src/StateAnchorPublisher.js:2358, src/StateAnchorPublisher.js:3099, src/StateAnchorPublisher.js:3197, src/StateAnchorPublisher.js:4644.
    async getStateCheckpointByChain(chain, network, block_index, checkpoint_seq) {
        return this.doQuery('SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? LIMIT 1', [chain, network, block_index, checkpoint_seq]);
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/StateAnchorPublisher.js:3504.
    async getStateCheckpointByChainAndNetwork(chain, network, block_index) {
        return this.doQuery('SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND block_index = ? ORDER BY checkpoint_seq DESC LIMIT 1', [chain, network, block_index]);
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/StateCheckpointEngine.js:1141.
    async getStateCheckpointByChainAndNetworkAndCheckpointSeq(chain, network, checkpoint_seq) {
        return this.doQuery('SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND checkpoint_seq = ? LIMIT 1', [chain, network, checkpoint_seq]);
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/StateAnchorPublisher.js:2559.
    async getStateCheckpointByNetwork(network) {
        return this.doQuery(`SELECT * FROM state_checkpoints WHERE network = ? ORDER BY (chain = 'BTC') DESC, checkpoint_seq DESC, snapshot_block DESC, block_index DESC LIMIT 1`, [network]);
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/StateCheckpointEngine.js:1123.
    async getStateCheckpointsMaxCheckpointSeq(chain, network) {
        return this.doQuery('SELECT MAX(checkpoint_seq) AS max_seq FROM state_checkpoints WHERE chain = ? AND network = ?', [chain, network]);
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/HubDbBroadcaster.js:651.
    async getStateCheckpointsMaxId() {
        return this.doQuery('SELECT MAX(id) AS max_id FROM state_checkpoints');
    },

    // Reads one row from state_checkpoints.
    // Moved here from src/StateCheckpointEngine.js:428.
    async getStateCheckpointsMaxSnapshotBlock(network) {
        return this.doQuery('SELECT MAX(snapshot_block) AS last_block FROM state_checkpoints WHERE network = ?', [network]);
    },

    // Updates state_checkpoints.
    // Moved here from src/StateAnchorPublisher.js:1329, src/StateAnchorPublisher.js:3240.
    async updateStateCheckpoint(txid, chain, network, block_index, checkpoint_seq) {
        return this.doQuery('UPDATE state_checkpoints SET anchor_txid = ? WHERE chain = ? AND network = ? AND block_index = ? AND checkpoint_seq = ? AND anchor_txid IS NULL', [txid, chain, network, block_index, checkpoint_seq]);
    },

    // Reads the pending anchor checkpoints across every network, for a hub with no
    // configured network (the legacy unscoped behavior).
    // Moved here from src/StateAnchorPublisher.js:1065, the unscoped branch.
    async findAnchorEligibleUnanchoredCheckpoints(checkpointIntervalBlocks, anchorEveryNCheckpoints) {
        return this.doQuery(PENDING_ANCHOR_CHECKPOINTS_SQL, [checkpointIntervalBlocks, anchorEveryNCheckpoints]);
    },

    // Reads the pending anchor checkpoints of one network, so a hub DB carrying rows from a
    // prior network deployment never re-elects publishers for a dead network's checkpoints.
    // Moved here from src/StateAnchorPublisher.js:1065, the network-scoped branch.
    async findAnchorEligibleUnanchoredCheckpointsByNetwork(checkpointIntervalBlocks, anchorEveryNCheckpoints, network) {
        return this.doQuery(PENDING_ANCHOR_CHECKPOINTS_SQL + ' AND sc.network = ?', [checkpointIntervalBlocks, anchorEveryNCheckpoints, network]);
    }
};
