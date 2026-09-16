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
 * XChain Hub - query methods for the swap record table.
 *
 * Owns src/sql/swap_records.sql.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

module.exports = {
    // Records a swap, or re-points an existing one at a new destination.
    // Moved here from src/cross_chain/swap_tracker.js:51. The last two arguments repeat the
    // destination for the ON DUPLICATE KEY UPDATE clause.
    async createSwapRecord(sourceChain, sourceActionIndex, destChain, destActionIndex, destChainOnDuplicate, destActionIndexOnDuplicate) {
        return this.doQuery(`INSERT INTO swap_records
            (source_chain, source_action_index, dest_chain, dest_action_index, status)
            VALUES (?, ?, ?, ?, 'initiated')
            ON DUPLICATE KEY UPDATE dest_chain = ?, dest_action_index = ?, updated_at = NOW()`, [
            sourceChain, sourceActionIndex, destChain, destActionIndex,
            destChainOnDuplicate, destActionIndexOnDuplicate
        ]);
    },

    // Reads one row from swap_records.
    // Moved here from src/cross_chain/swap_tracker.js:63.
    async getSwapRecordBySourceAction(sourceChain, sourceActionIndex) {
        return this.doQuery("SELECT * FROM swap_records WHERE source_chain = ? AND source_action_index = ? LIMIT 1", [sourceChain, sourceActionIndex]);
    },

    // Reads the newest swap_records rows, any status.
    // Moved here from src/cross_chain/swap_tracker.js:69, the branch that adds no status filter.
    async findSwapRecords(limit) {
        return this.doQuery("SELECT * FROM swap_records ORDER BY created_at DESC LIMIT ?", [limit]);
    },

    // Reads the newest swap_records rows in one status.
    // Moved here from src/cross_chain/swap_tracker.js:69, the branch that filters on status.
    async findSwapRecordsByStatus(status, limit) {
        return this.doQuery("SELECT * FROM swap_records WHERE status = ? ORDER BY created_at DESC LIMIT ?", [status, limit]);
    },

    // Updates one swap_records row's status, leaving its attestation id alone.
    // Moved here from src/cross_chain/swap_tracker.js:81, the branch with no attestation id.
    async updateSwapRecordStatus(status, sourceChain, sourceActionIndex) {
        return this.doQuery("UPDATE swap_records SET status = ?, updated_at = NOW() WHERE source_chain = ? AND source_action_index = ?", [status, sourceChain, sourceActionIndex]);
    },

    // Updates one swap_records row's status and the attestation that moved it.
    // Moved here from src/cross_chain/swap_tracker.js:81, the branch that carries an attestation id.
    async updateSwapRecordStatusAndAttestation(status, attestationId, sourceChain, sourceActionIndex) {
        return this.doQuery("UPDATE swap_records SET status = ?, attestation_id = ?, updated_at = NOW() WHERE source_chain = ? AND source_action_index = ?", [status, attestationId, sourceChain, sourceActionIndex]);
    }
};
