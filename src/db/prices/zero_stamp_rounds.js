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
 * XChain Hub - the zero-stamped round read behind the landing-clock repair sweep.
 *
 * prices/index.js spreads this method into the price-family mixin, so callers keep
 * writing db.findZeroBatchBlockTimePriceSnapshotRoundsAfter().
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability');

const logger = getLogger();

const ZERO_STAMP_INDEX = 'idx_batchtime_round_status';
// MariaDB's "Key '...' doesn't exist in table" for an index hint naming an absent key.
const ER_KEY_DOES_NOT_EXITS = 1176;

let warnedIndexAbsent = false;

function zeroStampRoundsSql(hint) {
    return `SELECT DISTINCT round_number
             FROM price_snapshots${hint}
             WHERE batch_block_time = 0 AND round_number > ? AND status != 'skipped'
             ORDER BY round_number ASC LIMIT ?`;
}

function isAbsentIndex(e) {
    return !!e && (e.errno === ER_KEY_DOES_NOT_EXITS || e.code === 'ER_KEY_DOES_NOT_EXITS')
        && String(e.sqlMessage || e.message || '').includes(ZERO_STAMP_INDEX);
}

module.exports = {

    // Reads only unstamped, non-skipped rounds for the landing-clock repair sweep. The
    // covering (batch_block_time, round_number, status) key returns zero-stamped entries
    // already in round order, so the read stops after `limit` rounds past the cursor. A
    // pair-led key cannot: ordering by round across every pair materializes and filesorts
    // every zero-stamped row, which outran the statement limit on a few hundred thousand.
    // The key comes from a manual-mode migration, so a hub whose operator has not run
    // `npm run migrate` lacks it; the hint would then fail every tick, so the read runs
    // unhinted (slow on a large table, but it progresses) and says once what is missing.
    async findZeroBatchBlockTimePriceSnapshotRoundsAfter(round, limit) {
        try {
            return await this.doQuery(zeroStampRoundsSql(` FORCE INDEX (${ZERO_STAMP_INDEX})`), [round, limit]);
        } catch (e) {
            if (!isAbsentIndex(e)) throw e;
            if (!warnedIndexAbsent) {
                warnedIndexAbsent = true;
                logger.warn(`price_snapshots index ${ZERO_STAMP_INDEX} is absent; the landing-clock sweep reads `
                    + 'without it until `npm run migrate` applies 2026-10-28-price-snapshots-zero-stamp-round-index.sql');
            }
            return this.doQuery(zeroStampRoundsSql(''), [round, limit]);
        }
    },

};
