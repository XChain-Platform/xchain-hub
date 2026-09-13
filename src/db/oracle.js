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
 * XChain Hub - query methods for the oracle price, submission and published-round tables.
 *
 * Owns src/sql/oracle_prices.sql, src/sql/oracle_submissions.sql, src/sql/oracle_published_rounds.sql.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

module.exports = {
    // Deletes from oracle_published_rounds.
    // Moved here from src/OraclePublisher.js:2878.
    async deleteOraclePublishedRound(cutoff) {
        return this.doQuery('DELETE FROM oracle_published_rounds WHERE round < ? AND sent_at IS NOT NULL', [cutoff]);
    },

    // Deletes from oracle_submissions.
    // Moved here from src/OracleRound.js:1199.
    async deleteOracleSubmission(cutoff) {
        return this.doQuery('DELETE FROM oracle_submissions WHERE round_number < ?', [cutoff]);
    },

    // Reads rows from oracle_published_rounds.
    // Moved here from src/OraclePublisher.js:2798.
    async findAllOraclePublishedRounds() {
        return this.doQuery('SELECT round, txid, sent_at FROM oracle_published_rounds');
    },

    // Reads rows from oracle_published_rounds.
    // Moved here from src/OraclePublisher.js:2746.
    async findOraclePublishedRoundsByRound(round) {
        return this.doQuery('SELECT round, txid, sent_at FROM oracle_published_rounds WHERE round = ?', [round]);
    },

    // Reads one row from oracle_prices.
    // Moved here from src/PriceAggregator.js:1434.
    async getOraclePrice(source_address, source_chain, actionIndex) {
        return this.doQuery('SELECT id, push_generation FROM oracle_prices WHERE source_address = ? AND source_chain = ? AND action_index = ? LIMIT 1', [source_address, source_chain, actionIndex]);
    },

    // Reads one row from oracle_prices.
    // Moved here from src/HubDbBroadcaster.js:636.
    async getOraclePricesMaxId() {
        return this.doQuery('SELECT MAX(id) AS max_id FROM oracle_prices');
    },

    // Inserts or updates a row in oracle_published_rounds.
    // Moved here from src/OraclePublisher.js:2758.
    async setOraclePublishedRound(round) {
        return this.doQuery('INSERT INTO oracle_published_rounds (round) VALUES (?) ON DUPLICATE KEY UPDATE round = round', [round]);
    },

    // Updates oracle_published_rounds.
    // Moved here from src/OraclePublisher.js:2772.
    async updateOraclePublishedRound(txid, round) {
        return this.doQuery('UPDATE oracle_published_rounds SET txid = ?, sent_at = NOW() WHERE round = ?', [txid, round]);
    },

    // Forgets the durable publish markers for a set of retracted rounds.
    // Moved here from src/OraclePublisher.js:2713.
    //
    // `rounds` is the caller's list of parsed integer round numbers; each one is bound as
    // a parameter, so the only thing built from the list is the count of placeholders.
    async deleteOraclePublishedRoundsByRounds(rounds) {
        let placeholders = rounds.map(() => '?').join(',');
        return this.doQuery(
            'DELETE FROM oracle_published_rounds WHERE round IN (' + placeholders + ')', rounds);
    }
};
