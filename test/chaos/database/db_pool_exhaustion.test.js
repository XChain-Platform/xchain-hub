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

const sinon      = require('sinon');
const { expect } = require('chai');
const Database   = require('../../../src/db');
const { runExperiment }      = require('../helpers/chaosRunner');
const { expectCircuitState } = require('../helpers/steadyStateChecker');



let db, poolStub;
function registerBeforeEachHook() {

    beforeEach(function () {
        db = Object.create(Database.prototype);
        db.circuitState     = 'closed';
        db.circuitFailures  = 0;
        db.circuitThreshold = 10;
        db.circuitCooldown  = 100;
        db.circuitOpenUntil = 0;
        db.transactionConnection = null;

        // Default: reject to prevent infinite loops
        poolStub = { getConnection: sinon.stub().rejects(new Error('pool exhausted')) };
        db.pool = poolStub;
        db.sleep = sinon.stub().resolves();

        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });
}

function registerAfterEachHook() {

    afterEach(function () {
        sinon.restore();
    });
}

// The driver's queued-acquire timeout: every pooled connection is busy and the
// request waited out acquireTimeout. The database is up, so this is saturation.
function poolSaturationError() {
    const e = new Error('(conn:-1, no: 45028, SQLState: HY000) pool timeout: failed to retrieve a connection ' +
        'from pool after 10000ms\n    (pool connections: active=10 idle=0 limit=10)');
    e.code  = 'ER_GET_CONNECTION_TIMEOUT';
    e.errno = 45028;
    return e;
}

function registerPoolTimeoutErrorsDoNotCountTowardCircuitTest() {

    it('pool acquire timeouts do not count toward circuit breaker', async function () {
        poolStub.getConnection = sinon.stub().callsFake(() => Promise.reject(poolSaturationError()));
        let err;
        try {
            await db.getConnection();
        } catch (e) {
            err = e;
        }

        // The caller still gives up at its own attempt bound, but the breaker
        // stays closed so every other DB caller keeps being served.
        expect(err).to.exist;
        expect(err.message).to.include('Could not connect to MariaDB after 30 attempts');
        expectCircuitState(db, 'closed');
        expect(db.circuitFailures).to.equal(0);
    });
}

function registerUnreachableDbErrorsCountTowardCircuitTest() {

    it('connect failures count toward circuit breaker', async function () {
        let err;
        try {
            await db.getConnection();
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expectCircuitState(db, 'open');
        expect(db.circuitFailures).to.be.gte(db.circuitThreshold);
    });
}

function registerPoolRecoversAfterBriefExhaustionTest() {

    it('pool recovers after brief exhaustion', async function () {
        let mockConn = { release: sinon.stub(), query: sinon.stub().resolves([]) };

        poolStub.getConnection = sinon.stub().rejects(new Error('pool exhausted'));
        poolStub.getConnection.onCall(0).rejects(new Error('pool exhausted'));
        poolStub.getConnection.onCall(1).rejects(new Error('pool exhausted'));
        poolStub.getConnection.onCall(2).rejects(new Error('pool exhausted'));
        poolStub.getConnection.onCall(3).resolves(mockConn);

        await db.doQuery('SELECT 1');
        expectCircuitState(db, 'closed');
        expect(db.circuitFailures).to.equal(0);
    });
}

function registerPoolExhaustionFollowedByCompleteFailureTest() {

    it('pool exhaustion followed by complete failure opens circuit', async function () {
        // Saturation first (not counted), then the database goes away: only the
        // connect failures count, and ten of them open the breaker.
        poolStub.getConnection = sinon.stub().rejects(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
        for (let i = 0; i < 5; i++)
            poolStub.getConnection.onCall(i).rejects(poolSaturationError());

        let err;
        try {
            await db.doQuery('SELECT 1');
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(err.message).to.include('Circuit breaker opened after 10 consecutive failures');
        expectCircuitState(db, 'open');
        expect(poolStub.getConnection.callCount).to.equal(15);
    });
}

function registerReleasedConnectionsRestorePoolAvailabilityTest() {

    it('released connections restore pool availability', async function () {
        let releaseCount = 0;
        let mockConn = {
            release: sinon.stub().callsFake(() => { releaseCount++; }),
            query:   sinon.stub().resolves([])
        };

        poolStub.getConnection.resolves(mockConn);

        await db.doQuery('SELECT 1');
        await db.doQuery('SELECT 2');
        await db.doQuery('SELECT 3');

        expect(releaseCount).to.equal(3);
        expectCircuitState(db, 'closed');
    });
}

function registerMaxAttemptsReachedBeforeCircuitThresholdTest() {

    it('max attempts reached before circuit threshold', async function () {
        db.circuitThreshold = 50; // Higher than max attempts (30)

        let err;
        try {
            await db.getConnection();
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(err.message).to.include('Could not connect to MariaDB after 30 attempts');
        expect(db.circuitFailures).to.equal(30);
    });
}
describe('Chaos: DB Pool Exhaustion (DB-3)', function () {
    this.timeout(30000);
    registerBeforeEachHook();
    registerAfterEachHook();
    registerPoolTimeoutErrorsDoNotCountTowardCircuitTest();
    registerUnreachableDbErrorsCountTowardCircuitTest();
    registerPoolRecoversAfterBriefExhaustionTest();
    registerPoolExhaustionFollowedByCompleteFailureTest();
    registerReleasedConnectionsRestorePoolAvailabilityTest();
    registerMaxAttemptsReachedBeforeCircuitThresholdTest();
});
