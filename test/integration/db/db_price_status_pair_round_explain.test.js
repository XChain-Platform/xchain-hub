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

// Integration: EXPLAIN of the last-finalized price read against a real MariaDB.
//
// The unit tier works the access path out from the declared keys; this tier asks the
// optimizer. The probe table is the src/sql price_snapshots definition under another
// name, filled with enough pairs, statuses and rounds that a scan costs more than the
// index, so the plan reflects the shape a grown hub has. It is created and dropped by
// the test, so nothing the hub reads is touched.

const fs       = require('fs');
const path     = require('path');
const { expect } = require('chai');
const testDb   = require('../../helpers/testDb');
const Database = require('../../../src/db');

const TABLE = 'price_status_pair_round_probe';
const SQL   = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'sql', 'price_snapshots.sql'), 'utf8');
const PAIRS = ['BTC/USD', 'LTC/USD', 'DOGE/USD', 'XCHAIN/BTC'];
const STATUSES = ['finalized', 'skipped', 'disputed'];
const ROUNDS = 1500;

let db;

// The last-finalized read as the hub issues it, pointed at the probe table.
async function lastFinalizedSql() {
    let seen = null;
    await Database.prototype.getLatestFinalizedPriceBelowRound.call(
        { doQuery: async (text) => { seen = text; return []; } }, 'BTC/USD', ROUNDS);
    return seen.split('price_snapshots').join('`' + TABLE + '`');
}

async function fillProbe() {
    for (let start = 0; start < ROUNDS; start += 250) {
        const values = [], args = [];
        for (let round = start; round < start + 250; round++) {
            for (const pair of PAIRS) {
                values.push("(?, ?, '1', 1, '{}', ?)");
                args.push(round, pair, STATUSES[round % STATUSES.length]);
            }
        }
        await db.doQuery('INSERT INTO `' + TABLE + '` (round_number, coin_pair, price, validator_count, ' +
            'consensus_proof, status) VALUES ' + values.join(', '), args);
    }
    await db.doQuery('ANALYZE TABLE `' + TABLE + '`');
}

function registerHooks() {
    before(async function () {
        this.timeout(60000);
        try {
            await testDb.setup();
            db = testDb.getDb();
        } catch (e) {
            console.warn('MariaDB unavailable; skipping the price index EXPLAIN test');
            return;
        }
        await db.doQuery('DROP TABLE IF EXISTS `' + TABLE + '`');
        await db.doQuery(Database.prototype.stripSqlLineComments.call(null, SQL)
            .replace(/CREATE TABLE price_snapshots/, 'CREATE TABLE `' + TABLE + '`'));
        await fillProbe();
    });

    beforeEach(function () {
        if (!testDb.isAvailable()) this.skip();
    });

    after(async function () {
        if (testDb.isAvailable()) await db.doQuery('DROP TABLE IF EXISTS `' + TABLE + '`');
        await testDb.teardown();
    });
}

describe('Integration: the last-finalized price read uses idx_status_pair_round', function () {
    registerHooks();

    it('EXPLAIN picks the index and reads the ORDER BY off it', async function () {
        const rows = await db.doQuery('EXPLAIN ' + await lastFinalizedSql(), ['BTC/USD', ROUNDS]);
        expect(rows).to.have.length(1);
        expect(rows[0].key).to.equal('idx_status_pair_round');
        expect(String(rows[0].Extra || '')).not.to.match(/filesort/i);
    });

    it('returns the newest finalized round below the bound', async function () {
        const rows = await db.doQuery(await lastFinalizedSql(), ['BTC/USD', ROUNDS]);
        expect(rows).to.have.length(1);
        const newest = await db.doQuery("SELECT MAX(round_number) AS r FROM `" + TABLE + "` WHERE coin_pair = ? " +
            "AND status = 'finalized' AND round_number < ?", ['BTC/USD', ROUNDS]);
        expect(Number(newest[0].r)).to.equal(ROUNDS - 3);
    });
});
