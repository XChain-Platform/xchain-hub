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
    },

    // Reads rows from price_snapshots.
    // Moved here from src/OracleConsensus.js:374.
    async findLatestPriceSnapshotPerPair() {
        return this.doQuery(`SELECT p.coin_pair AS coin_pair, p.price AS price, p.round_number AS round_number FROM price_snapshots p JOIN (SELECT coin_pair, MAX(round_number) AS mx FROM price_snapshots       WHERE status = 'finalized' AND price IS NOT NULL GROUP BY coin_pair) m   ON p.coin_pair = m.coin_pair AND p.round_number = m.mx WHERE p.status = 'finalized' AND p.price IS NOT NULL`);
    },

    // Reads rows from price_snapshots.
    // Moved here from src/OracleRound.js:506.
    async findPriceSnapshotRoundsAfter(max) {
        return this.doQuery('SELECT DISTINCT round_number FROM price_snapshots WHERE round_number > ? ORDER BY round_number DESC LIMIT 50', [max]);
    },

    // Reads rows from price_snapshots.
    // Moved here from src/OracleRound.js:459.
    async findPriceSnapshotRoundsSkippedWithNoFinalized() {
        return this.doQuery(`SELECT DISTINCT s.round_number FROM price_snapshots s
                 WHERE s.status = 'skipped' AND NOT EXISTS (
                   SELECT 1 FROM price_snapshots f
                   WHERE f.round_number = s.round_number AND f.status = 'finalized')
                 ORDER BY s.round_number DESC LIMIT 50`);
    },

    // Reads rows from price_snapshots.
    // Moved here from src/XChainHub.js:1030.
    async findPriceSnapshotsBetweenRounds(from, to) {
        return this.doQuery('SELECT round_number, coin_pair, status, reference_block, block_timestamp FROM price_snapshots WHERE round_number BETWEEN ? AND ?', [from, to]);
    },

    // Reads rows from price_snapshots.
    // Moved here from src/api.js:2039.
    async findPriceSnapshotsById(since, limit) {
        return this.doQuery('SELECT * FROM price_snapshots WHERE id > ? ORDER BY id ASC LIMIT ?', [since, limit]);
    },

    // Reads rows from price_snapshots.
    // Moved here from src/OracleBatchSigner.js:560, src/OraclePublisher.js:2327.
    async findPriceSnapshotsByRoundNumber(firstRound, lastRound, status) {
        return this.doQuery('SELECT round_number, coin_pair, price, reference_block, block_timestamp, LEFT(consensus_proof, 8) AS proof_head, admit_block_btc, admit_block_ltc, admit_block_doge FROM price_snapshots WHERE round_number >= ? AND round_number <= ? AND status = ? ORDER BY round_number ASC, coin_pair ASC', [firstRound, lastRound, status]);
    },

    // Reads rows from price_snapshots.
    // Moved here from src/PriceAggregator.js:791.
    async findPriceSnapshotsByRoundNumberAndBatchBlockTime(round, landed) {
        return this.doQuery('SELECT round_number, coin_pair, price, reference_block, reference_chain, block_timestamp, validator_count, consensus_round, consensus_proof, status, source_chain, source_action_index, push_generation, batch_block_time, created_at FROM price_snapshots WHERE round_number = ? AND batch_block_time = ?', [round, landed]);
    },

    // Reads rows from price_snapshots.
    // Moved here from src/OraclePublisher.js:1479.
    async findPriceSnapshotsByRoundNumberAndConsensusProof(first, last) {
        return this.doQuery(`SELECT DISTINCT round_number, consensus_proof FROM price_snapshots WHERE round_number >= ? AND round_number <= ? AND consensus_proof LIKE '{"batch":%'`, [first, last]);
    },

    // Reads rows from price_snapshots.
    // Moved here from src/OraclePublisher.js:2419.
    async findPriceSnapshotsByRoundNumberAndStatus(first, last, status) {
        return this.doQuery('SELECT DISTINCT round_number, block_timestamp FROM price_snapshots WHERE round_number >= ? AND round_number <= ? AND status = ?', [first, last, status]);
    },

    // Reads rows from price_snapshots.
    // Moved here from src/OracleConsensus.js:2345, src/OracleConsensus.js:2495.
    async findPriceSnapshotsForRound(round) {
        return this.doQuery('SELECT * FROM price_snapshots WHERE round_number=? ORDER BY coin_pair', [round]);
    },

    // Reads rows from price_snapshots.
    // Moved here from src/OracleRound.js:476.
    async findPriceSnapshotsSkippedWithFinalizedRound() {
        return this.doQuery(`SELECT s.round_number, s.coin_pair FROM price_snapshots s
                 WHERE s.status = 'skipped' AND EXISTS (
                   SELECT 1 FROM price_snapshots f
                   WHERE f.round_number = s.round_number AND f.status = 'finalized')
                 ORDER BY s.round_number DESC, s.coin_pair ASC LIMIT 50`);
    },

    // Reads one row from price_snapshots.
    // Moved here from src/PriceAggregator.js:526, src/PriceAggregator.js:1131.
    async getPriceSnapshotByRoundNumber(round) {
        return this.doQuery(`SELECT id FROM price_snapshots WHERE round_number = ? AND status != 'skipped' LIMIT 1`, [round]);
    },

    // Reads one row from price_snapshots.
    // Moved here from src/OracleRound.js:322.
    async getPriceSnapshotByStatus() {
        return this.doQuery(`SELECT round_number, UNIX_TIMESTAMP(created_at) * 1000 AS ms FROM price_snapshots WHERE status = 'finalized' ORDER BY round_number DESC LIMIT 1`);
    },

    // Reads one row from price_snapshots.
    // Moved here from src/OracleRound.js:337.
    async getPriceSnapshotsCountUnfinalizedAfterRound(lastFinalizedRound) {
        return this.doQuery(`SELECT COUNT(DISTINCT round_number) AS skipped FROM price_snapshots WHERE round_number > ? AND status <> 'finalized'`, [lastFinalizedRound]);
    },

    // Reads one row from price_snapshots.
    // Moved here from src/api.js:781.
    async getPriceSnapshotsFinalizedAgeSeconds() {
        return this.doQuery(`SELECT UNIX_TIMESTAMP() - UNIX_TIMESTAMP(MAX(created_at)) AS age_s FROM price_snapshots WHERE status = 'finalized'`);
    },

    // Reads one row from price_snapshots.
    // Moved here from src/HubDbBroadcaster.js:632.
    async getPriceSnapshotsMaxId() {
        return this.doQuery('SELECT MAX(id) AS max_id FROM price_snapshots');
    },

    // Reads one row from price_snapshots.
    // Moved here from src/XChainHub.js:1017.
    async getPriceSnapshotsMaxRoundNumber() {
        return this.doQuery('SELECT MAX(round_number) AS max_round FROM price_snapshots');
    },

    // Probes for a matching row in price_snapshots.
    // Moved here from src/OraclePublisher.js:1688.
    async hasPriceSnapshotsByConsensusProof() {
        return this.doQuery(`SELECT 1 AS seen FROM price_snapshots WHERE consensus_proof LIKE '{"batch":%' LIMIT 1`);
    },

    // Probes for a matching row in price_snapshots.
    // Moved here from src/OraclePublisher.js:1669.
    async hasPriceSnapshotsByRoundNumber(first, last) {
        return this.doQuery(`SELECT 1 AS seen FROM price_snapshots WHERE round_number >= ? AND round_number <= ? AND consensus_proof LIKE '{"batch":%' LIMIT 1`, [first, last]);
    },

    // Updates price_snapshots.
    // Moved here from src/ReorgHandler.js:637.
    async updatePriceSnapshotByBlockTimestamp(bound) {
        return this.doQuery(`UPDATE price_snapshots SET status = 'disputed' WHERE block_timestamp > ? / 1000 AND status = 'finalized'`, [bound]);
    },

    // Updates price_snapshots.
    // Moved here from src/PriceAggregator.js:782.
    async updatePriceSnapshotByRoundNumber(landed, round, landed2) {
        return this.doQuery(`UPDATE price_snapshots SET batch_block_time = ? WHERE round_number = ? AND status != 'skipped' AND (batch_block_time = 0 OR batch_block_time > ?)`, [landed, round, landed2]);
    },

    // Latest FINALIZED price for a pair strictly BELOW a round number.
    // Moved here from src/XchainPriceSource.js:86 (it was LAST_FINALIZED_SQL there).
    //
    // Strictly below, and keyed on the round rather than "the newest row I have", because
    // §4 requires the winsorization anchor to be consensus-derived: rounds finalize
    // asynchronously, so two honest validators reading "latest finalized" at different
    // instants would clamp band-edge fills against different references and diverge past
    // the co-sign band, turning every thin round into a slashing lottery. Walking back
    // from R-1 is deterministic for everyone.
    async getLatestFinalizedPriceBelowRound(pair, round) {
        return this.doQuery(
    `SELECT price FROM price_snapshots
     WHERE coin_pair = ? AND round_number < ? AND status = 'finalized' AND price IS NOT NULL
     ORDER BY round_number DESC LIMIT 1`, [pair, round]);
    },

    // A set of rounds' finalized v0-proofed rows, for restoring a retracted batch window
    // to the publisher's buffer.
    // Moved here from src/OraclePublisher.js:1917.
    //
    // Only v0-proofed rows qualify: a batch-sourced row's consensus_proof is the
    // {"batch":...} object and its reference_block is the landing height, not the round's
    // BTC anchor. `rounds` are bound as parameters, so the only thing built from the list
    // is the count of placeholders.
    async findV0PriceSnapshotsForRounds(rounds, status) {
        let placeholders = rounds.map(() => '?').join(',');
        return this.doQuery(
            'SELECT round_number, coin_pair, price, reference_block, block_timestamp, ' +
            'admit_block_btc, admit_block_ltc, admit_block_doge ' +
            'FROM price_snapshots WHERE round_number IN (' + placeholders + ') AND status = ? ' +
            'AND consensus_proof NOT LIKE \'{"batch":%\' ORDER BY round_number ASC, coin_pair ASC',
            rounds.concat([status]));
    },

    // Writes one consensus-finalized round, every pair, in ONE multi-row INSERT.
    // Moved here from src/OracleConsensus.js:2269.
    //
    // One statement so the round lands atomically: a per-pair loop let a getfeequote /
    // getpricesnapshots reader observe a torn round (some pairs from round N, others from
    // N-1), and the id-ordered mirror bootstrap could persist that torn read to a replica.
    // The hub Database exposes no transaction API, so a single statement is the atomicity
    // primitive. `prices` is [{ coinPair, price }]; `admitCols` is the round's admission map
    // already resolved to its per-chain columns. The upsert upgrades a 'skipped' placeholder
    // row to 'finalized'.
    async setFinalizedPriceSnapshotRound(round, prices, referenceBlock, blockTimestamp, validatorCount, proof, admitCols) {
        let placeholders = prices.map(() => "(?, ?, ?, ?, 'BTC', ?, ?, 1, ?, 'finalized', ?, ?, ?)").join(', ');
        let params = [];
        for (let p of prices) params.push(round, p.coinPair, p.price, referenceBlock, blockTimestamp, validatorCount, proof,
                                          admitCols.admit_block_btc, admitCols.admit_block_ltc, admitCols.admit_block_doge);
        let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status,
                 admit_block_btc, admit_block_ltc, admit_block_doge)
                VALUES ${placeholders}
                ON DUPLICATE KEY UPDATE price = VALUES(price), reference_block = VALUES(reference_block),
                 block_timestamp = VALUES(block_timestamp), validator_count = VALUES(validator_count),
                 consensus_proof = VALUES(consensus_proof), status = 'finalized',
                 admit_block_btc = VALUES(admit_block_btc), admit_block_ltc = VALUES(admit_block_ltc),
                 admit_block_doge = VALUES(admit_block_doge)`;
        return this.doQuery(query, params);
    },

    // Writes a 'skipped' marker row for each of a round's pairs, in ONE multi-row INSERT.
    // Moved here from src/OracleConsensus.js:2469 (_storeSkippedRound), and also serving the
    // per-pair skip markers at src/OracleConsensus.js:2302, which issued the same statement
    // with only its indentation differing.
    //
    // The upsert only refreshes a row that is still 'skipped': a pair that already finalized
    // keeps its price, its anchor and its status, so a late skip never demotes a finalized row.
    async setSkippedPriceSnapshotRound(round, coinPairs, referenceBlock, blockTimestamp) {
        let placeholders = coinPairs.map(() => "(?, ?, NULL, ?, 'BTC', ?, 0, 1, '[]', 'skipped')").join(', ');
        let params = [];
        for (let pair of coinPairs) params.push(round, pair, referenceBlock, blockTimestamp);
        let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status)
                VALUES ${placeholders}
                ON DUPLICATE KEY UPDATE
                 reference_block = IF(status = 'skipped', VALUES(reference_block), reference_block),
                 block_timestamp = IF(status = 'skipped', VALUES(block_timestamp), block_timestamp),
                 status = IF(status = 'skipped', 'skipped', status)`;
        return this.doQuery(query, params);
    },

    // Writes one externally pushed PRICE v0 round, every pair, in ONE multi-row INSERT.
    // Moved here from src/PriceAggregator.js:722.
    //
    // Upsert, not a plain INSERT: a 'skipped' placeholder row may already occupy this
    // (round_number, coin_pair) key, and it is overwritten with the real finalized data; for
    // an already-finalized row this is an idempotent no-op of identical data. created_at is
    // intentionally NOT overwritten, so it keeps when the hub first recorded the round. One
    // statement lands the whole round atomically, because the hub Database has no
    // transaction API. The admission columns are bound AFTER created_at so every positional
    // reader of these params keeps its index. `referenceChain` fills both reference_chain and
    // source_chain, as the caller's source chain (or null) did.
    async setPushedPriceSnapshotRound(round, pairs, referenceBlock, referenceChain, timestamp, validatorCount, proofJson,
                                      sourceActionIndex, pushGeneration, createdAt, admitCols) {
        let placeholders = pairs.map(() => "(?, ?, ?, ?, ?, ?, ?, 1, ?, 'finalized', ?, ?, ?, ?, ?, ?, ?)").join(', ');
        let params = [];
        for (let p of pairs) {
            params.push(round, p.pair, p.price, referenceBlock, referenceChain, timestamp,
                        validatorCount, proofJson, referenceChain, sourceActionIndex, pushGeneration, createdAt,
                        admitCols.admit_block_btc, admitCols.admit_block_ltc, admitCols.admit_block_doge);
        }
        let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status, source_chain, source_action_index,
                 push_generation, created_at, admit_block_btc, admit_block_ltc, admit_block_doge)
                VALUES ${placeholders}
                ON DUPLICATE KEY UPDATE
                    price = VALUES(price), reference_block = VALUES(reference_block),
                    reference_chain = VALUES(reference_chain), block_timestamp = VALUES(block_timestamp),
                    validator_count = VALUES(validator_count), consensus_proof = VALUES(consensus_proof),
                    status = 'finalized', source_chain = VALUES(source_chain),
                    source_action_index = VALUES(source_action_index),
                    push_generation = VALUES(push_generation),
                    admit_block_btc = VALUES(admit_block_btc), admit_block_ltc = VALUES(admit_block_ltc),
                    admit_block_doge = VALUES(admit_block_doge)`;
        return this.doQuery(query, params);
    },

    // Writes one round of a landed PRICE batch, every pair, in ONE multi-row INSERT.
    // Moved here from src/PriceAggregator.js:1183.
    //
    // One statement PER ROUND, not one for the whole batch: the unit that must never be
    // observed torn is the round. batch_block_time only ever moves EARLIER (or fills a 0), so
    // a re-landing of the same round cannot push the fee-pricing bound later. The admission
    // columns are bound AFTER created_at so every positional reader of these params keeps its
    // index. `referenceChain` fills both reference_chain and source_chain.
    async setBatchPriceSnapshotRound(round, pairs, referenceBlock, referenceChain, timestamp, validatorCount, proofJson,
                                     sourceActionIndex, pushGeneration, blockTime, createdAt, admitCols) {
        let placeholders = pairs.map(() => "(?, ?, ?, ?, ?, ?, ?, 1, ?, 'finalized', ?, ?, ?, ?, ?, ?, ?, ?)").join(', ');
        let params = [];
        for (let p of pairs) {
            params.push(round, p.pair, p.price, referenceBlock, referenceChain, timestamp,
                        validatorCount, proofJson, referenceChain, sourceActionIndex, pushGeneration,
                        blockTime, createdAt,
                        admitCols.admit_block_btc, admitCols.admit_block_ltc, admitCols.admit_block_doge);
        }
        let query = `INSERT INTO price_snapshots
                (round_number, coin_pair, price, reference_block, reference_chain, block_timestamp,
                 validator_count, consensus_round, consensus_proof, status, source_chain, source_action_index,
                 push_generation, batch_block_time, created_at, admit_block_btc, admit_block_ltc, admit_block_doge)
                VALUES ${placeholders}
                ON DUPLICATE KEY UPDATE
                    price = VALUES(price), reference_block = VALUES(reference_block),
                    reference_chain = VALUES(reference_chain), block_timestamp = VALUES(block_timestamp),
                    validator_count = VALUES(validator_count), consensus_proof = VALUES(consensus_proof),
                    status = 'finalized', source_chain = VALUES(source_chain),
                    source_action_index = VALUES(source_action_index),
                    push_generation = VALUES(push_generation),
                    batch_block_time = IF(batch_block_time = 0 OR VALUES(batch_block_time) < batch_block_time,
                                          VALUES(batch_block_time), batch_block_time),
                    admit_block_btc = VALUES(admit_block_btc), admit_block_ltc = VALUES(admit_block_ltc),
                    admit_block_doge = VALUES(admit_block_doge)`;
        return this.doQuery(query, params);
    },

    // The rounds a retracted PRICE batch carried on a rolled-back source chain.
    // Moved here from src/PriceAggregator.js:1568.
    //
    // Read BEFORE the retraction delete, because afterwards there is nothing left to read them
    // off. Batch-sourced rows are the ones whose consensus_proof is the {"batch":...} object; a
    // v0-sourced row's proof is a bare signature ARRAY, so the prefix is an exact discriminator.
    // price_snapshots tracks the round action via source_action_index; `bounded` and `fenced`
    // are the caller's already-validated range and generation fence.
    async findBatchPriceSnapshotRoundsForRetraction(sourceChain, from, to, gen, bounded, fenced) {
        let col = 'source_action_index';
        let where = 'source_chain = ? AND ' + col + (bounded ? ' >= ? AND ' + col + ' <= ?' : ' >= ?') + (fenced ? ' AND push_generation <= ?' : '');
        let args = [sourceChain, from];
        if (bounded) args.push(to);
        if (fenced) args.push(gen);
        return this.doQuery(
            'SELECT DISTINCT round_number FROM price_snapshots WHERE ' + where
                + " AND consensus_proof LIKE '{\"batch\":%'",
            args);
    },

    // Deletes a rolled-back source chain's PRICE v0 round rows, for a reorg retraction.
    // Moved here from src/PriceAggregator.js:1607.
    //
    // price_snapshots tracks the round action via source_action_index. `bounded` closes the
    // range at `to` so a row re-published inside the original open-ended range survives a
    // deferred retraction; `fenced` limits the delete to rows stamped at or below generation
    // `gen`. The caller normalizes and validates the bounds; this only binds them.
    async deletePriceSnapshotsForRetraction(sourceChain, from, to, gen, bounded, fenced) {
        let col = 'source_action_index';
        let where = 'source_chain = ? AND ' + col + (bounded ? ' >= ? AND ' + col + ' <= ?' : ' >= ?') + (fenced ? ' AND push_generation <= ?' : '');
        let args = [sourceChain, from];
        if (bounded) args.push(to);
        if (fenced) args.push(gen);
        return this.doQuery('DELETE FROM price_snapshots WHERE ' + where, args);
    }
};
