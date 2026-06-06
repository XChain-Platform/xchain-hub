'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Integration: getAllConfigs(sinceUpdatedAt) + getConfigWatermark() cursor.
//
// Verifies the delta-poll contract end to end against a real MariaDB:
//   - a full fetch (no cursor) returns every row plus a watermark,
//   - a fetch with that watermark returns ONLY rows changed since,
//   - a fetch with the current watermark returns nothing.
//
// updated_at has one-second granularity, so the test deliberately crosses a
// second boundary between seeding and mutating — otherwise the mutated row would
// share the seed's timestamp and the strict `>` cursor could not separate them.

const { expect } = require('chai');
const testDb     = require('../../helpers/testDb');

// Count leaf params in the nested { coin: { network: { module: { param: v } } } }.
function countLeaves(configs) {
    let n = 0;
    for (let coin in configs)
        for (let network in configs[coin])
            for (let module in configs[coin][network])
                n += Object.keys(configs[coin][network][module]).length;
    return n;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

describe('Integration: getallconfigs cursor (since_updated_at)', function () {

    let db;

    before(async function () {
        try {
            await testDb.setup();
            db = testDb.getDb();
        } catch (e) {
            console.warn('MariaDB unavailable — skipping config cursor tests');
        }
    });

    beforeEach(async function () {
        if (!testDb.isAvailable()) this.skip();
        await testDb.truncateAll();
    });

    after(async function () {
        await testDb.teardown();
    });

    it('returns a delta against a prior watermark, then nothing once caught up', async function () {
        this.timeout(20000);

        // Seed 120 rows in a single batch — all share one updated_at second.
        let rows = [];
        for (let i = 0; i < 120; i++) {
            rows.push({
                coin:       'BTC',
                network:    'mainnet',
                module:     'mod' + Math.floor(i / 10),
                paramName:  'p' + (i % 10),
                paramValue: 'v' + i
            });
        }
        await db.setParams(rows);

        // Full fetch (no cursor): all rows + a watermark W0.
        let all = await db.getAllConfigs();
        let w0  = await db.getConfigWatermark();
        expect(countLeaves(all)).to.equal(120);
        expect(w0).to.be.a('number').and.be.above(0);

        // A cursor at the current watermark already sees everything → empty delta.
        let none = await db.getAllConfigs(w0);
        expect(countLeaves(none)).to.equal(0);

        // Cross a second boundary so the mutation lands strictly after W0.
        await sleep(1100);

        // Mutate exactly one row.
        await db.setParam('BTC', 'mainnet', 'mod0', 'p0', 'changed');
        let w1 = await db.getConfigWatermark();
        expect(w1).to.be.above(w0);

        // Delta since W0: only the one changed row comes back.
        let delta = await db.getAllConfigs(w0);
        expect(countLeaves(delta)).to.equal(1);
        expect(delta.BTC.mainnet.mod0.p0).to.equal('changed');

        // Delta since the current watermark: nothing left to send.
        let caughtUp = await db.getAllConfigs(w1);
        expect(countLeaves(caughtUp)).to.equal(0);
    });

    it('treats a zero / missing cursor as a full fetch', async function () {
        await db.setParam('LTC', 'testnet', 'decoder', 'host', 'dec-host');
        await db.setParam('LTC', 'testnet', 'decoder', 'port', '3309');

        let viaZero    = await db.getAllConfigs(0);
        let viaMissing = await db.getAllConfigs();
        expect(countLeaves(viaZero)).to.equal(2);
        expect(countLeaves(viaMissing)).to.equal(2);
    });
});
