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

// The codec's own field list, read from the wire module rather than re-spelled here:
// the batch window is selected by the same names the encoder writes, so a field added
// to the wire cannot be silently absent from the read that feeds it.
const abw = require('../lib/attest_batch_wire.js');

// The durable spot-check outcome table the AttestationSpotChecker statements write,
// prune and aggregate; named once so its four statements cannot address two tables.
const STATS_TABLE = 'attestation_validator_stats';

// The attestation_responses columns the response mirror writes and selects back, in
// the order the snapshot route selects them. It is used for BOTH the INSERT and the
// select-back on purpose: the REST bootstrap and the WS stream must hand a consumer
// the SAME columns, and the way they drift apart is one path gaining a column the
// other does not know about. `id` is excluded: it is assigned by AUTO_INCREMENT and
// stripped again on apply, so it is a paging cursor and never an input.
//
// AttestationResponseMirror.MIRROR_COLUMNS spells the same list for the wire (its
// GOSSIP_COLUMNS derive from it); a column added to the table goes in both, and the
// mirror suite's every-column-written test fails when only one of them gains it.
const ATTESTATION_RESPONSE_MIRROR_COLUMNS = [
    'network', 'request_id', 'request_action_index', 'request_block_index',
    'provider_id', 'status', 'response_payload', 'response_hash', 'meta',
    'effective_time', 'admit_block_btc', 'signer_pubkeys', 'signatures', 'widen', 'batch_action_index',
    'finalized_at'
];

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

    // Retention sweep over the settled markers in attest_published_requests.
    // Moved here from src/AttestationPublisher.js:797.
    //
    // Seconds, and DB-clock arithmetic on both sides: sent_at is written by NOW(), so
    // comparing it against a Node-side timestamp would fold any host/DB clock skew
    // straight into the cutoff. A marker holding a quarantined intent is never swept
    // (intent_status IS NULL), and `excludeRequestIds` carries the request ids still on
    // the caller's durable queue, excluded by identity because a rid is a string rather
    // than an orderable round. The ids are bound as parameters, so the only thing this
    // builds from the list is the count of placeholders.
    async deleteSettledAttestPublishedRequests(windowSec, excludeRequestIds) {
        let excluded = Array.isArray(excludeRequestIds) ? excludeRequestIds : [];
        let sql = 'DELETE FROM attest_published_requests ' +
                  'WHERE sent_at IS NOT NULL AND intent_status IS NULL ' +
                  'AND sent_at < DATE_SUB(NOW(), INTERVAL ? SECOND)';
        let params = [windowSec];
        if (excluded.length > 0){
            sql += ' AND request_id NOT IN (' + excluded.map(() => '?').join(',') + ')';
            params = params.concat(excluded);
        }
        return this.doQuery(sql, params);
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
    },

    // One batch window's terminal rows, in the applier's own order.
    // Moved here from src/AttestationBatchPublisher.js:571.
    //
    // MEMBERSHIP IS THE SIGNED effective_time. It is the only column of this table two
    // hubs are guaranteed to read identically: it rides inside the canonical the
    // responsible set signed, so a boundary row falls on the same side of the same
    // instant on every hub that holds it. The idx_effective_time index is what makes
    // this range read a seek rather than a scan.
    //
    // `limit` is the caller's row cap plus one, so the caller can tell a full window
    // from an overflowing one; the caller normalizes the rows it gets back.
    async findAttestationResponsesInBatchWindow(network, windowStart, windowEnd, limit) {
        return this.doQuery(
            'SELECT ' + abw.ATTEST_BATCH_ROW_FIELDS.join(', ') + ' ' +
            'FROM attestation_responses ' +
            'WHERE network = ? AND effective_time >= ? AND effective_time < ? ' +
            // effective_time last: one request can hold two honest rows (a round that
            // finalized under two leader slots), and the window has to order them the
            // same way on every hub or the signed bytes differ.
            'ORDER BY request_block_index ASC, request_action_index ASC, request_id ASC, effective_time ASC ' +
            'LIMIT ?',
            [network, windowStart, windowEnd, limit]);
    },

    // Writes one finalized response row for the mirror, idempotently.
    // Moved here from src/AttestationResponseMirror.js:427.
    //
    // INSERT IGNORE against the UNIQUE (network, request_id, effective_time): a duplicate
    // is ordinary traffic, and insert-only means the existing row is already correct. A
    // column the writer never sets (batch_action_index at finalization) binds NULL
    // explicitly rather than riding the driver's treatment of undefined.
    async createAttestationResponseMirrorRow(row) {
        return this.doQuery(
            'INSERT IGNORE INTO attestation_responses (' + ATTESTATION_RESPONSE_MIRROR_COLUMNS.join(', ') + ') ' +
            'VALUES (' + ATTESTATION_RESPONSE_MIRROR_COLUMNS.map(() => '?').join(', ') + ')',
            ATTESTATION_RESPONSE_MIRROR_COLUMNS.map(c => (row[c] === undefined ? null : row[c])));
    },

    // Reads one mirrored response row back by its natural key, id included.
    // Moved here from src/AttestationResponseMirror.js:446 and :793, which issued the
    // same statement.
    //
    // The id is the consumer's paging cursor and only the table carries it, which is
    // why the mirror selects the row back rather than broadcasting the object it holds.
    async getAttestationResponseMirrorRow(network, requestId, effectiveTime) {
        return this.doQuery(
            'SELECT id, ' + ATTESTATION_RESPONSE_MIRROR_COLUMNS.join(', ') + ' ' +
            'FROM attestation_responses WHERE network = ? AND request_id = ? AND effective_time = ? LIMIT 1',
            [network, requestId, effectiveTime]);
    },

    // Records one judged spot-check outcome, idempotent per (validator, request).
    // Moved here from src/AttestationSpotChecker.js:562.
    //
    // The row is keyed by the request's creation block so a reorg can roll it back; a
    // re-judge of the same request overwrites the verdict rather than adding a row.
    async setAttestationValidatorStat(validatorPubkey, providerId, requestId, blockIndex, passed) {
        return this.doQuery(
            'INSERT INTO ' + STATS_TABLE +
            ' (validator_pubkey, provider_id, request_id, block_index, passed)' +
            ' VALUES (?, ?, ?, ?, ?)' +
            ' ON DUPLICATE KEY UPDATE passed = VALUES(passed),' +
            ' provider_id = VALUES(provider_id), block_index = VALUES(block_index)',
            [validatorPubkey, providerId, requestId, blockIndex, passed]
        );
    },

    // Retention sweep over the spot-check outcomes.
    // Moved here from src/AttestationSpotChecker.js:595.
    //
    // DB-clock arithmetic on BOTH sides: checked_at is written by CURRENT_TIMESTAMP, so
    // comparing it against a Node-side timestamp would fold host/DB clock skew straight
    // into the cutoff. The caller floors the window at its rolling failure window.
    async deleteAttestationValidatorStatsOlderThan(windowSec) {
        return this.doQuery(
            'DELETE FROM ' + STATS_TABLE + ' WHERE checked_at < DATE_SUB(NOW(), INTERVAL ? SECOND)',
            [windowSec]);
    },

    // Reorg rollback: every spot-check outcome anchored above `height` is orphaned.
    // Moved here from src/AttestationSpotChecker.js:644.
    async deleteAttestationValidatorStatsAboveBlock(height) {
        return this.doQuery(
            'DELETE FROM ' + STATS_TABLE + ' WHERE block_index > ?', [height]);
    },

    // Aggregate outcome counts for one validator: total rows and failed rows.
    // Moved here from src/AttestationSpotChecker.js:667.
    async getAttestationValidatorStatTotals(validatorPubkey) {
        return this.doQuery(
            'SELECT COUNT(*) AS total,' +
            ' SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) AS failed' +
            ' FROM ' + STATS_TABLE + ' WHERE validator_pubkey = ?',
            [validatorPubkey]);
    }
};
