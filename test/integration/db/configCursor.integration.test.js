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

// Integration: getAllConfigs(sinceUpdatedAt) + getConfigWatermark() cursor.
//
// Verifies the delta-poll contract end to end against a real MariaDB:
//   - a full fetch (no cursor) returns every row plus a watermark,
//   - a fetch with a watermark returns the rows changed since PLUS the rows in
//     the watermark's own second (the boundary is inclusive `>=`, item #2265:
//     a strict `>` silently dropped a write committed after the row read but
//     stamped in the same second as the watermark),
//   - cursor-second rows are re-delivered each poll until a newer write lands;
//     consumers merge idempotently so redelivery is a no-op.
//
// updated_at has one-second granularity, so the tests cross a second boundary
// where they need the mutation to land in a fresh cursor second.

const { expect } = require('chai');
const testDb     = require('../../helpers/testDb');
const { waitUntil } = require('../../helpers/waitUntil');

// Count leaf params in the nested { coin: { network: { module: { param: v } } } }.
function countLeaves(configs) {
    let n = 0;
    for (let coin in configs)
        for (let network in configs[coin])
            for (let module in configs[coin][network])
                n += Object.keys(configs[coin][network][module]).length;
    return n;
}

describe('Integration: getallconfigs cursor (since_updated_at)', function () {

    let db;

    before(async function () {
        try {
            await testDb.setup();
            db = testDb.getDb();
        } catch (e) {
            console.warn('MariaDB unavailable; skipping config cursor tests');
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

        // Seed 120 rows in a single batch (all share one updated_at second).
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

        // A cursor at the current watermark re-delivers the watermark second's
        // rows (inclusive boundary, #2265) - here that is the whole seed batch.
        let boundary = await db.getAllConfigs(w0);
        expect(countLeaves(boundary)).to.equal(120);

        // Cross a second boundary so the mutation lands in a fresh cursor second. The
        // cursor is UNIX_TIMESTAMP(updated_at) on the SERVER, so poll the server clock
        // rather than assuming 1100ms of local wall time covers it.
        await waitUntil(async () => {
            let rows = await db.doQuery('SELECT UNIX_TIMESTAMP() AS now');
            return Number(rows[0].now) > w0;
        }, { timeoutMs: 5000, intervalMs: 25, label: 'the DB clock to cross into a fresh cursor second' });

        // Mutate exactly one row.
        await db.setParam('BTC', 'mainnet', 'mod0', 'p0', 'changed');
        let w1 = await db.getConfigWatermark();
        expect(w1).to.be.above(w0);

        // Delta since W1: only the mutated row lives in the new cursor second.
        let delta = await db.getAllConfigs(w1);
        expect(countLeaves(delta)).to.equal(1);
        expect(delta.BTC.mainnet.mod0.p0).to.equal('changed');

        // Once a NEWER second holds a write, an advanced cursor no longer
        // re-delivers the old seed batch.
        await waitUntil(async () => {
            let rows = await db.doQuery('SELECT UNIX_TIMESTAMP() AS now');
            return Number(rows[0].now) > w1;
        }, { timeoutMs: 5000, intervalMs: 25, label: 'the DB clock to cross past the delta second' });
        await db.setParam('BTC', 'mainnet', 'mod0', 'p1', 'later');
        let w2 = await db.getConfigWatermark();
        expect(w2).to.be.above(w1);
        let caughtUp = await db.getAllConfigs(w2);
        expect(countLeaves(caughtUp)).to.equal(1);
        expect(caughtUp.BTC.mainnet.mod0.p1).to.equal('later');
    });

    // Regression for #2265: a write committed AFTER the watermark read but
    // stamped in the SAME epoch-second must still be delivered to a delta
    // consumer polling with that watermark. Under the old strict `>` boundary
    // it was silently dropped forever (until a full re-fetch).
    it('delivers a same-second write to a delta poll at the racing watermark', async function () {
        this.timeout(20000);
        await db.setParam('BTC', 'mainnet', 'race', 'seed', 'v0');
        let w0 = await db.getConfigWatermark();
        // Written immediately after the watermark read: usually lands in the
        // same second (the race this pins); if the clock ticks over it lands in
        // a later second - the inclusive boundary delivers it either way.
        await db.setParam('BTC', 'mainnet', 'race', 'late', 'v1');
        let delta = await db.getAllConfigs(w0);
        expect(delta.BTC && delta.BTC.mainnet && delta.BTC.mainnet.race
            && delta.BTC.mainnet.race.late).to.equal('v1');
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
