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
 * batch landing stamped: by the batch row the hub stored (its windows), and by the round
 * window the indexer names (every round inside it, whatever path stored it).
 * prices/index.js spreads these methods into the mixin it exports, so src/db/index.js
 * installs them on Database.prototype and every caller keeps writing db.<method>().
 *
 ********************************************************************/

const BATCH_ROUND = path => `CAST(JSON_UNQUOTE(JSON_EXTRACT(consensus_proof, '$.batch.${path}')) AS UNSIGNED)`;
const WINDOWS_PER_STATEMENT = 500;

// The distinct (landing clock, first_round, last_round) of every retracted PRICE batch row.
// Two statements with literal bounds, never a self-join: a join ON computed per row from
// JSON cannot use an index, so it read the table squared and hit the statement limit.
// This read ranges idx_source_chain_action; a zero clock stamped nothing, so it is skipped.
async function retractedLandingWindows(db, sourceChain, from, to, gen, bounded, fenced) {
    const args = [sourceChain, from];
    if (bounded) args.push(to);
    if (fenced) args.push(gen);
    const rows = await db.doQuery(`SELECT DISTINCT batch_block_time, ${BATCH_ROUND('first_round')} AS first_round, ${BATCH_ROUND('last_round')} AS last_round FROM price_snapshots WHERE source_chain = ? AND source_action_index >= ?${bounded ? ' AND source_action_index <= ?' : ''}${fenced ? ' AND push_generation <= ?' : ''} AND consensus_proof LIKE '{"batch":%' AND batch_block_time > 0`, args);
    const seen = new Map();
    for (const row of (Array.isArray(rows) ? rows : [])) {
        const w = [row.first_round, row.last_round, row.batch_block_time].map(v => (v === null || v === undefined) ? NaN : Number(v));
        if (w.every(Number.isSafeInteger) && w[2] > 0 && w[0] <= w[1]) seen.set(w.join(':'), w);
    }
    return [...seen.values()];
}

// Self-finalized rows (no source_action_index) a retracted landing stamped: same clock,
// round inside that landing's window. Each window is a round_number range idx_round_pair
// serves; one statement per WINDOWS_PER_STATEMENT windows keeps the text bounded.
async function eachOrphanedLandingStatement(db, head, query) {
    const windows = await retractedLandingWindows(db, ...query);
    const results = [];
    for (let i = 0; i < windows.length; i += WINDOWS_PER_STATEMENT) {
        const chunk = windows.slice(i, i + WINDOWS_PER_STATEMENT);
        const groups = chunk.map(() => '(round_number BETWEEN ? AND ? AND batch_block_time = ?)').join(' OR ');
        results.push(await db.doQuery(`${head} WHERE source_action_index IS NULL AND consensus_proof NOT LIKE '{"batch":%' AND (${groups})`, chunk.flat()));
    }
    return results;
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
        const results = await eachOrphanedLandingStatement(this, 'SELECT DISTINCT round_number FROM price_snapshots', query);
        const rounds = new Set();
        for (const rows of results) for (const row of (Array.isArray(rows) ? rows : [])) rounds.add(Number(row.round_number));
        return [...rounds].map(round_number => ({ round_number }));
    },

    async resetSelfFinalizedBatchBlockTimeForRetraction(...query) {
        const results = await eachOrphanedLandingStatement(this, 'UPDATE price_snapshots SET batch_block_time = 0', query);
        return { affectedRows: results.reduce((sum, r) => sum + Number((r && r.affectedRows) || 0), 0) };
    },

};
