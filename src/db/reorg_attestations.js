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
    },

    // Reads the newest reorg_attestations rows.
    // Moved here from src/ReorgHandler.js:304, clamp included.
    //
    // Server-side page cap, matching the other three HubOperationalCache-backed
    // RPC methods (CapabilityRegistry#listState, Governance#getProposals,
    // Governance#getVotes): the API layer's generic validateLimit ceiling
    // (10000) is too loose for a hub-side read RPC to rely on alone. The clamp
    // sits here rather than at the caller so the ceiling travels with the
    // statement it bounds, and so the only value reaching the interpolated
    // LIMIT is one this method produced.
    async findReorgAttestations(limit) {
        let lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
        return this.doQuery("SELECT * FROM reorg_attestations ORDER BY created_at DESC LIMIT " + lim);
    }
};
