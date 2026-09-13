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
 * XChain Hub - query methods for the ATTEST request, response and batch tables.
 *
 * Owns src/sql/attestations.sql, src/sql/attestation_responses.sql, src/sql/attestation_fetch_cache.sql, src/sql/attestation_validator_stats.sql, src/sql/attest_published_requests.sql, src/sql/attest_published_batches.sql.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

module.exports = {
    // Deletes from attest_published_batches.
    // Moved here from src/AttestationBatchPublisher.js:1322.
    async deleteAttestPublishedBatch(network, windowStart, status) {
        return this.doQuery('DELETE FROM attest_published_batches WHERE network = ? AND window_start = ? AND status = ?', [network, windowStart, status]);
    },

    // Deletes from attest_published_requests.
    // Moved here from src/AttestationPublisher.js:728.
    async deleteAttestPublishedRequest(rid) {
        return this.doQuery('DELETE FROM attest_published_requests WHERE request_id = ? AND sent_at IS NULL', [rid]);
    },

    // Deletes from attestations.
    // Moved here from src/ReorgHandler.js:626.
    async deleteAttestation(chain, bound) {
        return this.doQuery('DELETE FROM attestations WHERE source_chain = ? AND created_at > FROM_UNIXTIME(? / 1000)', [chain, bound]);
    },

    // Deletes from attestation_fetch_cache.
    // Moved here from src/AttestationRound.js:467.
    async deleteAttestationFetchCache(created_at) {
        return this.doQuery('DELETE FROM attestation_fetch_cache WHERE created_at < FROM_UNIXTIME(?)', [created_at]);
    },

    // Reads rows from attest_published_requests.
    // Moved here from src/AttestationPublisher.js:680.
    async findAllAttestPublishedRequests() {
        return this.doQuery('SELECT request_id, sent_at, sent_statuses, intent_status FROM attest_published_requests');
    },

    // Reads rows from attest_published_batches.
    // Moved here from src/AttestationBatchPublisher.js:1282.
    async findAttestPublishedBatchesByNetwork(network, windowStart) {
        return this.doQuery('SELECT network, window_start, window_end, batch_key, row_count, txid, status FROM attest_published_batches WHERE network = ? AND window_start = ?', [network, windowStart]);
    },

    // Reads rows from attest_published_batches.
    // Moved here from src/AttestationBatchPublisher.js:1295.
    async findAttestPublishedBatchesByNetworkAndStatus(network, status) {
        return this.doQuery('SELECT window_start FROM attest_published_batches WHERE network = ? AND status = ?', [network, status]);
    },

    // Reads rows from attest_published_requests.
    // Moved here from src/AttestationPublisher.js:616.
    async findAttestPublishedRequestsByRequestId(rid) {
        return this.doQuery('SELECT request_id, txid, sent_at, sent_statuses, intent_status FROM attest_published_requests WHERE request_id = ?', [rid]);
    },

    // Reads rows from attestation_fetch_cache.
    // Moved here from src/AttestationRound.js:417.
    async findAttestationFetchCache(rid, created_at) {
        return this.doQuery('SELECT status, body, meta FROM attestation_fetch_cache WHERE request_id = ? AND created_at >= FROM_UNIXTIME(?)', [rid, created_at]);
    },

    // Reads rows from attestation_responses.
    // Moved here from src/api.js:2284.
    async findAttestationResponsesById(since, limit) {
        return this.doQuery('SELECT id, network, request_id, request_action_index, request_block_index, provider_id, status, response_payload, response_hash, meta, effective_time, signer_pubkeys, signatures, widen, batch_action_index, finalized_at FROM attestation_responses WHERE id > ? ORDER BY id ASC LIMIT ?', [since, limit]);
    },

    // Reads rows from attestation_responses.
    // Moved here from src/AttestationResponseMirror.js:699.
    async findAttestationResponsesByNetwork(network, actionIndex, windowStart, windowEnd) {
        return this.doQuery('SELECT id, network, request_id, effective_time FROM attestation_responses WHERE network = ? AND batch_action_index = ? AND effective_time >= ? AND effective_time < ?', [network, actionIndex, windowStart, windowEnd]);
    },

    // Reads one row from attest_published_batches.
    // Moved here from src/AttestationBatchPublisher.js:401.
    async getAttestPublishedBatch(network) {
        return this.doQuery('SELECT MIN(window_start) AS oldest, MAX(window_start) AS newest FROM attest_published_batches WHERE network = ?', [network]);
    },

    // Reads one row from attestations.
    // Moved here from src/CrossChainEngine.js:724.
    async getAttestation(attestationId) {
        return this.doQuery('SELECT * FROM attestations WHERE attestation_id = ? LIMIT 1', [attestationId]);
    },

    // Reads one row from attestation_responses.
    // Moved here from src/AttestationResponseMirror.js:1023.
    async getAttestationResponse(network, request_id, effective_time) {
        return this.doQuery('SELECT id FROM attestation_responses WHERE network = ? AND request_id = ? AND effective_time = ? LIMIT 1', [network, request_id, effective_time]);
    },

    // Reads one row from attestation_responses.
    // Moved here from src/HubDbBroadcaster.js:680.
    async getAttestationResponsesMaxId() {
        return this.doQuery('SELECT MAX(id) AS max_id FROM attestation_responses');
    },

    // Inserts or updates a row in attest_published_batches.
    // Moved here from src/AttestationBatchPublisher.js:1310.
    async setAttestPublishedBatchByNetwork(network, window_start, window_end, batchKey, row_count, status) {
        return this.doQuery('INSERT INTO attest_published_batches (network, window_start, window_end, batch_key, row_count, status) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE window_start = window_start', [network, window_start, window_end, batchKey, row_count, status]);
    },

    // Inserts or updates a row in attest_published_batches.
    // Moved here from src/AttestationBatchPublisher.js:1350.
    async setAttestPublishedBatchByNetworkAndWindowStart(network, windowStart, windowEnd, rowCount, status) {
        return this.doQuery('INSERT INTO attest_published_batches (network, window_start, window_end, row_count, status) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status), row_count = VALUES(row_count)', [network, windowStart, windowEnd, rowCount, status]);
    },

    // Inserts or updates a row in attest_published_batches.
    // Moved here from src/AttestationBatchPublisher.js:1368.
    async setAttestPublishedBatchByNetworkAndWindowStartAndWindowEnd(network, windowStart, windowEnd, rowCount, txidOrNull, status) {
        return this.doQuery('INSERT INTO attest_published_batches (network, window_start, window_end, row_count, txid, status, landed_at) VALUES (?, ?, ?, ?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE status = VALUES(status), landed_at = NOW(), row_count = VALUES(row_count), txid = COALESCE(attest_published_batches.txid, VALUES(txid))', [network, windowStart, windowEnd, rowCount, txidOrNull, status]);
    },

    // Inserts or updates a row in attest_published_requests.
    // Moved here from src/AttestationPublisher.js:632.
    async setAttestPublishedRequest(rid, intent_status) {
        return this.doQuery('INSERT INTO attest_published_requests (request_id, intent_status) VALUES (?, ?) ON DUPLICATE KEY UPDATE intent_status = VALUES(intent_status)', [rid, intent_status]);
    },

    // Inserts or updates a row in attestation_fetch_cache.
    // Moved here from src/AttestationRound.js:448.
    async setAttestationFetchCache(rid, provider_id, status, body, meta, model) {
        return this.doQuery('INSERT INTO attestation_fetch_cache (request_id, provider_id, status, body, meta, model) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE provider_id = VALUES(provider_id), status = VALUES(status), body = VALUES(body), meta = VALUES(meta), model = VALUES(model), created_at = CURRENT_TIMESTAMP', [rid, provider_id, status, body, meta, model]);
    },

    // Updates attest_published_batches.
    // Moved here from src/AttestationBatchPublisher.js:1334.
    async updateAttestPublishedBatch(status, txid, rowCount, network, windowStart, status2) {
        return this.doQuery('UPDATE attest_published_batches SET status = ?, txid = ?, row_count = ?, sent_at = NOW() WHERE network = ? AND window_start = ? AND status = ?', [status, txid, rowCount, network, windowStart, status2]);
    },

    // Updates attest_published_requests.
    // Moved here from src/AttestationPublisher.js:651.
    async updateAttestPublishedRequestByRequestId(txid, request_id, st, rid) {
        return this.doQuery(`UPDATE attest_published_requests SET txid = ?, sent_at = NOW(), intent_status = NULL, sent_statuses = IF(FIND_IN_SET(?, COALESCE(sent_statuses, '')) > 0, sent_statuses, CONCAT_WS(',', NULLIF(sent_statuses, ''), ?)) WHERE request_id = ?`, [txid, request_id, st, rid]);
    },

    // Updates attest_published_requests.
    // Moved here from src/AttestationPublisher.js:723.
    async updateAttestPublishedRequestByRequestIdAndIntentStatus(rid, intent_status) {
        return this.doQuery('UPDATE attest_published_requests SET intent_status = NULL WHERE request_id = ? AND intent_status = ?', [rid, intent_status]);
    },

    // Updates attestation_responses.
    // Moved here from src/AttestationResponseMirror.js:711.
    async updateAttestationResponseByNetwork(network, actionIndex, windowStart, windowEnd) {
        return this.doQuery('UPDATE attestation_responses SET batch_action_index = NULL WHERE network = ? AND batch_action_index = ? AND effective_time >= ? AND effective_time < ?', [network, actionIndex, windowStart, windowEnd]);
    },

    // Updates attestation_responses.
    // Moved here from src/AttestationResponseMirror.js:789.
    async updateAttestationResponseByNetworkAndRequestId(actionIndex, network, request_id, effective_time) {
        return this.doQuery('UPDATE attestation_responses SET batch_action_index = ? WHERE network = ? AND request_id = ? AND effective_time = ? AND batch_action_index IS NULL', [actionIndex, network, request_id, effective_time]);
    },

    // Reads the newest attestations rows, any status.
    // Moved here from src/CrossChainEngine.js:295, the branch that adds no status filter.
    async findAttestations(limit) {
        return this.doQuery("SELECT * FROM attestations ORDER BY created_at DESC LIMIT ?", [limit]);
    },

    // Reads the newest attestations rows in one status.
    // Moved here from src/CrossChainEngine.js:295, the branch that filters on status.
    async findAttestationsByStatus(status, limit) {
        return this.doQuery("SELECT * FROM attestations WHERE status = ? ORDER BY created_at DESC LIMIT ?", [status, limit]);
    },

    // Reads the newest attestations row for one source action.
    // Moved here from src/CrossChainEngine.js:308.
    async getAttestationBySourceAction(sourceChain, sourceActionIndex) {
        return this.doQuery("SELECT * FROM attestations WHERE source_chain = ? AND source_action_index = ? ORDER BY created_at DESC LIMIT 1", [sourceChain, sourceActionIndex]);
    },

    // Inserts or updates a row in attestations.
    // Moved here from src/CrossChainEngine.js:710. The last three arguments repeat
    // the mutable columns for the ON DUPLICATE KEY UPDATE clause.
    async setAttestation(attestation_id, source_chain, source_action_index, dest_chain, confirmations, status, validator_count, consensus_proof, statusOnDuplicate, validatorCountOnDuplicate, consensusProofOnDuplicate) {
        return this.doQuery(`INSERT INTO attestations
            (attestation_id, source_chain, source_action_index, dest_chain,
             confirmations, status, validator_count, consensus_proof)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE status = ?, validator_count = ?, consensus_proof = ?, updated_at = NOW()`, [
            attestation_id, source_chain, source_action_index,
            dest_chain, confirmations, status,
            validator_count, consensus_proof,
            statusOnDuplicate, validatorCountOnDuplicate, consensusProofOnDuplicate
        ]);
    }
};
