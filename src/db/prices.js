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
 * XChain Hub - query methods for the price rail tables.
 *
 * Owns src/sql/price_ingest_watermarks.sql and src/sql/price_snapshots.sql: the
 * per-(network, source-chain) ingest fence and the finalized price snapshots.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

module.exports = {

    // HUB-RETRACT-4: per-(network, source-chain) price ingest fence. Returns the highest
    // source-chain rollback generation whose price retraction the hub has processed, plus that
    // retraction's orphaned-range lower bound; or null when no retraction has ever been recorded
    // for the chain on this network (so pre-reorg generation-0 pushes are never rejected).
    // PriceAggregator rejects an incoming price push whose push_generation <= retraction_generation
    // AND action_index >= from_action_index: exactly a stale replay of a rolled-back action arriving
    // after its retraction (the re-published canonical row carries a higher generation and passes).
    //
    // `network` is part of the key because one hub DB can be shared by, or outlive, more than one
    // deployment network: on a chain-only key, clearing the regtest fence after an indexer wipe
    // dropped the LIVE network's fence for that chain and admitted the orphan replay it existed to
    // stop. The legacy '' bucket (rows written before the column, or by a hub with HUB_NETWORK
    // unset) is ambiguous by construction, so it is folded in here and the STRICTER fence wins:
    // highest generation, and at a tie the lowest orphan bound. Over-rejecting is loud and
    // clearable; a fence silently lost is not.
    //
    // The fence normalizer is a static on the Database class (src/db/index.js), reached here
    // through this.constructor because a mixin may not require its own installer.
    async getPriceIngestWatermark(sourceChain, network){
        let net = this.constructor.normalizeFenceNetwork(network);
        let rows = await this.doQuery(
            `SELECT retraction_generation, from_action_index FROM price_ingest_watermarks
             WHERE source_chain = ? AND network IN (?, '')
             ORDER BY retraction_generation DESC, from_action_index ASC
             LIMIT 1`,
            [sourceChain, net]);
        if(!rows || rows.length === 0) return null;
        return {
            retraction_generation: Number(rows[0].retraction_generation) || 0,
            from_action_index:     Number(rows[0].from_action_index) || 0
        };
    },

    // Raise one network's fence for a chain to a retraction's generation. Monotonic in generation:
    // a higher generation replaces the stored (generation, from); the same generation only widens
    // the orphaned range downward (LEAST from); a lower generation is ignored. The from_action_index
    // assignment is ordered BEFORE retraction_generation so its CASE reads the OLD generation
    // (MariaDB evaluates ON DUPLICATE assignments left to right).
    //
    // The write always names this hub's own network, so a retraction on one network can no longer
    // raise a fence that drops another network's healthy pushes.
    async bumpPriceIngestWatermark(sourceChain, generation, fromActionIndex, network){
        let gen  = Number(generation);
        let from = Number(fromActionIndex);
        if(!Number.isFinite(gen) || gen < 0) return;
        if(!Number.isFinite(from) || from < 0) from = 0;
        let net = this.constructor.normalizeFenceNetwork(network);
        await this.doQuery(
            `INSERT INTO price_ingest_watermarks (network, source_chain, retraction_generation, from_action_index)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                from_action_index = CASE
                    WHEN VALUES(retraction_generation) > retraction_generation THEN VALUES(from_action_index)
                    WHEN VALUES(retraction_generation) = retraction_generation THEN LEAST(from_action_index, VALUES(from_action_index))
                    ELSE from_action_index END,
                retraction_generation = GREATEST(retraction_generation, VALUES(retraction_generation))`,
            [net, sourceChain, gen, from]);
    }
};
