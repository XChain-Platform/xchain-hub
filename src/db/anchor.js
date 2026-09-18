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
 * XChain Hub - query methods for the ANCHOR publishing tables.
 *
 * Owns src/sql/anchor_published_archives.sql, src/sql/anchor_published_checkpoints.sql, src/sql/anchor_reward_attestations.sql.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

// The anchor_reward_attestations columns a hub-DB mirror receives, shared by the REST
// bootstrap page (findAnchorRewardAttestations) and the live stream's read-back
// (getAnchorRewardAttestation) so a reconnecting mirror and a streaming mirror hold the
// same row. admit_block_btc is the row's BTC admission height (NULL is the legacy row);
// a bootstrap list without it would bind a height-stamped row by the legacy rule.
const ANCHOR_REWARD_MIRROR_COLUMNS = [
    'id', 'chain', 'network', 'reward_type', 'round_reference', 'snapshot_block', 'publisher',
    'reward_amount', 'publisher_attestations', 'doge_anchor_txid', 'admit_block_btc', 'created_at'
];

module.exports = {
    // Inserts a row into anchor_reward_attestations.
    // Moved here from src/anchor/publisher.js:1498.
    async createAnchorRewardAttestation(rowChain, network, rewardType, roundReference, snapshotBlock, publisher, amount, sigsJson, txid) {
        return this.doQuery('INSERT IGNORE INTO anchor_reward_attestations (chain, network, reward_type, round_reference, snapshot_block, publisher, reward_amount, publisher_attestations, doge_anchor_txid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [rowChain, network, rewardType, roundReference, snapshotBlock, publisher, amount, sigsJson, txid]);
    },

    // Deletes from anchor_published_archives.
    // Moved here from src/anchor/publisher.js:5690.
    async deleteAnchorPublishedArchive(network, batch_seq) {
        return this.doQuery('DELETE FROM anchor_published_archives WHERE network = ? AND batch_seq = ? AND sent_at IS NULL', [network, batch_seq]);
    },

    // Deletes from anchor_published_checkpoints.
    // Moved here from src/anchor/publisher.js:5596.
    async deleteAnchorPublishedCheckpoint(chain, network, checkpoint_seq) {
        return this.doQuery('DELETE FROM anchor_published_checkpoints WHERE chain = ? AND network = ? AND checkpoint_seq = ? AND sent_at IS NULL', [chain, network, checkpoint_seq]);
    },

    // Reads rows from anchor_published_checkpoints.
    // Moved here from src/anchor/publisher.js:5543.
    async findAnchorPublishedCheckpoints(chain, network, checkpoint_seq) {
        return this.doQuery('SELECT chain, network, checkpoint_seq, txid, intent_at, sent_at FROM anchor_published_checkpoints WHERE chain = ? AND network = ? AND checkpoint_seq = ?', [chain, network, checkpoint_seq]);
    },

    // Reads rows from anchor_reward_attestations.
    // Moved here from src/api.js:2248.
    async findAnchorRewardAttestations(since, limit) {
        return this.doQuery('SELECT ' + ANCHOR_REWARD_MIRROR_COLUMNS.join(', ') + ' FROM anchor_reward_attestations WHERE id > ? ORDER BY id ASC LIMIT ?', [since, limit]);
    },

    // Reads one row from anchor_published_archives.
    // Moved here from src/anchor/publisher.js:5634.
    async getAnchorPublishedArchive(network) {
        return this.doQuery('SELECT network, batch_seq, txid, intent_at, sent_at FROM anchor_published_archives WHERE network = ? AND settled_at IS NULL ORDER BY intent_at DESC LIMIT 1', [network]);
    },

    // Reads one row from anchor_reward_attestations.
    // Moved here from src/anchor/publisher.js:1530.
    async getAnchorRewardAttestation(rowChain, network, rewardType, roundReference, snapshotBlock, publisher) {
        return this.doQuery('SELECT ' + ANCHOR_REWARD_MIRROR_COLUMNS.join(', ') + ' FROM anchor_reward_attestations WHERE chain = ? AND network = ? AND reward_type = ? AND round_reference = ? AND snapshot_block = ? AND publisher = ? LIMIT 1', [rowChain, network, rewardType, roundReference, snapshotBlock, publisher]);
    },

    // Reads one row from anchor_reward_attestations.
    // Moved here from src/peers/hub_db_broadcaster.js:663.
    async getAnchorRewardAttestationsMaxId() {
        return this.doQuery('SELECT MAX(id) AS max_id FROM anchor_reward_attestations');
    },

    // Inserts or updates a row in anchor_published_archives.
    // Moved here from src/anchor/publisher.js:5646.
    async setAnchorPublishedArchive(network, batch_seq) {
        return this.doQuery('INSERT INTO anchor_published_archives (network, batch_seq) VALUES (?, ?) ON DUPLICATE KEY UPDATE intent_at = CURRENT_TIMESTAMP, sent_at = NULL, txid = NULL, settled_at = NULL', [network, batch_seq]);
    },

    // Inserts or updates a row in anchor_published_checkpoints.
    // Moved here from src/anchor/publisher.js:5567.
    async setAnchorPublishedCheckpoint(chain, network, checkpoint_seq) {
        return this.doQuery('INSERT INTO anchor_published_checkpoints (chain, network, checkpoint_seq) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE intent_at = CURRENT_TIMESTAMP, sent_at = NULL, txid = NULL', [chain, network, checkpoint_seq]);
    },

    // Updates anchor_published_archives.
    // Moved here from src/anchor/publisher.js:5657.
    async updateAnchorPublishedArchiveByNetwork(txid, network, batch_seq) {
        return this.doQuery('UPDATE anchor_published_archives SET txid = ?, sent_at = NOW() WHERE network = ? AND batch_seq = ?', [txid, network, batch_seq]);
    },

    // Updates anchor_published_archives.
    // Moved here from src/anchor/publisher.js:5673.
    async updateAnchorPublishedArchiveByNetworkAndBatchSeq(network, batch_seq) {
        return this.doQuery('UPDATE anchor_published_archives SET settled_at = NOW() WHERE network = ? AND batch_seq = ? AND sent_at IS NOT NULL', [network, batch_seq]);
    },

    // Updates anchor_published_checkpoints.
    // Moved here from src/anchor/publisher.js:5578.
    async updateAnchorPublishedCheckpoint(txid, chain, network, checkpoint_seq) {
        return this.doQuery('UPDATE anchor_published_checkpoints SET txid = ?, sent_at = NOW() WHERE chain = ? AND network = ? AND checkpoint_seq = ?', [txid, chain, network, checkpoint_seq]);
    },

    // Retention sweep: deletes confirmed anchor_published_checkpoints markers whose intent
    // is older than the window. Moved here from src/anchor/publisher.js:5670.
    //
    // `sent_at IS NOT NULL` keeps every intent-only row, which is the only durable trace
    // that DOGE may already have paid, and the cutoff is DB-clock arithmetic on intent_at,
    // the column anchorIntentHolds measures, so host/DB skew never folds into the window.
    async deleteAnchorPublishedCheckpointsSentBefore(windowSec) {
        return this.doQuery(
            'DELETE FROM anchor_published_checkpoints WHERE sent_at IS NOT NULL ' +
            'AND intent_at < DATE_SUB(NOW(), INTERVAL ? SECOND)',
            [windowSec]);
    },

    // The same retention sweep for anchor_published_archives markers.
    // Moved here from src/anchor/publisher.js:5670.
    async deleteAnchorPublishedArchivesSentBefore(windowSec) {
        return this.doQuery(
            'DELETE FROM anchor_published_archives WHERE sent_at IS NOT NULL ' +
            'AND intent_at < DATE_SUB(NOW(), INTERVAL ? SECOND)',
            [windowSec]);
    }
};
