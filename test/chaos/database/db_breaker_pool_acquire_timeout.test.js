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

// The DB circuit breaker exists for a database the hub cannot reach. A pool
// whose ten connections are all checked out by slow callers is a different
// fault: MariaDB is up, the queue just waits past acquireTimeout. Counting
// those queued timeouts as connect failures let one busy oracle round (one
// acquire per pair, far more than the pool limit) open the breaker and reject
// every DB caller for the whole cooldown. These cases pin the split: a queued
// acquire timeout never trips the breaker, a real connect failure still does.

const sinon      = require('sinon');
const { expect } = require('chai');
const Database   = require('../../../src/db');

const DRIVER_HEADER = '(conn:-1, no: 45028, SQLState: HY000) ';

// Shaped like mariadb 3.x's queued-acquire timeout: the pool has live
// connections, all busy, and the request waited out acquireTimeout.
function poolSaturationError() {
    const e = new Error(DRIVER_HEADER + 'pool timeout: failed to retrieve a connection from pool after 10000ms\n' +
        '    (pool connections: active=10 idle=0 limit=10)');
    e.code     = 'ER_GET_CONNECTION_TIMEOUT';
    e.errno    = 45028;
    e.sqlState = 'HY000';
    return e;
}

// Shaped like the driver's other acquire-timeout variant: no live connection
// and the pool could not create one. It shares the saturation error's code but
// not its message, and it means an unreachable database, so it must still count.
function poolCannotConnectError() {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' });
    const e = new Error(DRIVER_HEADER + 'pool failed to retrieve a connection from pool\n' +
        '    (pool connections: active=0 idle=0 limit=10)', { cause });
    e.code     = 'ER_GET_CONNECTION_TIMEOUT';
    e.errno    = 45028;
    e.sqlState = 'HY000';
    return e;
}

function connectError(code) {
    return Object.assign(new Error('connect failure ' + code), { code });
}

function fakeConn() {
    return { release: sinon.stub().resolves(), query: sinon.stub().resolves([]) };
}

let db;

function makeDb() {
    const d = Object.create(Database.prototype);
    d.circuitState          = 'closed';
    d.circuitFailures       = 0;
    d.circuitThreshold      = 10;
    d.circuitCooldown       = 50;
    d.circuitOpenUntil      = 0;
    d.transactionConnection = null;
    d.sleep = sinon.stub().resolves();
    return d;
}

function registerHooks() {
    beforeEach(function () {
        db = makeDb();
    });

    afterEach(function () {
        sinon.restore();
    });
}

function registerSaturationKeepsBreakerClosedTest() {
    it('keeps the breaker closed through 40 queued acquire timeouts across concurrent callers', async function () {
        const conn = fakeConn();
        const getConnection = sinon.stub();
        for (let i = 0; i < 40; i++)
            getConnection.onCall(i).rejects(poolSaturationError());
        getConnection.resolves(conn);
        db.pool = { getConnection };

        const callers = [];
        for (let i = 0; i < 8; i++)
            callers.push(db.getConnection());
        const settled = await Promise.allSettled(callers);

        const rejected = settled.filter((s) => s.status === 'rejected');
        expect(rejected.map((s) => s.reason.message)).to.deep.equal([]);
        expect(settled.every((s) => s.value === conn)).to.equal(true);
        expect(getConnection.callCount).to.be.gte(48);
        expect(db.circuitState).to.equal('closed');

        // A later caller is served straight away: nothing is held open.
        const later = await db.getConnection();
        expect(later).to.equal(conn);
        expect(db.circuitState).to.equal('closed');
    });
}

function registerSaturationDoesNotExtendRealStreakTest() {
    it('does not let saturation timeouts carry a real failure streak over the threshold', async function () {
        const conn = fakeConn();
        const getConnection = sinon.stub();
        // Nine real failures, then a long run of saturation, then success: the
        // real streak never reaches ten, so the breaker must stay closed.
        for (let i = 0; i < 9; i++)
            getConnection.onCall(i).rejects(connectError('ECONNREFUSED'));
        for (let i = 9; i < 25; i++)
            getConnection.onCall(i).rejects(poolSaturationError());
        getConnection.resolves(conn);
        db.pool = { getConnection };

        const got = await db.getConnection();
        expect(got).to.equal(conn);
        expect(db.circuitState).to.equal('closed');
        expect(db.circuitFailures).to.equal(0);
    });
}

function registerRealFailureOpensBreakerTest(label, make) {
    it('still opens the breaker on 10 consecutive real connect failures (' + label + ')', async function () {
        db.pool = { getConnection: sinon.stub().callsFake(() => Promise.reject(make())) };

        let err;
        try {
            await db.getConnection();
        } catch (e) {
            err = e;
        }
        expect(err).to.exist;
        expect(err.message).to.include('Circuit breaker opened after');
        expect(db.circuitState).to.equal('open');
        expect(db.circuitFailures).to.be.gte(10);

        // Open means callers are refused without touching the pool.
        const calls = db.pool.getConnection.callCount;
        let refused;
        try {
            await db.getConnection();
        } catch (e) {
            refused = e;
        }
        expect(refused.message).to.include('Circuit breaker open');
        expect(db.pool.getConnection.callCount).to.equal(calls);
    });
}

describe('Chaos: DB breaker ignores pool acquire saturation', function () {
    this.timeout(5000);
    registerHooks();
    registerSaturationKeepsBreakerClosedTest();
    registerSaturationDoesNotExtendRealStreakTest();
    registerRealFailureOpensBreakerTest('ECONNREFUSED', () => connectError('ECONNREFUSED'));
    registerRealFailureOpensBreakerTest('ER_CON_COUNT_ERROR', () => connectError('ER_CON_COUNT_ERROR'));
    registerRealFailureOpensBreakerTest('pool cannot create a connection', poolCannotConnectError);
});
