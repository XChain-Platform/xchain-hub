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
 * XChain Hub - query methods for the cross-chain call and DEX match tables.
 *
 * Owns src/sql/cross_chain_calls.sql, src/sql/cross_chain_matches.sql.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

// Read-only surface column list for the relay-row API (getCall/listCalls).
// Excludes the heavy validator_signatures blob, the hub-side-only ANCHOR audit
// columns (batch_seq/archived_status/anchor_txid), and the mirror-internal
// consensus fences (finalizing_view/push_generation): those serve signature
// verification and reorg fencing, not operator/explorer display.
// Moved here from src/CrossChainCallEngine.js:133.
const CALL_SURFACE_COLS = 'id, call_id, phase, snapshot_block, network, source_chain, ' +
    'source_action_index, source_contract_index, target_chain, target_contract_index, ' +
    'method, params_json, gas_limit, cross_hops, effective_time, status, result_status, ' +
    'return_payload_b64, created_at';

// The listCalls filters, as [caller key, column], in the order their clauses join the
// WHERE. Fixed here so a filter key only ever selects a column from this list: the
// caller's filter object supplies values, never SQL.
const CALL_LIST_FILTERS = [
    ['sourceChain', 'source_chain'],
    ['targetChain', 'target_chain'],
    ['status',      'status'],
    ['phase',       'phase']
];

// The column list a finalized cross_chain_calls row is written with.
// Moved here from src/CrossChainCallEngine.js:850.
const CALL_FINALIZED_COLS = ['call_id','phase','snapshot_block','network',
                    'source_chain','source_action_index','source_contract_index',
                    'target_chain','target_contract_index','method','params_json',
                    'gas_limit','cross_hops','effective_time','result_status','return_payload_b64',
                    'finalizing_view','validator_signatures','push_generation',
                    'btc_chain_id',
                    // The admission map, one column per chain in the row's read set
                    // (target_chain OR source_chain). Inside the signed canonical. APPENDED
                    // at the end deliberately: this list's positional order is mirrored by
                    // hand in the engine's unit-test fake, so inserting mid-list silently
                    // re-maps every column after the insertion point in that stand-in.
                    'admit_block_btc','admit_block_ltc','admit_block_doge'];

// The range clause both reorg-retraction statements share, and its params. Built only
// from fixed fragments: `bounded` and `fenced` choose which clauses join, and every
// bound is a bound parameter. Moved here from src/CrossChainCallEngine.js:1125.
function crossChainCallRetractionTail(chain, bounds) {
    let tail = " AND source_chain = ? AND source_action_index >= ?" +
               (bounds.bounded ? " AND source_action_index <= ?" : "") +
               (bounds.fenced ? " AND push_generation <= ?" : "");
    let params = [chain, bounds.from];
    if(bounds.bounded) params.push(bounds.to);
    if(bounds.fenced) params.push(bounds.gen);
    return { tail, params };
}

// The cross_chain_matches columns createCrossChainMatch writes, in bind order.
// `btc_chain_id` is the one value not read off the match row (see that method).
// The admission map, one column per chain, is inside the signed canonical, unlike
// btc_chain_id, so it is read off the row with everything else. It is APPENDED at
// the end: this list's positional order is mirrored by hand in the engine's
// unit-test fake, and a mid-list insert re-maps every column after it there while
// the production INSERT stays correct.
const CROSS_CHAIN_MATCH_COLUMNS = ['match_id','snapshot_block','network',
    'a_chain','a_action_index','a_kind','a_tick','a_amount','a_filled_before','a_ownership','a_payout_addr','a_payout_legs',
    'b_chain','b_action_index','b_kind','b_tick','b_amount','b_filled_before','b_ownership','b_payout_addr','b_payout_legs',
    'effective_time','finalizing_view','validator_signatures','a_push_generation','b_push_generation',
    'btc_chain_id',
    'admit_block_btc','admit_block_ltc','admit_block_doge'];

module.exports = {
    // Reads rows from cross_chain_calls.
    // Moved here from src/anchor/publisher.js:2491.
    async findCrossChainCallsByBatchSeq(maxBatch) {
        return this.doQuery('SELECT * FROM cross_chain_calls WHERE batch_seq IS NULL OR archived_status <> status ORDER BY call_id ASC, phase ASC LIMIT ?', [maxBatch]);
    },

    // Reads rows from cross_chain_calls.
    // Moved here from src/api.js:2145.
    async findCrossChainCallsById(since, limit) {
        return this.doQuery(`SELECT id, call_id, phase, snapshot_block, network, source_chain, source_action_index, source_contract_index, target_chain, target_contract_index, method, params_json, gas_limit, cross_hops, effective_time, status, finalizing_view, push_generation, result_status, return_payload_b64, validator_signatures, btc_chain_id, created_at FROM cross_chain_calls WHERE id > ? AND status <> 'retracted' ORDER BY id ASC LIMIT ?`, [since, limit]);
    },

    // Reads rows from cross_chain_calls.
    // Moved here from src/CrossChainCallEngine.js:283.
    async findCrossChainCallsByPhase() {
        return this.doQuery(`SELECT d.target_chain, COUNT(*) AS pending_relay_count FROM cross_chain_calls d LEFT JOIN cross_chain_calls r ON r.call_id = d.call_id AND r.phase = 'result' AND r.status <> 'retracted' WHERE d.phase = 'dispatch' AND d.status = 'finalized' AND r.id IS NULL GROUP BY d.target_chain`);
    },

    // Reads rows from cross_chain_matches.
    // Moved here from src/anchor/publisher.js:2488.
    async findCrossChainMatchesByBatchSeq(maxBatch) {
        return this.doQuery('SELECT * FROM cross_chain_matches WHERE batch_seq IS NULL OR archived_status <> status ORDER BY match_id ASC LIMIT ?', [maxBatch]);
    },

    // Reads rows from cross_chain_matches.
    // Moved here from src/api.js:2099.
    async findCrossChainMatchesById(since, limit) {
        return this.doQuery(`SELECT * FROM cross_chain_matches WHERE id > ? AND status <> 'retracted' ORDER BY id ASC LIMIT ?`, [since, limit]);
    },

    // Reads rows from cross_chain_matches.
    // Moved here from src/CrossChainDexEngine.js:240.
    async findCrossChainMatchesByStatus() {
        return this.doQuery(`SELECT a_chain, a_action_index, a_amount, b_chain, b_action_index, b_amount FROM cross_chain_matches WHERE status = 'finalized'`);
    },

    // Reads one row from cross_chain_calls.
    // Moved here from src/CrossChainCallEngine.js:770.
    async getCrossChainCallByCallId(call_id) {
        return this.doQuery(`SELECT * FROM cross_chain_calls WHERE call_id = ? AND phase = 'dispatch' AND status <> 'retracted' LIMIT 1`, [call_id]);
    },

    // Reads one row from cross_chain_calls.
    // Moved here from src/CrossChainCallEngine.js:998, src/anchor/publisher.js:3598, src/anchor/publisher.js:4502.
    async getCrossChainCallByCallIdAndPhase(call_id, phase) {
        return this.doQuery('SELECT * FROM cross_chain_calls WHERE call_id = ? AND phase = ? LIMIT 1', [call_id, phase]);
    },

    // Reads one row from cross_chain_calls.
    // Moved here from src/HubDbBroadcaster.js:667.
    async getCrossChainCallsMaxLiveId() {
        return this.doQuery(`SELECT MAX(id) AS max_id FROM cross_chain_calls WHERE status <> 'retracted'`);
    },

    // Reads one row from cross_chain_matches.
    // Moved here from src/CrossChainDexEngine.js:997, src/anchor/publisher.js:3560, src/anchor/publisher.js:4492.
    async getCrossChainMatchByMatchId(match_id) {
        return this.doQuery('SELECT * FROM cross_chain_matches WHERE match_id = ? LIMIT 1', [match_id]);
    },

    // Reads one row from cross_chain_matches.
    // Moved here from src/HubDbBroadcaster.js:643.
    async getCrossChainMatchesMaxLiveId() {
        return this.doQuery(`SELECT MAX(id) AS max_id FROM cross_chain_matches WHERE status <> 'retracted'`);
    },

    // Reads one row from cross_chain_matches.
    // Moved here from src/anchor/publisher.js:4808.
    async getNextAnchorBatchSeq() {
        return this.doQuery('SELECT COALESCE(GREATEST(  COALESCE((SELECT MAX(batch_seq) FROM cross_chain_matches), -1),   COALESCE((SELECT MAX(batch_seq) FROM cross_chain_calls), -1),   COALESCE((SELECT MAX(batch_seq) FROM validator_rewards), -1)), -1) + 1 AS next_seq');
    },

    // Probes for a matching row in cross_chain_calls.
    // Moved here from src/CrossChainCallEngine.js:1174.
    async hasCrossChainCalls(callId, phase) {
        return this.doQuery(`SELECT 1 FROM cross_chain_calls WHERE call_id = ? AND phase = ? AND status <> 'retracted' LIMIT 1`, [callId, phase]);
    },

    // Updates cross_chain_calls.
    // Moved here from src/anchor/publisher.js:4783.
    async updateCrossChainCall(batchSeq, status, txid, call_id, phase) {
        return this.doQuery('UPDATE cross_chain_calls SET batch_seq = ?, archived_status = ?, anchor_txid = COALESCE(?, anchor_txid) WHERE call_id = ? AND phase = ? AND (batch_seq IS NULL OR archived_status <> status)', [batchSeq, status, txid, call_id, phase]);
    },

    // Updates cross_chain_matches.
    // Moved here from src/CrossChainDexEngine.js:968.
    async updateCrossChainMatchByMatchId(validator_signatures, finalizing_view, effective_time, match_id) {
        return this.doQuery(`UPDATE cross_chain_matches SET status = 'finalized', validator_signatures = ?, finalizing_view = ?, effective_time = ? WHERE match_id = ? AND status = 'retracted'`, [validator_signatures, finalizing_view, effective_time, match_id]);
    },

    // Updates cross_chain_matches.
    // Moved here from src/anchor/publisher.js:4759.
    async updateCrossChainMatchByMatchIdAndBatchSeq(batchSeq, status, txid, match_id) {
        return this.doQuery('UPDATE cross_chain_matches SET batch_seq = ?, archived_status = ?, anchor_txid = COALESCE(?, anchor_txid) WHERE match_id = ? AND (batch_seq IS NULL OR archived_status <> status)', [batchSeq, status, txid, match_id]);
    },

    // Updates cross_chain_matches.
    // Moved here from src/CrossChainDexEngine.js:1136.
    async updateCrossChainMatchRetracted(match_id) {
        return this.doQuery(`UPDATE cross_chain_matches SET status = 'retracted' WHERE match_id = ?`, [match_id]);
    },

    // Reads both phases of one XCALL relay, retracted rows included, with the surface
    // columns only. Moved here from src/CrossChainCallEngine.js:304.
    async findCrossChainCallPhasesByCallId(callId) {
        return this.doQuery(
            'SELECT ' + CALL_SURFACE_COLS + " FROM cross_chain_calls WHERE call_id = ? ORDER BY phase",
            [callId]);
    },

    // Reads a newest-first page of relay rows with any of the listCalls filters.
    // Moved here from src/CrossChainCallEngine.js:317. The caller clamps `limit`.
    async findCrossChainCallsForSurface(filters, limit) {
        let where = [];
        let args  = [];
        for(let [key, col] of CALL_LIST_FILTERS){
            if(filters[key]){ where.push(col + ' = ?'); args.push(String(filters[key])); }
        }
        let sql = 'SELECT ' + CALL_SURFACE_COLS + ' FROM cross_chain_calls';
        if(where.length) sql += ' WHERE ' + where.join(' AND ');
        sql += ' ORDER BY id DESC LIMIT ?';
        args.push(limit);
        return this.doQuery(sql, args);
    },

    // Reads the finalized dispatches on one target chain that still have no live result
    // row, skipping the call_ids parked in the result backoff. Moved here from
    // src/CrossChainCallEngine.js:451. The parked ids are bound one placeholder each;
    // their count is all they change about the statement.
    async findCrossChainCallDispatchesAwaitingResult(targetChain, parkedCallIds) {
        let exclude = parkedCallIds.length ? (" AND d.call_id NOT IN (" + parkedCallIds.map(() => '?').join(',') + ")") : "";
        return this.doQuery(
            "SELECT d.* FROM cross_chain_calls d " +
            "LEFT JOIN cross_chain_calls r ON r.call_id = d.call_id AND r.phase = 'result' AND r.status <> 'retracted' " +
            "WHERE d.phase = 'dispatch' AND d.status = 'finalized' AND d.target_chain = ? AND r.id IS NULL" + exclude +
            " ORDER BY d.id ASC LIMIT 100", [targetChain, ...parkedCallIds]);
    },

    // Writes one finalized cross_chain_calls row, stamping btc_chain_id into the value
    // list rather than onto the row. Moved here from src/CrossChainCallEngine.js:879.
    //
    // A retracted row for the same (call_id, phase) can exist after a reorg.
    // INSERT IGNORE would silently discard the re-finalized content, leaving
    // the call permanently stranded in 'retracted'. Use ON DUPLICATE KEY UPDATE
    // to overwrite a retracted row with the current quorum's content so the
    // re-mined call can proceed normally.
    async setCrossChainCallFinalized(row, btcChainId) {
        let cols = CALL_FINALIZED_COLS;
        let vals = cols.map(c => (c === 'btc_chain_id' ? btcChainId : row[c]));
        let updateCols = cols.filter(c => c !== 'call_id' && c !== 'phase');
        return this.doQuery(
            'INSERT INTO cross_chain_calls (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')' +
            ' ON DUPLICATE KEY UPDATE ' + updateCols.map(c => c + ' = VALUES(' + c + ')').join(', ') +
            ", status = 'finalized'",
            vals);
    },

    // Reads the finalized cross_chain_calls rows a reorg retraction covers.
    // Moved here from src/CrossChainCallEngine.js:1131.
    async findFinalizedCrossChainCallsInRetractionRange(chain, bounds) {
        let { tail, params } = crossChainCallRetractionTail(chain, bounds);
        return this.doQuery("SELECT id, call_id, phase FROM cross_chain_calls WHERE status = 'finalized'" + tail, params);
    },

    // Marks the finalized cross_chain_calls rows a reorg retraction covers 'retracted'.
    // Moved here from src/CrossChainCallEngine.js:1133.
    async updateCrossChainCallsRetractedInRange(chain, bounds) {
        let { tail, params } = crossChainCallRetractionTail(chain, bounds);
        return this.doQuery("UPDATE cross_chain_calls SET status = 'retracted' WHERE status = 'finalized'" + tail, params);
    },

    // Reads the non-retracted cross_chain_matches rows among an explicit set of match ids,
    // for the anchor-stamp re-broadcast. Moved here from src/anchor/publisher.js:4732.
    // The ids are bound one placeholder each; their count is all they change.
    async findLiveCrossChainMatchesByMatchIds(matchIds) {
        return this.doQuery(
            "SELECT * FROM cross_chain_matches WHERE match_id IN (" + matchIds.map(() => '?').join(', ') + ") AND status <> 'retracted'",
            matchIds);
    },

    // Writes one finalized match row, idempotently.
    // Moved here from src/CrossChainDexEngine.js:952.
    //
    // INSERT IGNORE: match_id is unique, so a re-finalize (another hub, or a restart
    // racing the poll) is a harmless no-op, and the caller reads affectedRows to credit
    // the committed ledger only once per fill. `btcChainId` is resolved by the caller
    // into the value list rather than onto `row`: the row object is what the canonical,
    // the ledger and the retraction paths read, and btc_chain_id is transport, never
    // consensus, so it has no path into a signed preimage.
    async createCrossChainMatch(row, btcChainId) {
        return this.doQuery(
            'INSERT IGNORE INTO cross_chain_matches (' + CROSS_CHAIN_MATCH_COLUMNS.join(', ') + ') VALUES (' + CROSS_CHAIN_MATCH_COLUMNS.map(() => '?').join(', ') + ')',
            CROSS_CHAIN_MATCH_COLUMNS.map(c => (c === 'btc_chain_id' ? btcChainId : row[c])));
    },

    // Finalized matches with a leg on a reorged chain, for retraction.
    // Moved here from src/CrossChainDexEngine.js:1125.
    //
    // Two-sided: the per-leg clause applies to whichever leg (a/b) is on `chain`, and each
    // leg is fenced by ITS OWN push generation. `bounded` closes the range at `to` so a leg
    // re-published inside the original open-ended range survives a deferred retraction;
    // `fenced` keeps a leg re-finalized at a recycled action_index (higher generation). The
    // caller normalizes and validates the bounds; this only binds them.
    async findFinalizedCrossChainMatchesForReorg(chain, from, to, gen, bounded, fenced) {
        let legClause = (col, gcol) => "(" + col + "_chain = ? AND " + col + "_action_index >= ?" +
            (bounded ? " AND " + col + "_action_index <= ?" : "") +
            (fenced ? " AND " + gcol + " <= ?" : "") + ")";
        let legParams = () => {
            let p = [chain, from];
            if(bounded) p.push(to);
            if(fenced) p.push(gen);
            return p;
        };
        let where = "status = 'finalized' AND (" + legClause('a', 'a_push_generation') + " OR " + legClause('b', 'b_push_generation') + ")";
        return this.doQuery(
            "SELECT match_id, a_chain, a_action_index, a_amount, b_chain, b_action_index, b_amount FROM cross_chain_matches WHERE " + where,
            legParams().concat(legParams()));
    }
};
