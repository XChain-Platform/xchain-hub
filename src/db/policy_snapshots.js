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
 * XChain Hub - query methods for the token policy snapshot table.
 *
 * Owns src/sql/policy_snapshots.sql (the policy spec section 5). The table is
 * append-only: a superseding policy is a new row at a higher policy_seq. Its
 * column list stays a static on the Database class in src/db/index.js, reached
 * here through this.constructor.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

module.exports = {

    // Persist one quorum-signed policy snapshot. Append-only, the state_checkpoints
    // shape: a superseding policy is a NEW row at a higher policy_seq, never an in-place
    // update (the mirror applies rows INSERT IGNORE, so an UPDATE would never propagate),
    // and there is no retraction path for this table. Returns true only on a real insert
    // so a same-seq race between two hubs collapses on uq_policy_seq silently.
    async insertPolicySnapshot(row){
        let cols = this.constructor.POLICY_SNAPSHOT_COLUMNS;
        let res = await this.doQuery(
            'INSERT IGNORE INTO policy_snapshots (' + cols.join(', ') + ') VALUES (' +
            cols.map(() => '?').join(', ') + ')',
            cols.map(c => row[c]));
        return !!(res && Number(res.affectedRows) > 0);
    },

    // Highest FINALIZED policy_seq this hub holds for one token, or 0 when it holds
    // none. The next snapshot signs at this + 1 (policy spec section 3 step 2); a gap is
    // ordering only and never a refusal, so the caller never back-fills.
    async getLatestPolicySeq(network, originChain, tick){
        let rows = await this.doQuery(
            "SELECT MAX(policy_seq) AS seq FROM policy_snapshots " +
            "WHERE network = ? AND origin_chain = ? AND tick = ? AND status = 'finalized'",
            [String(network || ''), String(originChain || ''), String(tick || '')]);
        if(!rows || rows.length === 0 || rows[0].seq == null) return 0;
        let n = Number(rows[0].seq);
        return Number.isFinite(n) ? n : 0;
    },

    // The finalized snapshot a follower would be equivocating against: our own row at
    // the same (network, origin_chain, tick, policy_seq), or null when we hold none.
    async getPolicySnapshotAtSeq(network, originChain, tick, policySeq){
        let rows = await this.doQuery(
            'SELECT snapshot_id, policy_hash, origin_block, snapshot_block, status FROM policy_snapshots ' +
            'WHERE network = ? AND origin_chain = ? AND tick = ? AND policy_seq = ? LIMIT 1',
            [String(network || ''), String(originChain || ''), String(tick || ''), Number(policySeq)]);
        return (rows && rows.length) ? rows[0] : null;
    },

    // Reads rows from policy_snapshots.
    // Moved here from src/api.js:2227.
    async findPolicySnapshots(since, limit) {
        return this.doQuery('SELECT * FROM policy_snapshots WHERE id > ? ORDER BY id ASC LIMIT ?', [since, limit]);
    },

    // Reads one committed policy snapshot row back whole, for the hub-DB mirror stream.
    // Moved here from src/cross_chain/bridge_engine.js:1113, which read either this table
    // or bridge_transfers through one statement built from the table name.
    async getPolicySnapshotBySnapshotId(snapshotId) {
        return this.doQuery('SELECT * FROM policy_snapshots WHERE snapshot_id = ? LIMIT 1', [snapshotId]);
    },

    // Rows the ANCHOR archive still owes a batch to. Append-only, so there is no
    // archived_status to re-check: a snapshot the archive already covered never
    // changes, and a superseding policy arrives as a NEW row at a higher policy_seq.
    async findPolicySnapshotsByBatchSeq(limit) {
        return this.doQuery(
            'SELECT * FROM policy_snapshots WHERE batch_seq IS NULL ORDER BY snapshot_id ASC LIMIT ?', [limit]);
    },

    // Stamps the ANCHOR archive batch a snapshot was published in. Guarded on
    // batch_seq IS NULL, since the append-only table gives an archived row nothing to
    // re-check a later mutation against.
    async updatePolicySnapshotArchiveBatchSeq(batchSeq, txid, snapshotId) {
        return this.doQuery(
            'UPDATE policy_snapshots SET batch_seq = ?, anchor_txid = COALESCE(?, anchor_txid) ' +
            'WHERE snapshot_id = ? AND batch_seq IS NULL',
            [batchSeq, txid, snapshotId]);
    }
};
