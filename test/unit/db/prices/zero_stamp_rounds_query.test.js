'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The zero-stamped round read behind the landing-clock repair sweep. Joined through a
// DISTINCT-pairs derived table on the pair-led key with one ORDER BY round_number across
// every pair, MariaDB materializes and filesorts every zero-stamped row before the LIMIT,
// and on a few hundred thousand rows the read outran the statement limit on every sweep.
// The read must be one table, pinned to a key that leads on batch_block_time and then
// round_number, so the range and the ORDER BY come off the index and the LIMIT stops it.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const priceQueries = require('../../../../src/db/prices/index.js');

const MIGRATION = path.resolve(__dirname, '../../../../src/sql/migrations',
    '2026-10-28-price-snapshots-zero-stamp-round-index.sql');
const ADD = /^ALTER TABLE `price_snapshots` ADD INDEX IF NOT EXISTS `([^`]+)` \((.+)\);$/;

async function capture(round, limit){
    const calls = [];
    await priceQueries.findZeroBatchBlockTimePriceSnapshotRoundsAfter.call({
        async doQuery(sql, params){ calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return []; }
    }, round, limit);
    assert.equal(calls.length, 1);
    return calls[0];
}

// The index the dated migration adds, as { name, columns }.
function migrationIndex(){
    const text = fs.readFileSync(MIGRATION, 'utf8').split('\n').map(line => line.trim())
        .filter(line => line && !line.startsWith('--')).join(' ');
    const match = text.match(ADD);
    assert.ok(match, 'migration adds one price_snapshots index idempotently');
    return { name: match[1], columns: match[2].split(',').map(column => column.replace(/[`\s]/g, '')) };
}

describe('zero-stamped price round query', () => {
    it('reads one table in round order instead of a pair-joined global sort', async () => {
        const { sql } = await capture(0, 100);
        assert.doesNotMatch(sql, /STRAIGHT_JOIN|\bJOIN\b/i);
        assert.doesNotMatch(sql, /SELECT DISTINCT coin_pair/i);
        assert.doesNotMatch(sql, /idx_pair_batchtime_round/);
        assert.match(sql, /^SELECT DISTINCT round_number FROM price_snapshots FORCE INDEX \(\w+\) WHERE /);
        assert.match(sql, /ORDER BY round_number ASC LIMIT \?$/);
    });

    it('binds the round cursor and the limit and filters skipped rounds', async () => {
        const { sql, params } = await capture(136050, 100);
        assert.deepEqual(params, [136050, 100]);
        assert.match(sql, / WHERE batch_block_time = 0 AND round_number > \? AND status != 'skipped' ORDER BY/);
    });

    it('is pinned to the migration index, which serves the equality, range, order and status', async () => {
        const { sql } = await capture(0, 100);
        const index = migrationIndex();
        assert.equal(sql.match(/FORCE INDEX \((\w+)\)/)[1], index.name);
        // Equality on the leading column, then the range and ORDER BY on the next one, is
        // what lets the read walk the key in order and stop at the LIMIT with no filesort;
        // status as the last column keeps the skipped filter on the index too.
        assert.deepEqual(index.columns, ['batch_block_time', 'round_number', 'status']);
    });
});
