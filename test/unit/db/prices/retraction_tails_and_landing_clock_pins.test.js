'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// Two statement-shape contracts of the price_snapshots lifecycle:
//   - the retraction's tombstone insert and its delete read the same rows, the tombstone
//     insert narrowing that tail to rows an archive already carried;
//   - a skipped placeholder never carries a landing clock, so the batch upsert stamps the
//     upgraded row through its fill-a-zero branch with no status test.

const assert = require('node:assert/strict');
const priceQueries = require('../../../../src/db/prices/index.js');
const bookkeeping = require('../../../../src/db/prices/archive_bookkeeping.js');

const squash = (sql) => sql.replace(/\s+/g, ' ').trim();

async function captured(method, owner, args) {
    const calls = [];
    await owner[method].call({ async doQuery(sql, params) { calls.push({ sql: squash(sql), params }); return {}; } }, ...args);
    assert.equal(calls.length, 1);
    return calls[0];
}

const TAIL_CASES = [
    ['bounded and fenced', ['DOGE', 7, 12, 4, true, true, undefined]],
    ['open and unfenced', ['DOGE', 9, undefined, undefined, false, false, undefined]],
    ['bounded, unfenced, keeping rounds', ['BTC', 3, 8, 2, true, false, [11, 12]]],
    ['open, fenced, keeping one round', ['LTC', 5, undefined, 6, false, true, [40]]]
];

describe('price retraction statement tails', () => {
    for (const [label, args] of TAIL_CASES) {
        it('keeps the tombstone insert and the snapshot delete on one tail: ' + label, async () => {
            const tombstone = await captured('insertPriceTombstonesForRetraction', bookkeeping, args);
            const removal = await captured('deletePriceSnapshotsForRetraction', priceQueries, args);
            const deleteWhere = removal.sql.replace(/^DELETE FROM price_snapshots WHERE /, '');
            assert.notEqual(deleteWhere, removal.sql);
            assert.ok(deleteWhere.length > 20);
            assert.match(tombstone.sql, new RegExp(' FROM price_snapshots WHERE ' +
                deleteWhere.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' AND batch_seq IS NOT NULL ON DUPLICATE KEY UPDATE '));
            assert.deepEqual(tombstone.params, removal.params);
        });
    }

    it('narrows only the tombstone side to archived rows', async () => {
        const args = TAIL_CASES[0][1];
        const tombstone = await captured('insertPriceTombstonesForRetraction', bookkeeping, args);
        const removal = await captured('deletePriceSnapshotsForRetraction', priceQueries, args);
        assert.ok(tombstone.sql.includes('batch_seq IS NOT NULL'));
        assert.ok(!removal.sql.includes('batch_seq'));
    });
});

describe('price landing clock on a skipped placeholder upgrade', () => {
    it('fills a zero clock or moves it earlier with no status condition', async () => {
        const upsert = await captured('setBatchPriceSnapshotRound', priceQueries,
            [7, [{ pair: 'BTC/USD', price: '1' }], 101, 'DOGE', 1700000000, 3, '{"batch":{}}', 4, 5,
                1700000100, new Date('2026-01-01T00:00:00Z'), { admit_block_btc: 1, admit_block_ltc: 2, admit_block_doge: 3 }]);
        const clock = upsert.sql.match(/batch_block_time = IF\((.*?), VALUES\(batch_block_time\), batch_block_time\)/);
        assert.ok(clock, 'the landing clock assignment');
        assert.equal(clock[1], 'batch_block_time = 0 OR VALUES(batch_block_time) < batch_block_time');
    });

    it('never writes a landing clock when it stores the skipped placeholder', async () => {
        const marker = await captured('setSkippedPriceSnapshotRound', priceQueries, [7, ['BTC/USD'], 101, 1700000000]);
        assert.ok(!marker.sql.includes('batch_block_time'));
        assert.ok(marker.sql.includes('ON DUPLICATE KEY UPDATE status = status'));
    });

    it('stamps by round only on rows that are not skipped', async () => {
        const stamp = await captured('updatePriceSnapshotByRoundNumber', priceQueries, [1700000100, 7, 1700000100]);
        assert.ok(stamp.sql.includes("status != 'skipped' AND (batch_block_time = 0 OR batch_block_time > ?)"));
    });
});
