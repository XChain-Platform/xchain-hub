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

// The retracted PRICE batch window reset as statements. A window carrying its landing's
// clock reads and clears only rows holding that clock, the shape the batch-row reset
// already uses; a window without one keeps the whole-range statement exactly.

const { expect } = require('chai');
const Database = require('../../../../src/db');

const LEGACY_READ = `SELECT DISTINCT round_number FROM price_snapshots WHERE round_number BETWEEN ? AND ? AND status != 'skipped' AND batch_block_time > 0`;
const LEGACY_CLEAR = `UPDATE price_snapshots SET batch_block_time = 0 WHERE round_number BETWEEN ? AND ? AND status != 'skipped' AND batch_block_time > 0`;

function fixture() {
    return [
        // Stamped by the retracted landing at 5000.
        { round_number: 100, status: 'finalized', batch_block_time: 5000 },
        // Stamped earlier by a landing that is still canonical, here or on another chain.
        { round_number: 101, status: 'finalized', batch_block_time: 4000 },
        { round_number: 102, status: 'finalized', batch_block_time: 0 },
        { round_number: 103, status: 'skipped', batch_block_time: 5000 },
        // Outside the window.
        { round_number: 110, status: 'finalized', batch_block_time: 5000 }
    ];
}

// Applies the predicate the SQL text carries, binding only the placeholders it names.
function fakeDb(rows) {
    const seen = [];
    return { seen, rows, async doQuery(sql, args) {
        seen.push([sql, args]);
        const clocked = sql.endsWith(' AND batch_block_time = ?');
        const [first, last, clock] = args;
        const hit = rows.filter(r => r.round_number >= first && r.round_number <= last && r.status !== 'skipped' &&
            r.batch_block_time > 0 && (!clocked || r.batch_block_time === clock));
        if (sql.startsWith('UPDATE')) { for (const r of hit) r.batch_block_time = 0; return { affectedRows: hit.length }; }
        return [...new Set(hit.map(r => r.round_number))].map(round_number => ({ round_number }));
    } };
}

const read = (db, ...a) => Database.prototype.findPriceSnapshotRoundsLandedBetween.call(db, ...a);
const clear = (db, ...a) => Database.prototype.updatePriceSnapshotsClearBatchBlockTimeBetween.call(db, ...a);

describe('retracted PRICE batch window landing reset statements', function () {
    it('reads and clears only the rows holding the retracted landing clock', async function () {
        const db = fakeDb(fixture());
        expect((await read(db, 100, 105, 5000)).map(r => r.round_number)).to.deep.equal([100]);
        expect((await clear(db, 100, 105, 5000)).affectedRows).to.equal(1);
        expect(db.rows.map(r => r.batch_block_time)).to.deep.equal([0, 4000, 0, 5000, 5000]);
    });

    it('binds the clock last under one predicate shared by the read and the clear', async function () {
        const db = fakeDb(fixture());
        await read(db, 100, 105, 5000);
        await clear(db, 100, 105, 5000);
        expect(db.seen[0][0]).to.equal(LEGACY_READ + ' AND batch_block_time = ?');
        expect(db.seen[1][0]).to.equal(LEGACY_CLEAR + ' AND batch_block_time = ?');
        expect(db.seen.map(s => s[1])).to.deep.equal([[100, 105, 5000], [100, 105, 5000]]);
    });

    it('keeps the whole-window statement exactly when the window carries no usable clock', async function () {
        for (const clock of [undefined, null, 0, -1, 1.5, '5000', NaN]) {
            const db = fakeDb(fixture());
            expect((await read(db, 100, 105, clock)).map(r => r.round_number), String(clock)).to.deep.equal([100, 101]);
            await clear(db, 100, 105, clock);
            expect(db.seen.map(s => s[0])).to.deep.equal([LEGACY_READ, LEGACY_CLEAR]);
            expect(db.seen.map(s => s[1])).to.deep.equal([[100, 105], [100, 105]]);
            expect(db.rows.map(r => r.batch_block_time)).to.deep.equal([0, 0, 0, 5000, 5000]);
        }
    });
});
