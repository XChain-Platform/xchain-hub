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
 * XChain Hub - query methods for the stake-qualified capability snapshot table.
 *
 * Owns src/sql/capability_snapshots.sql.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

module.exports = {
    // Reads rows from capability_snapshots.
    // Moved here from src/api.js:2116.
    async findCapabilitySnapshotsById(since, limit) {
        return this.doQuery('SELECT * FROM capability_snapshots WHERE id > ? ORDER BY id ASC LIMIT ?', [since, limit]);
    },

    // Reads rows from capability_snapshots.
    // Moved here from src/StateAnchorPublisher.js:2922.
    async findCapabilitySnapshotsBySnapshotBlock(snapshot_block, capability) {
        return this.doQuery('SELECT signing_pubkey, amount, source FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? ORDER BY signing_pubkey ASC', [snapshot_block, capability]);
    },

    // Reads rows from capability_snapshots.
    // Moved here from src/StateAnchorPublisher.js:4921.
    async findCapabilitySnapshotsBySnapshotBlockAndCapability(snapshot_block, capability) {
        return this.doQuery('SELECT signing_pubkey FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? ORDER BY signing_pubkey ASC', [snapshot_block, capability]);
    },

    // Reads one row from capability_snapshots.
    // Moved here from src/AttestationBatchPublisher.js:783, src/AttestationRelay.js:1121, src/CrossChainBridgeEngine.js:1405, src/CrossChainCallEngine.js:1069, src/CrossChainDexEngine.js:1094, src/OracleConsensus.js:2435, src/PriceAggregator.js:2042, src/RetractionConsensus.js:461.
    async getCapabilitySnapshot(snapshot_block, capability, signing_pubkey, source) {
        return this.doQuery('SELECT * FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? AND signing_pubkey = ? AND source = ? LIMIT 1', [snapshot_block, capability, signing_pubkey, source]);
    },

    // Reads one row from capability_snapshots.
    // Moved here from src/HubDbBroadcaster.js:647.
    async getCapabilitySnapshotsMaxId() {
        return this.doQuery('SELECT MAX(id) AS max_id FROM capability_snapshots');
    }
};
