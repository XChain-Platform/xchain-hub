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

module.exports = {
    // Reads rows from cross_chain_calls.
    // Moved here from src/StateAnchorPublisher.js:2491.
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
    // Moved here from src/StateAnchorPublisher.js:2488.
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
    // Moved here from src/CrossChainCallEngine.js:998, src/StateAnchorPublisher.js:3598, src/StateAnchorPublisher.js:4502.
    async getCrossChainCallByCallIdAndPhase(call_id, phase) {
        return this.doQuery('SELECT * FROM cross_chain_calls WHERE call_id = ? AND phase = ? LIMIT 1', [call_id, phase]);
    },

    // Reads one row from cross_chain_calls.
    // Moved here from src/HubDbBroadcaster.js:667.
    async getCrossChainCallsMaxLiveId() {
        return this.doQuery(`SELECT MAX(id) AS max_id FROM cross_chain_calls WHERE status <> 'retracted'`);
    },

    // Reads one row from cross_chain_matches.
    // Moved here from src/CrossChainDexEngine.js:997, src/StateAnchorPublisher.js:3560, src/StateAnchorPublisher.js:4492.
    async getCrossChainMatchByMatchId(match_id) {
        return this.doQuery('SELECT * FROM cross_chain_matches WHERE match_id = ? LIMIT 1', [match_id]);
    },

    // Reads one row from cross_chain_matches.
    // Moved here from src/HubDbBroadcaster.js:643.
    async getCrossChainMatchesMaxLiveId() {
        return this.doQuery(`SELECT MAX(id) AS max_id FROM cross_chain_matches WHERE status <> 'retracted'`);
    },

    // Reads one row from cross_chain_matches.
    // Moved here from src/StateAnchorPublisher.js:4808.
    async getNextAnchorBatchSeq() {
        return this.doQuery('SELECT COALESCE(GREATEST(  COALESCE((SELECT MAX(batch_seq) FROM cross_chain_matches), -1),   COALESCE((SELECT MAX(batch_seq) FROM cross_chain_calls), -1),   COALESCE((SELECT MAX(batch_seq) FROM validator_rewards), -1)), -1) + 1 AS next_seq');
    },

    // Probes for a matching row in cross_chain_calls.
    // Moved here from src/CrossChainCallEngine.js:1174.
    async hasCrossChainCalls(callId, phase) {
        return this.doQuery(`SELECT 1 FROM cross_chain_calls WHERE call_id = ? AND phase = ? AND status <> 'retracted' LIMIT 1`, [callId, phase]);
    },

    // Updates cross_chain_calls.
    // Moved here from src/StateAnchorPublisher.js:4783.
    async updateCrossChainCall(batchSeq, status, txid, call_id, phase) {
        return this.doQuery('UPDATE cross_chain_calls SET batch_seq = ?, archived_status = ?, anchor_txid = COALESCE(?, anchor_txid) WHERE call_id = ? AND phase = ? AND (batch_seq IS NULL OR archived_status <> status)', [batchSeq, status, txid, call_id, phase]);
    },

    // Updates cross_chain_matches.
    // Moved here from src/CrossChainDexEngine.js:968.
    async updateCrossChainMatchByMatchId(validator_signatures, finalizing_view, effective_time, match_id) {
        return this.doQuery(`UPDATE cross_chain_matches SET status = 'finalized', validator_signatures = ?, finalizing_view = ?, effective_time = ? WHERE match_id = ? AND status = 'retracted'`, [validator_signatures, finalizing_view, effective_time, match_id]);
    },

    // Updates cross_chain_matches.
    // Moved here from src/StateAnchorPublisher.js:4759.
    async updateCrossChainMatchByMatchIdAndBatchSeq(batchSeq, status, txid, match_id) {
        return this.doQuery('UPDATE cross_chain_matches SET batch_seq = ?, archived_status = ?, anchor_txid = COALESCE(?, anchor_txid) WHERE match_id = ? AND (batch_seq IS NULL OR archived_status <> status)', [batchSeq, status, txid, match_id]);
    },

    // Updates cross_chain_matches.
    // Moved here from src/CrossChainDexEngine.js:1136.
    async updateCrossChainMatchRetracted(match_id) {
        return this.doQuery(`UPDATE cross_chain_matches SET status = 'retracted' WHERE match_id = ?`, [match_id]);
    }
};
