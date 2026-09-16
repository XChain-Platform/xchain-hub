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
    // Moved here from src/validators/slash_governance.js:94.
    async findSlashProposals(validatorPubkey) {
        return this.doQuery(`SELECT id, validator_pubkey, offense_type, round_number, evidence, created_at FROM slash_proposals WHERE validator_pubkey = ? AND status = 'pending' ORDER BY id ASC`, [validatorPubkey]);
    },

    // Inserts a row into slash_proposals.
    // Moved here from src/validators/slash_detector.js:448.
    async createSlashProposal(validatorPubkey, offenseType, roundNumber, evidence) {
        return this.doQuery(`INSERT INTO slash_proposals (validator_pubkey, offense_type, round_number, evidence)
                     VALUES (?, ?, ?, ?)`, [validatorPubkey, offenseType, roundNumber, evidence]);
    },

    // Reads rows from slash_proposals: every pending proposal, newest first, unbounded.
    // Moved here from src/validators/slash_detector.js:466.
    async findPendingSlashProposals() {
        return this.doQuery("SELECT * FROM slash_proposals WHERE status = 'pending' ORDER BY created_at DESC");
    },

    // Reads rows from slash_proposals: the 50 newest proposals against one validator,
    // any status.
    // Moved here from src/validators/slash_detector.js:471.
    async findRecentSlashProposalsByValidator(validatorPubkey) {
        return this.doQuery("SELECT * FROM slash_proposals WHERE validator_pubkey = ? ORDER BY created_at DESC LIMIT 50", [validatorPubkey]);
    },

    // Reads rows from slash_proposals, narrowed to whichever of status and validator
    // the caller passed (null for no filter). The caller validates both filters and
    // clamps the page size; the integer check below is what keeps the interpolated
    // LIMIT from ever carrying anything but a positive whole number.
    // Moved here from src/validators/slash_detector.js:516.
    async findSlashProposalsFiltered(status, validatorPubkey, limit) {
        if (!Number.isInteger(limit) || limit < 1)
            throw new Error('findSlashProposalsFiltered: limit must be a positive integer, got ' + limit);
        let where = [];
        let args  = [];
        if (status) {
            where.push('status = ?');
            args.push(status);
        }
        if (validatorPubkey) {
            where.push('validator_pubkey = ?');
            args.push(validatorPubkey);
        }
        let query = 'SELECT id, validator_pubkey, offense_type, round_number, evidence, status, created_at ' +
                    'FROM slash_proposals';
        if (where.length) query += ' WHERE ' + where.join(' AND ');
        query += ' ORDER BY id DESC LIMIT ' + limit;
        return this.doQuery(query, args);
    },

    // Sweeps the status of an explicit set of pending slash_proposals rows.
    // Moved here from src/validators/slash_governance.js:202.
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
