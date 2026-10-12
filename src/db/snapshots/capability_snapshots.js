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

// The mirror's table and column list, moved here with the statement they belong to
// from src/lib/capability_snapshot_write.js. capability_snapshots carries no network
// column: the set belongs to the hub, not to a chain network.
const TABLE   = 'capability_snapshots';
const COLUMNS = '(snapshot_block, capability, signing_pubkey, amount, source, btc_chain_id)';

module.exports = {
    // The table has no network column, so a regtest chain-instance change clears it whole.
    async deleteAllCapabilitySnapshots() {
        return this.doQuery('DELETE FROM capability_snapshots');
    },

    // Reads rows from capability_snapshots.
    // Moved here from src/api.js:2116.
    async findCapabilitySnapshotsById(since, limit) {
        return this.doQuery('SELECT * FROM capability_snapshots WHERE id > ? ORDER BY id ASC LIMIT ?', [since, limit]);
    },

    // Reads rows from capability_snapshots.
    // Moved here from src/anchor/publisher.js:2922.
    async findCapabilitySnapshotsBySnapshotBlock(snapshot_block, capability) {
        return this.doQuery('SELECT signing_pubkey, amount, source FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? ORDER BY signing_pubkey ASC', [snapshot_block, capability]);
    },

    // Reads rows from capability_snapshots.
    // Moved here from src/anchor/publisher.js:4921.
    async findCapabilitySnapshotsBySnapshotBlockAndCapability(snapshot_block, capability) {
        return this.doQuery('SELECT signing_pubkey FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? ORDER BY signing_pubkey ASC', [snapshot_block, capability]);
    },

    // Reads one row from capability_snapshots.
    // Moved here from src/attestation/batch_publisher/anchor.js:196, src/attestation/relay.js:306, src/cross_chain/bridge/plumbing.js:87, src/cross_chain/call_engine.js:367, src/cross_chain/dex_engine.js:316, src/oracle/consensus.js:123, src/oracle/price_aggregator/capability_persist.js:38, src/consensus/retraction.js:256.
    async getCapabilitySnapshot(snapshot_block, capability, signing_pubkey, source) {
        return this.doQuery('SELECT * FROM capability_snapshots WHERE snapshot_block = ? AND capability = ? AND signing_pubkey = ? AND source = ? LIMIT 1', [snapshot_block, capability, signing_pubkey, source]);
    },

    // Reads one row from capability_snapshots.
    // Moved here from src/peers/hub_db_broadcaster.js:647.
    async getCapabilitySnapshotsMaxId() {
        return this.doQuery('SELECT MAX(id) AS max_id FROM capability_snapshots');
    },

    // Writes a whole normalized validator set into capability_snapshots in ONE
    // statement. Moved here from src/lib/capability_snapshot_write.js:126, which
    // keeps the normalization, the truncation refusal and the identity resolve.
    //
    // Do NOT chunk this into several statements. InnoDB rolls a failed statement
    // back whole and, under autocommit, the statement IS the transaction, so one
    // statement is what makes the mirror all-or-nothing; chunking would silently
    // reopen the partial-commit window the shared writer exists to close, and a
    // partial set carries no completeness marker, so a verifier reads it COMPLETE.
    //
    // The row count is the only thing the caller's set changes about the statement:
    // every value, btc_chain_id included, is bound.
    async createCapabilitySnapshots(rows, btcChainId) {
        let args = [];
        for(let r of rows)
            args.push(r.snapshot_block, r.capability, r.signing_pubkey, r.amount, r.source, btcChainId);

        return this.doQuery(
            'INSERT IGNORE INTO ' + TABLE + ' ' + COLUMNS + ' VALUES ' +
            rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', '),
            args);
    },

    // The four stale-range prune statements, moved here from src/validators/capability_snapshot_prune.js.
    // `where` is that tool's buildWhere ({ clause, args }): the clause holds only ?
    // placeholders, so every operator-supplied value stays bound.

    // Reads the per-block groups of a stale range with their write times, lowest block first.
    async findStaleCapabilitySnapshotBlocks(where, limit) {
        return this.doQuery(
            'SELECT snapshot_block, capability, COUNT(*) AS rows_count, ' +
            'MIN(created_at) AS min_created, MAX(created_at) AS max_created ' +
            'FROM ' + TABLE + ' WHERE ' + where.clause +
            ' GROUP BY snapshot_block, capability ORDER BY snapshot_block ASC LIMIT ?',
            where.args.concat([limit]));
    },

    // Reads a stale range's row counts, block span and write times, one row per capability.
    async findStaleCapabilitySnapshotSummary(where) {
        return this.doQuery(
            'SELECT capability, COUNT(*) AS rows_count, MIN(snapshot_block) AS min_block, ' +
            'MAX(snapshot_block) AS max_block, COUNT(DISTINCT snapshot_block) AS block_count, ' +
            'MIN(created_at) AS min_created, MAX(created_at) AS max_created ' +
            'FROM ' + TABLE + ' WHERE ' + where.clause + ' GROUP BY capability ORDER BY capability ASC',
            where.args);
    },

    // Counts the distinct blocks in a stale range across every capability; the
    // per-capability counts overlap, so they cannot be summed instead.
    async getStaleCapabilitySnapshotBlockCount(where) {
        return this.doQuery(
            'SELECT COUNT(DISTINCT snapshot_block) AS block_count FROM ' + TABLE + ' WHERE ' + where.clause,
            where.args);
    },

    // Deletes at most `limit` rows of a stale range in one statement; the caller
    // loops until a short batch, so no single statement holds a long row lock.
    async deleteStaleCapabilitySnapshots(where, limit) {
        return this.doQuery(
            'DELETE FROM ' + TABLE + ' WHERE ' + where.clause + ' LIMIT ?',
            where.args.concat([limit]));
    }
};
