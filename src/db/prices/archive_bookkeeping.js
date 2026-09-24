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
 * XChain Hub - ANCHOR archive bookkeeping queries for the price tables.
 *
 * Owns src/sql/archive_price_tombstones.sql and the batch_seq, archived_status,
 * archived_batch_block_time and archived_proof_sha columns of src/sql/price_snapshots.sql.
 * src/db/index.js installs every method below on Database.prototype, so callers keep
 * writing db.<method>().
 *
 * price_snapshots rows are mutated in place and hard-deleted by a source-chain
 * retraction, so the archive moves them by whole round and records what it carried:
 * a row is pending again when its status, batch_block_time or consensus_proof digest
 * differs from the stamp, and a deleted row leaves a tombstone.
 *
 ********************************************************************/

const PENDING_PRICE_PREDICATE =
    '(batch_seq IS NULL OR archived_status <> status OR archived_batch_block_time <> batch_block_time ' +
    'OR archived_proof_sha <> SHA2(consensus_proof, 256))';

const NO_LIVE_PRICE_ROW =
    'NOT EXISTS (SELECT 1 FROM price_snapshots p WHERE p.round_number = archive_price_tombstones.round_number ' +
    'AND p.coin_pair = archive_price_tombstones.coin_pair)';

module.exports = {

    // The lowest pending round numbers, a round pending when any one of its pairs is.
    async findPriceSnapshotRoundsByBatchSeq(limit) {
        return this.doQuery(
            'SELECT DISTINCT round_number FROM price_snapshots WHERE ' + PENDING_PRICE_PREDICATE +
            ' ORDER BY round_number ASC LIMIT ?', [limit]);
    },

    // Every row of the given rounds, pending or not, so a round is archived whole.
    async findPriceSnapshotsForArchiveRounds(rounds) {
        if (!rounds || rounds.length === 0) return [];
        return this.doQuery(
            'SELECT * FROM price_snapshots WHERE round_number IN (' + rounds.map(() => '?').join(', ') + ') ' +
            'ORDER BY round_number ASC, coin_pair ASC', rounds);
    },

    // Stamps one price row with the batch and the values the archive carried. Guarded
    // twice: on those values still being the row's current ones, so a mutation between
    // build and back-fill leaves the row pending; and on the row still being pending, so
    // a row an earlier round already covered is not restamped.
    async updatePriceSnapshotArchiveBatchSeq(batchSeq, status, batchBlockTime, proofSha, roundNumber, coinPair) {
        return this.doQuery(
            'UPDATE price_snapshots SET batch_seq = ?, archived_status = ?, archived_batch_block_time = ?, archived_proof_sha = ? ' +
            'WHERE round_number = ? AND coin_pair = ? AND status = ? AND batch_block_time = ? ' +
            'AND SHA2(consensus_proof, 256) = ? AND ' + PENDING_PRICE_PREDICATE,
            [batchSeq, status, batchBlockTime, proofSha, roundNumber, coinPair, status, batchBlockTime, proofSha]);
    },

    // Records the (round, pair) keys a retraction is about to delete, restricted to rows
    // an archive already carried: only those need a tombstone. Same WHERE tail as
    // deletePriceSnapshotsForRetraction, and called immediately before it.
    async insertPriceTombstonesForRetraction(sourceChain, from, to, gen, bounded, fenced) {
        let col = 'source_action_index';
        let where = 'source_chain = ? AND ' + col + (bounded ? ' >= ? AND ' + col + ' <= ?' : ' >= ?') + (fenced ? ' AND push_generation <= ?' : '');
        let args = [sourceChain, from];
        if (bounded) args.push(to);
        if (fenced) args.push(gen);
        return this.doQuery(
            'INSERT IGNORE INTO archive_price_tombstones (round_number, coin_pair) ' +
            'SELECT round_number, coin_pair FROM price_snapshots WHERE ' + where + ' AND batch_seq IS NOT NULL', args);
    },

    // Tombstones the archive still owes: unstamped, and no live row holds the key, since a
    // round republished at the same key supersedes its tombstone.
    async findPriceTombstonesByBatchSeq(limit) {
        return this.doQuery(
            'SELECT round_number, coin_pair FROM archive_price_tombstones WHERE batch_seq IS NULL AND ' +
            NO_LIVE_PRICE_ROW + ' ORDER BY round_number ASC, coin_pair ASC LIMIT ?', [limit]);
    },

    // Stamps a tombstone once. Refused when a live row has appeared at the key since the
    // batch was built.
    async updatePriceTombstoneArchiveBatchSeq(batchSeq, roundNumber, coinPair) {
        return this.doQuery(
            'UPDATE archive_price_tombstones SET batch_seq = ? WHERE round_number = ? AND coin_pair = ? ' +
            'AND batch_seq IS NULL AND ' + NO_LIVE_PRICE_ROW,
            [batchSeq, roundNumber, coinPair]);
    }
};
