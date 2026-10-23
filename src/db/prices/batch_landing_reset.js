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
 * XChain Hub - price_snapshots landing-clock resets for a PRICE batch reorg.
 *
 * The statements a price_retraction runs to clear the batch_block_time a retracted
 * batch landing stamped: by the batch row the hub stored (the join), and by the round
 * window the indexer names (every round inside it, whatever path stored it).
 * prices/index.js spreads these methods into the mixin it exports, so src/db/index.js
 * installs them on Database.prototype and every caller keeps writing db.<method>().
 *
 ********************************************************************/

// Self-finalized rows (no source_action_index) a retracted PRICE batch landing stamped: same
// batch_block_time, round inside the landing's first_round..last_round.
function orphanedLandingQuery(head, set, sourceChain, from, to, gen, bounded, fenced) {
    const args = [sourceChain, from];
    if (bounded) args.push(to);
    if (fenced) args.push(gen);
    const range = bounded ? ' >= ? AND batch_landed.source_action_index <= ?' : ' >= ?';
    const sql = `${head} price_snapshots AS self_finalized JOIN price_snapshots AS batch_landed ON self_finalized.batch_block_time = batch_landed.batch_block_time AND self_finalized.round_number BETWEEN CAST(JSON_UNQUOTE(JSON_EXTRACT(batch_landed.consensus_proof, '$.batch.first_round')) AS UNSIGNED) AND CAST(JSON_UNQUOTE(JSON_EXTRACT(batch_landed.consensus_proof, '$.batch.last_round')) AS UNSIGNED) ${set} WHERE self_finalized.source_action_index IS NULL AND self_finalized.consensus_proof NOT LIKE '{"batch":%' AND self_finalized.batch_block_time > 0 AND batch_landed.source_chain = ? AND batch_landed.source_action_index${range}${fenced ? ' AND batch_landed.push_generation <= ?' : ''} AND batch_landed.consensus_proof LIKE '{"batch":%'`;
    return [sql, args];
}

module.exports = {

    // Rounds inside a retracted PRICE batch window that hold a landing stamp, whatever path
    // stored them (a hub that finalized every round of the batch itself holds no batch row).
    async findPriceSnapshotRoundsLandedBetween(first, last) {
        return this.doQuery(`SELECT DISTINCT round_number FROM price_snapshots WHERE round_number BETWEEN ? AND ? AND status != 'skipped' AND batch_block_time > 0`, [first, last]);
    },

    // Clears the landing stamp on every round inside a retracted PRICE batch window.
    async updatePriceSnapshotsClearBatchBlockTimeBetween(first, last) {
        return this.doQuery(`UPDATE price_snapshots SET batch_block_time = 0 WHERE round_number BETWEEN ? AND ? AND status != 'skipped' AND batch_block_time > 0`, [first, last]);
    },

    async findSelfFinalizedRoundsForBatchRetraction(...query) {
        return this.doQuery(...orphanedLandingQuery('SELECT DISTINCT self_finalized.round_number FROM', '', ...query));
    },

    async resetSelfFinalizedBatchBlockTimeForRetraction(...query) {
        return this.doQuery(...orphanedLandingQuery('UPDATE', 'SET self_finalized.batch_block_time = 0', ...query));
    },

};
