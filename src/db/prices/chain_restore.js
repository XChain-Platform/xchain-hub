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
 * XChain Hub - price rows used by active-chain retention and repair
 *
 ********************************************************************/

module.exports = {

    async findLatestPriceSnapshotRound() {
        let rows = await this.doQuery(
            "SELECT MAX(round_number) AS latest_round FROM price_snapshots WHERE status != 'skipped'");
        let latest = Number(rows && rows[0] && rows[0].latest_round);
        return Number.isSafeInteger(latest) && latest >= 0 ? latest : 0;
    },

    async findOldestPriceSnapshotRound() {
        let rows = await this.doQuery(
            "SELECT MIN(round_number) AS oldest_round FROM price_snapshots WHERE status != 'skipped'");
        let oldest = Number(rows && rows[0] && rows[0].oldest_round);
        return Number.isSafeInteger(oldest) && oldest >= 0 ? oldest : 0;
    },

    // Read complete rows for a bounded set of rounds in one statement. Both
    // batch ingest and the repair pass use this as their sole presence read.
    async findPriceSnapshotRowsForRounds(rounds) {
        if (!Array.isArray(rounds) || rounds.length === 0) return [];
        let placeholders = rounds.map(() => '?').join(',');
        return this.doQuery('SELECT round_number, status, source_chain, source_action_index, push_generation, consensus_proof ' +
            'FROM price_snapshots WHERE round_number IN (' + placeholders + ') ' +
            'ORDER BY round_number ASC, coin_pair ASC', rounds);
    },

    // Read the batch-sourced rows a retraction would delete before asking the
    // active chain which rounds still belong there.
    async findBatchPriceSnapshotsForRetraction(sourceChain, from, to, gen, bounded, fenced) {
        let col = 'source_action_index';
        let where = 'source_chain = ? AND ' + col +
            (bounded ? ' >= ? AND ' + col + ' <= ?' : ' >= ?') +
            (fenced ? ' AND push_generation <= ?' : '');
        let args = [sourceChain, from];
        if (bounded) args.push(to);
        if (fenced) args.push(gen);
        return this.doQuery('SELECT * FROM price_snapshots WHERE ' + where +
            " AND consensus_proof LIKE '{\"batch\":%' ORDER BY round_number ASC, coin_pair ASC", args);
    }

};
