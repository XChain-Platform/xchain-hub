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
 * XChain Hub - query methods for the reorg attestation table.
 *
 * Owns src/sql/reorg_attestations.sql.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

module.exports = {
    // Inserts or updates a row in reorg_attestations.
    // Moved here from src/ReorgHandler.js:643.
    async setReorgAttestation(reorgId, chain, reorgHeight, timestamp, affected_chains, validatorCount, proof) {
        return this.doQuery(`INSERT INTO reorg_attestations
                (reorg_id, source_chain, reorg_height, reorg_timestamp, affected_chains,
                 validator_count, consensus_proof, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')
             ON DUPLICATE KEY UPDATE status = 'confirmed', updated_at = NOW()`, [reorgId, chain, reorgHeight, timestamp, affected_chains, validatorCount, proof]);
    }
};
