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
 * XChain Hub - query methods for the consensus key/value state table.
 *
 * Owns src/sql/consensus_state.sql, the node-local key/value row set the PBFT
 * engines keep their sequence and view state in.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

module.exports = {

    // Returns 0 on a fresh node or unparseable value.
    async getLastSeq(){
        let rows = await this.doQuery(
            "SELECT value FROM consensus_state WHERE key_name = ?",
            ['last_seq']
        );
        if(!rows || rows.length === 0) return 0;
        let seq = parseInt(rows[0].value, 10);
        return Number.isNaN(seq) ? 0 : seq;
    },

    // Reads rows from consensus_state.
    // Moved here from src/consensus/pbft.js:1356.
    async findConsensusState(key_name) {
        return this.doQuery('SELECT value FROM consensus_state WHERE key_name = ?', [key_name]);
    },

    // Inserts or updates a row in consensus_state.
    // Moved here from src/consensus/pbft.js:1379.
    async setConsensusState(key_name, value, value2) {
        return this.doQuery('INSERT INTO consensus_state (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?, updated_at = NOW()', [key_name, value, value2]);
    }
};
