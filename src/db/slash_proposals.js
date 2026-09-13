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
 * XChain Hub - query methods for the slashing proposal table.
 *
 * Owns src/sql/slash_proposals.sql.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

module.exports = {
    // Reads rows from slash_proposals.
    // Moved here from src/SlashGovernance.js:94.
    async findSlashProposals(validatorPubkey) {
        return this.doQuery(`SELECT id, validator_pubkey, offense_type, round_number, evidence, created_at FROM slash_proposals WHERE validator_pubkey = ? AND status = 'pending' ORDER BY id ASC`, [validatorPubkey]);
    },

    // Sweeps the status of an explicit set of pending slash_proposals rows.
    // Moved here from src/SlashGovernance.js:202.
    //
    // The id list is bound one placeholder per row rather than interpolated, so
    // the caller's row ids are data and the only thing its length changes is how
    // many ? the IN list carries.
    async updateSlashProposalsStatusByIds(newStatus, validatorPubkey, ids) {
        return this.doQuery(
            "UPDATE slash_proposals SET status = ? WHERE validator_pubkey = ? AND status = 'pending' " +
            "AND id IN (" + ids.map(() => '?').join(',') + ")",
            [newStatus, validatorPubkey].concat(ids)
        );
    }
};
