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

// Integration: oracle_prices latest-mode snapshot query (item #2274).
//
// Feed identity is (source_address, coin, tick, fiat): PRICE v1 is
// permissionless, so two operators publishing the same (coin,tick,fiat) is
// normal. The latest-mode query must return each OPERATOR's latest effective
// row, not one MAX(effective_at) winner per pair; grouping without
// source_address hid an abandoned operator's stale feed behind a fresher
// operator (no feed-stale alert while dispensers pinned to that
// ORACLE_ADDRESS kept settling against dead data).

const { expect } = require('chai');
const testDb     = require('../../helpers/testDb');
const { buildOraclePricesSnapshotQuery } = require('../../../src/oraclePricesSnapshotQuery');

const NOW = 1800000000;

async function seed(db, rows) {
    let actionIndex = 1;
    for (const r of rows) {
        await db.doQuery(
            `INSERT INTO oracle_prices
                 (source_address, source_chain, coin, tick, fiat, value, block_time, effective_at, action_index)
             VALUES (?, 'BTC', ?, ?, ?, ?, ?, ?, ?)`,
            [r.source, r.coin, r.tick, r.fiat, r.value, r.effectiveAt, r.effectiveAt, actionIndex++]);
    }
}

describe('Integration: oracle_prices latest mode (per-operator feed identity)', function () {

    let db;

    before(async function () {
        try {
            await testDb.setup();
            db = testDb.getDb();
        } catch (e) {
            console.warn('MariaDB unavailable; skipping oracle_prices latest tests');
        }
    });

    beforeEach(async function () {
        if (!testDb.isAvailable()) this.skip();
        await testDb.truncateAll();
    });

    after(async function () {
        await testDb.teardown();
    });

    it('returns each operator\'s latest row for a shared (coin,tick,fiat), so a stale operator stays visible', async function () {
        this.timeout(20000);
        await seed(db, [
            // Operator A abandoned the feed six months ago.
            { source: 'opA', coin: 'BTC', tick: 'PEPECASH', fiat: 'USD', value: '1.0', effectiveAt: NOW - 180 * 86400 },
            // Operator B publishes the same pair hourly; two rows, only the
            // newest of B's may win B's slot.
            { source: 'opB', coin: 'BTC', tick: 'PEPECASH', fiat: 'USD', value: '2.0', effectiveAt: NOW - 7200 },
            { source: 'opB', coin: 'BTC', tick: 'PEPECASH', fiat: 'USD', value: '2.1', effectiveAt: NOW - 3600 },
        ]);

        const { sql, params } = buildOraclePricesSnapshotQuery({ latest: true, now: NOW });
        const rows = await db.doQuery(sql, params);

        expect(rows).to.have.length(2);
        const bySource = Object.fromEntries(rows.map((r) => [r.source_address, r]));
        expect(bySource.opA, 'abandoned operator A must not be masked by fresher operator B').to.exist;
        expect(bySource.opA.value).to.equal('1.0');
        expect(bySource.opB.value, 'only operator B\'s newest row wins B\'s slot').to.equal('2.1');
    });

    it('still gates on effective_at <= now within each operator (future-dated update never wins)', async function () {
        this.timeout(20000);
        await seed(db, [
            { source: 'opA', coin: 'LTC', tick: 'DOGEPARTY', fiat: 'USD', value: '5.0', effectiveAt: NOW - 3600 },
            // Locked future-dated UPDATE from the same operator.
            { source: 'opA', coin: 'LTC', tick: 'DOGEPARTY', fiat: 'USD', value: '9.9', effectiveAt: NOW + 86400 },
        ]);

        const { sql, params } = buildOraclePricesSnapshotQuery({ latest: true, now: NOW });
        const rows = await db.doQuery(sql, params);

        expect(rows).to.have.length(1);
        expect(rows[0].value).to.equal('5.0');
    });
});
