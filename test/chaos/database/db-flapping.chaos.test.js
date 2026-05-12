'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const Database   = require('../../../src/db');
const { runExperiment }      = require('../helpers/chaosRunner');
const { expectCircuitState } = require('../helpers/steadyStateChecker');

describe('Chaos: DB Flapping Connection (DB-5)', function () {
    this.timeout(30000);

    let db, poolStub, mockConn;

    beforeEach(function () {
        db = Object.create(Database.prototype);
        db.circuitState     = 'closed';
        db.circuitFailures  = 0;
        db.circuitThreshold = 10;
        db.circuitCooldown  = 100;
        db.circuitOpenUntil = 0;
        db.transactionConnection = null;

        mockConn = {
            release: sinon.stub(),
            query:   sinon.stub().resolves([])
        };

        // Default behavior: reject (prevents infinite loops on unconfigured calls)
        poolStub = { getConnection: sinon.stub().rejects(new Error('default: no connection')) };
        db.pool = poolStub;
        db._sleep = sinon.stub().resolves();

        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('brief outage (< threshold) does not open circuit breaker', async function () {
        // Fail 5 times (below threshold of 10) then succeed
        poolStub.getConnection = sinon.stub();
        poolStub.getConnection.rejects(new Error('ECONNREFUSED')); // default
        for (let i = 0; i < 5; i++) {
            poolStub.getConnection.onCall(i).rejects(new Error('ECONNREFUSED'));
        }
        poolStub.getConnection.onCall(5).resolves(mockConn);

        await db.doQuery('SELECT 1');
        expectCircuitState(db, 'closed');
        expect(db.circuitFailures).to.equal(0);
    });

    it('sustained outage (>= threshold) opens circuit breaker', async function () {
        // All calls reject
        poolStub.getConnection.rejects(new Error('ECONNREFUSED'));

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

    it('successful query resets failure count to zero', async function () {
        // Fail a few times then succeed
        poolStub.getConnection = sinon.stub().rejects(new Error('fail'));
        poolStub.getConnection.onCall(0).rejects(new Error('fail'));
        poolStub.getConnection.onCall(1).rejects(new Error('fail'));
        poolStub.getConnection.onCall(2).resolves(mockConn);

        await db.doQuery('SELECT 1');
        expect(db.circuitFailures).to.equal(0);
        expectCircuitState(db, 'closed');
    });

    it('multiple queries each reset failure count independently', async function () {
        // Query 1: 3 failures then success
        poolStub.getConnection = sinon.stub().rejects(new Error('fail'));
        poolStub.getConnection.onCall(0).rejects(new Error('fail'));
        poolStub.getConnection.onCall(1).rejects(new Error('fail'));
        poolStub.getConnection.onCall(2).rejects(new Error('fail'));
        poolStub.getConnection.onCall(3).resolves(mockConn);
        // Query 2: succeeds immediately
        poolStub.getConnection.onCall(4).resolves(mockConn);

        await db.doQuery('SELECT 1');
        expect(db.circuitFailures).to.equal(0);

        await db.doQuery('SELECT 2');
        expect(db.circuitFailures).to.equal(0);
        expectCircuitState(db, 'closed');
    });

    it('flapping after circuit open: recovery through half-open', async function () {
        // Force circuit open with expired cooldown
        db.circuitState     = 'open';
        db.circuitFailures  = 10;
        db.circuitOpenUntil = Date.now() - 1;

        poolStub.getConnection.resolves(mockConn);

        let conn = await db.getConnection();
        expect(conn).to.equal(mockConn);
        expectCircuitState(db, 'closed');
        expect(db.circuitFailures).to.equal(0);
    });

    it('flapping after circuit open: half-open fails, re-opens', async function () {
        db.circuitState     = 'open';
        db.circuitFailures  = 9;
        db.circuitOpenUntil = Date.now() - 1;

        poolStub.getConnection.rejects(new Error('still down'));

        let err;
        try {
            await db.getConnection();
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expectCircuitState(db, 'open');
        expect(db.circuitOpenUntil).to.be.gt(Date.now() - 100);
    });

    it('circuit breaker does not leak failures across successful queries', async function () {
        // Use a counter-based stub to avoid onCall issues
        let callIndex = 0;
        let responses = [
            // Query 1: fail, fail, fail, success
            () => { throw new Error('fail'); },
            () => { throw new Error('fail'); },
            () => { throw new Error('fail'); },
            () => mockConn,
            // Query 2: fail, fail, success
            () => { throw new Error('fail'); },
            () => { throw new Error('fail'); },
            () => mockConn
        ];

        poolStub.getConnection = sinon.stub().callsFake(async () => {
            let fn = responses[callIndex++];
            if (!fn) throw new Error('unexpected call');
            return fn();
        });

        await db.doQuery('SELECT 1');
        expect(db.circuitFailures).to.equal(0);

        await db.doQuery('SELECT 2');
        expect(db.circuitFailures).to.equal(0);
        expectCircuitState(db, 'closed');
    });
});
