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
 * XChain Hub - query methods for the bridge transfer table.
 *
 * Owns src/sql/bridge_transfers.sql (the base bridge spec section 6 and the token
 * spec section 5). CrossChainBridgeEngine runs the rounds; the writes and the
 * invariant reads live here so one place owns the column list the hub-DB mirror
 * carries to every indexer. The column list itself stays a static on the Database
 * class in src/db/index.js, reached here through this.constructor.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

module.exports = {

    // Persist one quorum-signed transfer record. Returns true ONLY when a row was
    // actually written, so the caller mirrors, credits and logs exactly once per
    // finalization and a duplicate finalize (restart race, a second hub) is a no-op.
    //
    // INSERT IGNORE plus a revive of a retracted row: the cross_chain_matches rule
    // verbatim (CrossChainDexEngine._insertMatchRow). transfer_id is a pure function of
    // the source leg, so a leg reorged out and re-mined ALWAYS re-derives the identical id;
    // without the revive the IGNORE would no-op against the stale 'retracted' row and the
    // re-formed transfer would strand, unmirrored, for good. A row already 'finalized' is
    // left untouched by the status guard, which is what keeps the double-finalize dedupe.
    //
    // The revive rewrites EVERY column the new round chose, not just the signatures: the
    // signatures cover the canonical at the new round's snapshot_block and effective_time,
    // so a revived row that kept the retracted round's height is a row whose signature set
    // no indexer can verify against the capability snapshot it names. push_generation is
    // the re-mined leg's fence (the follower pinned it to its own indexer view) and the
    // chain id is re-stamped for the same reason it is stamped at all.
    async insertBridgeTransfer(row){
        let cols = this.constructor.BRIDGE_TRANSFER_COLUMNS;
        let res = await this.doQuery(
            'INSERT IGNORE INTO bridge_transfers (' + cols.join(', ') + ') VALUES (' +
            cols.map(() => '?').join(', ') + ')',
            cols.map(c => row[c]));
        if(res && Number(res.affectedRows) > 0) return true;
        let revive = await this.doQuery(
            "UPDATE bridge_transfers SET status = 'finalized', validator_signatures = ?, " +
            'finalizing_view = ?, effective_time = ?, snapshot_block = ?, push_generation = ?, ' +
            "btc_chain_id = ? WHERE transfer_id = ? AND status = 'retracted'",
            [row.validator_signatures, row.finalizing_view, row.effective_time, row.snapshot_block,
             row.push_generation, row.btc_chain_id, row.transfer_id]);
        return !!(revive && Number(revive.affectedRows) > 0);
    },

    // Every (tick, src_chain, dest_chain) triple this hub has ever finalized on one
    // network. The policy poll derives its candidate (origin_chain, tick) pairs from it,
    // and the invariant read derives which chains hold a copy of a tick.
    //
    // Direction is NOT a column (base spec D19: it is derived from the chains, and every
    // canonical field is a byte-match obligation forever), so the caller resolves which
    // side of a triple is the origin rather than reading it here.
    async getBridgeTransferChainPairs(network){
        return await this.doQuery(
            'SELECT DISTINCT tick, src_chain, dest_chain FROM bridge_transfers ' +
            "WHERE network = ? AND status = 'finalized' ORDER BY tick, src_chain, dest_chain",
            [String(network || '')]);
    },

    // Finalized transfers whose effective_time has NOT passed yet: signed, mirrored, and
    // not applyable on any destination until the block loop's protocol time reaches the
    // stamp. They are the "signed but unapplied" half of the invariant's in-flight term.
    //
    // Amounts come back as the raw decimal strings the record carries. SQL SUM() would
    // coerce them through a float and silently lose the low digits of an 18-decimal
    // token, so the caller sums them with bcmath instead.
    async getInFlightBridgeTransfers(network, nowSeconds, tick){
        let args = [String(network || ''), Number(nowSeconds)];
        let sql = 'SELECT tick, dest_chain, amount FROM bridge_transfers ' +
                  "WHERE network = ? AND status = 'finalized' AND effective_time > ?";
        if(tick){ sql += ' AND tick = ?'; args.push(String(tick)); }
        return await this.doQuery(sql, args);
    },

    // True when this hub already holds a non-retracted record for a source leg, so the
    // poll does not re-propose a round for a transfer it has finalized. Keyed on
    // (src_chain, src_action_index), the leg's own identity, the same key transfer_id is
    // derived from.
    async bridgeTransferExistsForSource(network, srcChain, srcActionIndex){
        let rows = await this.doQuery(
            'SELECT 1 FROM bridge_transfers WHERE network = ? AND src_chain = ? AND ' +
            "src_action_index = ? AND status <> 'retracted' LIMIT 1",
            [String(network || ''), String(srcChain || ''), Number(srcActionIndex)]);
        return !!(rows && rows.length);
    },

    // The subset of `srcActionIndexes` this hub holds a non-retracted record for on one
    // source chain, as a Set of numbers. The poll reads this ONCE per chain per tick over
    // the page the indexer returned, so a leg the hub has already finalized (which a lagging
    // indexer mirror can still list as pending) is dropped from both the round attempt and
    // the invariant's in-flight term without a query per leg. Non-integer inputs are
    // dropped before the query rather than bound, so a malformed page cannot widen the IN.
    async getBridgeTransferSourceIndexes(network, srcChain, srcActionIndexes){
        let wanted = [...new Set((srcActionIndexes || []).filter(n => Number.isInteger(n)))];
        if(!wanted.length) return new Set();
        let rows = await this.doQuery(
            'SELECT src_action_index FROM bridge_transfers WHERE network = ? AND src_chain = ? AND ' +
            "status <> 'retracted' AND src_action_index IN (" + wanted.map(() => '?').join(', ') + ')',
            [String(network || ''), String(srcChain || '')].concat(wanted));
        return new Set((rows || []).map(r => Number(r.src_action_index)));
    },

    // The transfer_id of this hub's persisted, non-retracted record for one source leg, or
    // null when it holds none. A follower's _validateTransfer reads this rather than
    // bridgeTransferExistsForSource's boolean because it has to tell "this row IS the
    // persisted record" (same id, a legitimate re-validation) from "a record for this leg
    // already exists under a DIFFERENT id" (a preimage the honest derivation never yields,
    // now that the id is a function of the leg alone).
    async getBridgeTransferIdForSource(network, srcChain, srcActionIndex){
        let rows = await this.doQuery(
            'SELECT transfer_id FROM bridge_transfers WHERE network = ? AND src_chain = ? AND ' +
            "src_action_index = ? AND status <> 'retracted' LIMIT 1",
            [String(network || ''), String(srcChain || ''), Number(srcActionIndex)]);
        return (rows && rows.length) ? String(rows[0].transfer_id) : null;
    },

    // Reads rows from bridge_transfers.
    // Moved here from src/api.js:2204.
    async findBridgeTransfers(since, limit) {
        return this.doQuery(`SELECT * FROM bridge_transfers WHERE id > ? AND status <> 'retracted' ORDER BY id ASC LIMIT ?`, [since, limit]);
    },

    // Updates bridge_transfers.
    // Moved here from src/cross_chain/bridge_engine.js:1157.
    async updateBridgeTransfer(transfer_id) {
        return this.doQuery(`UPDATE bridge_transfers SET status = 'retracted' WHERE transfer_id = ?`, [transfer_id]);
    },

    // Reads one committed transfer row back whole, for the hub-DB mirror stream.
    // Moved here from src/cross_chain/bridge_engine.js:1113, which read either this table
    // or policy_snapshots through one statement built from the table name.
    async getBridgeTransferByTransferId(transferId) {
        return this.doQuery('SELECT * FROM bridge_transfers WHERE transfer_id = ? LIMIT 1', [transferId]);
    },

    // Finalized transfers whose SOURCE leg sits in a rolled-back range, for retraction.
    // Moved here from src/cross_chain/bridge_engine.js:1154.
    //
    // `bounded` closes the range at `to`, so a leg re-published inside the original
    // open-ended range survives a deferred retraction; `fenced` limits the match to rows
    // stamped at or below generation `gen`, so a leg re-finalized at a recycled source
    // action_index survives. The caller normalizes and validates the bounds; this only
    // binds them.
    async findFinalizedBridgeTransferIdsForReorg(chain, from, to, gen, bounded, fenced) {
        let where = "status = 'finalized' AND src_chain = ? AND src_action_index >= ?" +
                    (bounded ? ' AND src_action_index <= ?' : '') +
                    (fenced  ? ' AND push_generation <= ?' : '');
        let params = [chain, from];
        if(bounded) params.push(to);
        if(fenced)  params.push(gen);
        return this.doQuery(
            'SELECT transfer_id FROM bridge_transfers WHERE ' + where, params);
    }
};
