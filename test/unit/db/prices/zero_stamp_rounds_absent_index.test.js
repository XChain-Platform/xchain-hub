'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The zero-stamp sweep's index comes from a manual-mode migration. On the regtest
// rail the hub ran without it and the hinted read failed every tick with errno 1176,
// so the landing-clock sweep never progressed; it must fall back to an unhinted read.

const assert = require('node:assert/strict');
const sinon = require('sinon');
// The absent-index latch is held per Database instance, so each case's fresh fake db
// starts unlatched and the module is never reloaded.
const priceQueries = require('../../../../src/db/prices/index.js');

// Throws ABSENT only for the hinted statement, like a real server lacking the key.
function dbAbsentForHint() {
    const calls = [];
    return {
        calls,
        async doQuery(sql, params) {
            calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            if (/FORCE INDEX/.test(sql)) throw ABSENT;
            return [{ round_number: 7 }];
        },
    };
}

// Shaped like the mariadb driver's error: the server text lands in sqlMessage, while
// message carries the driver's own wrapper.
const ABSENT = Object.assign(new Error('(conn:1, no: 1176, SQLState: 42000) query failed'),
    { errno: 1176, code: 'ER_KEY_DOES_NOT_EXISTS',
      sqlMessage: "Key 'idx_batchtime_round_status' doesn't exist in table 'price_snapshots'" });

function dbFailingFirstWith(err) {
    const calls = [];
    return {
        calls,
        async doQuery(sql, params) {
            calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
            if (calls.length === 1) throw err;
            return [{ round_number: 7 }];
        },
    };
}

describe('zero-stamped price round query latch across ticks', () => {
    it('issues the hinted statement once across ticks, so doQuery has no repeated error to log', async () => {
        const db = dbAbsentForHint();
        for (let tick = 0; tick < 3; tick++) {
            const rows = await priceQueries.findZeroBatchBlockTimePriceSnapshotRoundsAfter.call(db, tick, 100);
            assert.deepEqual(rows, [{ round_number: 7 }]);
        }
        assert.equal(db.calls.filter((c) => /FORCE INDEX/.test(c.sql)).length, 1);
        assert.equal(db.calls.length, 4);
        assert.doesNotMatch(db.calls[2].sql, /FORCE INDEX/);
        assert.doesNotMatch(db.calls[3].sql, /FORCE INDEX/);
    });

    it('keeps the hint on every call while the index is present', async () => {
        const calls = [];
        const db = { calls, async doQuery(sql) { calls.push(sql); return []; } };
        for (let tick = 0; tick < 3; tick++) {
            await priceQueries.findZeroBatchBlockTimePriceSnapshotRoundsAfter.call(db, 0, 100);
        }
        assert.equal(calls.filter((s) => /FORCE INDEX/.test(s)).length, 3);
    });
});

describe('zero-stamped price round query without its index', () => {
    it('reads unhinted when the forced index is absent, with the same filter and bounds', async () => {
        const db = dbFailingFirstWith(ABSENT);
        const rows = await priceQueries.findZeroBatchBlockTimePriceSnapshotRoundsAfter.call(db, 136050, 100);
        assert.deepEqual(rows, [{ round_number: 7 }]);
        assert.equal(db.calls.length, 2);
        assert.match(db.calls[0].sql, /FORCE INDEX \(idx_batchtime_round_status\)/);
        assert.doesNotMatch(db.calls[1].sql, /FORCE INDEX/);
        assert.match(db.calls[1].sql, / WHERE batch_block_time = 0 AND round_number > \? AND status != 'skipped' ORDER BY round_number ASC LIMIT \?$/);
        assert.deepEqual(db.calls[1].params, [136050, 100]);
    });

    it('warns once per process, not on every tick', async () => {
        const { getLogger } = require('../../../../src/observability');
        const warn = sinon.spy(getLogger(), 'warn');
        try {
            const db = dbAbsentForHint();
            for (let tick = 0; tick < 3; tick++) {
                await priceQueries.findZeroBatchBlockTimePriceSnapshotRoundsAfter.call(db, 0, 100);
            }
            assert.equal(warn.callCount, 1);
        } finally {
            warn.restore();
        }
    });

    it('rethrows any other failure, so a statement timeout still surfaces', async () => {
        const timeout = Object.assign(new Error('Query execution was interrupted (max_statement_time exceeded)'), { errno: 1969 });
        const db = dbFailingFirstWith(timeout);
        await assert.rejects(priceQueries.findZeroBatchBlockTimePriceSnapshotRoundsAfter.call(db, 0, 100), /max_statement_time/);
        assert.equal(db.calls.length, 1);
    });

    it('rethrows a 1176 that names a different key', async () => {
        const other = Object.assign(new Error("Key 'idx_other' doesn't exist in table 'price_snapshots'"), { errno: 1176 });
        const db = dbFailingFirstWith(other);
        await assert.rejects(priceQueries.findZeroBatchBlockTimePriceSnapshotRoundsAfter.call(db, 0, 100), /idx_other/);
        assert.equal(db.calls.length, 1);
    });
});
