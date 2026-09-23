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
//
// The ATTEST batch-window durable claim (attest_published_batches, keyed on
// (network, window_start)) is what stops two overlapping sweeps on the SAME hub
// from both broadcasting a batch for one window and spending DOGE twice.
// claimWindowForBroadcast (src/attestation/batch_publisher/window.js) trusts
// affectedRows === 1 to mean "this call created the row, so this call may send".
//
// That trust was misplaced against the statement setAttestPublishedBatchByNetwork
// used to issue: `INSERT ... ON DUPLICATE KEY UPDATE window_start = window_start`.
// MySQL/MariaDB report affectedRows 0 for a duplicate whose ON DUPLICATE KEY UPDATE
// leaves every column unchanged - UNLESS the connection negotiated the
// CLIENT_FOUND_ROWS capability, in which case a matched-but-unchanged row reports
// 1 instead of 0. The hub's pool (src/db/index.js's connectionPoolParams) never
// sets `foundRows`, and the mariadb 3.5.3 driver defaults an unset `foundRows` to
// true (lib/config/connection-options.js: `this.foundRows = opts.foundRows ===
// undefined || Boolean(opts.foundRows)`), so every hub connection runs with
// CLIENT_FOUND_ROWS on. Under that default, a duplicate claim attempt reported
// affectedRows 1 exactly like the real creator, and claimWindowForBroadcast could
// not tell them apart: two overlapping attempts on the same window both won.
//
// The fix makes setAttestPublishedBatchByNetwork issue `INSERT IGNORE` instead.
// INSERT IGNORE never runs an UPDATE clause, so the CLIENT_FOUND_ROWS capability
// (which only changes how a matched UPDATE is counted) has nothing to act on: a
// duplicate is always 0 and a creation is always 1, with or without foundRows.
//
// The first block below models the historical statement directly, against the
// documented MariaDB affectedRows rule, to show the vulnerability was real. The
// second block drives the actual current src/db/attestation.js and
// src/attestation/batch_publisher/window.js code and proves the claim it issues
// today is exclusive under the same foundRows: true the hub pool actually runs
// with.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const windowMixin = require('../../../src/attestation/batch_publisher/window.js');

// The exact statement setAttestPublishedBatchByNetwork issued before this fix.
// Kept here, not in production code, purely to model what it did under
// foundRows: true.
const OLD_CLAIM_SQL = 'INSERT INTO attest_published_batches ' +
    '(network, window_start, window_end, batch_key, row_count, status) ' +
    'VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE window_start = window_start';

// A one-row-per-key model of attest_published_batches, answering exactly the
// statements setAttestPublishedBatchByNetwork and its DELETE guard issue, with
// MariaDB's own affectedRows rules for each form:
//
//   INSERT ... ON DUPLICATE KEY UPDATE <col> = <col>   (the pre-fix statement)
//     new row            -> 1
//     duplicate, foundRows false -> 0 (the row's values did not change)
//     duplicate, foundRows true  -> 1 (CLIENT_FOUND_ROWS counts the matched row)
//
//   INSERT IGNORE                                       (the current statement)
//     new row    -> 1
//     duplicate  -> 0, always: IGNORE never runs an UPDATE, so CLIENT_FOUND_ROWS
//                   (which only changes how a matched UPDATE is counted) does not
//                   apply to it.
function makeClaimModel(foundRows) {
    const table = new Map();
    const key = (network, windowStart) => network + '|' + windowStart;

    async function query(sql, args) {
        const text = String(sql);

        if (/^INSERT IGNORE INTO attest_published_batches/i.test(text)) {
            const [network, windowStart, windowEnd, batchKey, rowCount, status] = args;
            const k = key(network, windowStart);
            if (table.has(k)) return { affectedRows: 0 };
            table.set(k, { network, windowStart, windowEnd, batchKey, rowCount, status });
            return { affectedRows: 1 };
        }

        if (text === OLD_CLAIM_SQL) {
            const [network, windowStart, windowEnd, batchKey, rowCount, status] = args;
            const k = key(network, windowStart);
            if (table.has(k)) return { affectedRows: foundRows ? 1 : 0 };
            table.set(k, { network, windowStart, windowEnd, batchKey, rowCount, status });
            return { affectedRows: 1 };
        }

        if (/^DELETE FROM attest_published_batches/i.test(text)) {
            const [network, windowStart, statusGuard] = args;
            const k = key(network, windowStart);
            const row = table.get(k);
            if (!row || row.status !== statusGuard) return { affectedRows: 0 };
            table.delete(k);
            return { affectedRows: 1 };
        }

        throw new Error('unexpected statement in claim model: ' + text);
    }

    return { table, query };
}

// A real Database instance (src/db, with the attestation.js mixin installed),
// mariadb and fs fully stubbed, its connection routed through one claim model so
// setAttestPublishedBatchByNetwork's actual SQL text is what gets exercised.
function makeDb(foundRows) {
    const model = makeClaimModel(foundRows);
    const mockConn = {
        query:   sinon.stub().callsFake(model.query),
        release: sinon.stub().resolves(),
        end:     sinon.stub().resolves()
    };
    const mockPool = {
        getConnection: sinon.stub().resolves(mockConn),
        end:           sinon.stub().resolves()
    };
    const Database = proxyquire('../../../src/db', {
        mariadb: { createPool: sinon.stub().returns(mockPool), createConnection: sinon.stub().resolves(mockConn) },
        fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') }
    });
    const db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
    return { db, model };
}

function registerOldStatementModelTests() {
    describe('the pre-fix statement, modeled directly against MariaDB\'s affectedRows rule', function () {
        it('reports affectedRows 1 for the real creator', async function () {
            const model = makeClaimModel(true);
            const result = await model.query(OLD_CLAIM_SQL,
                ['regtest', 1000, 1010, 'key-a', 0, 'intent']);
            expect(result.affectedRows).to.equal(1);
        });

        it('under foundRows: true, ALSO reports affectedRows 1 for a duplicate: two contenders both win', async function () {
            const model = makeClaimModel(true);
            const first  = await model.query(OLD_CLAIM_SQL, ['regtest', 1000, 1010, 'key-a', 0, 'intent']);
            const second = await model.query(OLD_CLAIM_SQL, ['regtest', 1000, 1010, 'key-a', 0, 'intent']);
            expect(first.affectedRows).to.equal(1);
            expect(second.affectedRows, 'a duplicate claim must not read as a win').to.equal(1);
        });

        it('under foundRows: false, a duplicate correctly reports affectedRows 0 - the pool never gets this default', async function () {
            const model = makeClaimModel(false);
            await model.query(OLD_CLAIM_SQL, ['regtest', 1000, 1010, 'key-a', 0, 'intent']);
            const second = await model.query(OLD_CLAIM_SQL, ['regtest', 1000, 1010, 'key-a', 0, 'intent']);
            expect(second.affectedRows).to.equal(0);
        });
    });
}

function registerCurrentStatementTests() {
    describe('setAttestPublishedBatchByNetwork today, run against a connection with foundRows: true', function () {
        it('issues INSERT IGNORE, with no ON DUPLICATE KEY UPDATE clause', async function () {
            const { db } = makeDb(true);
            await db.setAttestPublishedBatchByNetwork('regtest', 2000, 2010, 'key-b', 0, 'intent');
            const calledSql = (await db.getConnection()).query.getCall(0).args[0];
            expect(calledSql).to.match(/^INSERT IGNORE INTO attest_published_batches/i);
            expect(calledSql).to.not.match(/ON DUPLICATE KEY UPDATE/i);
        });

        it('reports affectedRows 1 for the creating call and 0 for every later duplicate', async function () {
            const { db } = makeDb(true);
            const first  = await db.setAttestPublishedBatchByNetwork('regtest', 3000, 3010, 'key-c', 0, 'intent');
            const second = await db.setAttestPublishedBatchByNetwork('regtest', 3000, 3010, 'key-c', 0, 'intent');
            const third  = await db.setAttestPublishedBatchByNetwork('regtest', 3000, 3010, 'key-c', 0, 'intent');
            expect(Number(first.affectedRows)).to.equal(1);
            expect(Number(second.affectedRows)).to.equal(0);
            expect(Number(third.affectedRows)).to.equal(0);
        });
    });
}

// claimWindowForBroadcast is a mixin method, installed on
// AttestationBatchPublisher.prototype in production; called here directly against
// a minimal context so the assertion is about the SQL/affectedRows contract, not
// the surrounding publisher machinery already covered by
// attestation_batch_publisher_014_one_broadcast_per_window.test.js.
function makeClaimCtx(db) {
    return { hubDb: () => db, network: 'regtest' };
}

function registerClaimWindowForBroadcastTests() {
    describe('claimWindowForBroadcast (src/attestation/batch_publisher/window.js), end to end', function () {
        it('lets exactly one of two identical claim attempts win', async function () {
            const { db } = makeDb(true);
            const window = { window_start: 4000, window_end: 4010, row_count: 0 };

            const firstWon  = await windowMixin.claimWindowForBroadcast.call(makeClaimCtx(db), window, 'key-d');
            const secondWon = await windowMixin.claimWindowForBroadcast.call(makeClaimCtx(db), window, 'key-d');

            expect(firstWon, 'the first attempt must create the marker and win').to.equal(true);
            expect(secondWon, 'a second attempt on the same window must not also win').to.equal(false);
        });

        it('lets a later window claim independently once the earlier one is settled', async function () {
            const { db } = makeDb(true);
            const windowA = { window_start: 5000, window_end: 5010, row_count: 0 };
            const windowB = { window_start: 5010, window_end: 5020, row_count: 0 };

            expect(await windowMixin.claimWindowForBroadcast.call(makeClaimCtx(db), windowA, 'key-e')).to.equal(true);
            expect(await windowMixin.claimWindowForBroadcast.call(makeClaimCtx(db), windowB, 'key-f')).to.equal(true);
        });
    });
}

describe('ATTEST batch-window claim: exclusivity under the hub pool\'s foundRows default', function () {
    registerOldStatementModelTests();
    registerCurrentStatementTests();
    registerClaimWindowForBroadcastTests();
});
