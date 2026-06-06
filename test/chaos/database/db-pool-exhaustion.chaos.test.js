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

const sinon      = require('sinon');
const { expect } = require('chai');
const Database   = require('../../../src/db');
const { runExperiment }      = require('../helpers/chaosRunner');
const { expectCircuitState } = require('../helpers/steadyStateChecker');

describe('Chaos: DB Pool Exhaustion (DB-3)', function () {
    this.timeout(30000);

    let db, poolStub;

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
        db._sleep = sinon.stub().resolves();

        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('pool timeout errors count toward circuit breaker', async function () {
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

    it('pool exhaustion followed by complete failure opens circuit', async function () {
        let err;
        try {
            await db.doQuery('SELECT 1');
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expectCircuitState(db, 'open');
    });

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
});
