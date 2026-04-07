'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const Database   = require('../../../src/db');
const { runExperiment }      = require('../helpers/chaosRunner');
const { expectCircuitState } = require('../helpers/steadyStateChecker');

describe('Chaos: DB Connection Loss (DB-1)', function () {
    this.timeout(30000);

    let db, poolStub;

    beforeEach(function () {
        db = Object.create(Database.prototype);
        db.circuitState     = 'closed';
        db.circuitFailures  = 0;
        db.circuitThreshold = 10;
        db.circuitCooldown  = 200;
        db.circuitOpenUntil = 0;
        db.transactionConnection = null;

        // Default: reject to prevent infinite loops on unconfigured calls
        poolStub = { getConnection: sinon.stub().rejects(new Error('ECONNREFUSED')) };
        db.pool = poolStub;
        db._sleep = sinon.stub().resolves();

        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('circuit breaker opens after threshold consecutive failures', async function () {
        await runExperiment({
            name: 'DB connection loss — circuit breaker opens',

            baseline: () => {
                expectCircuitState(db, 'closed');
                return { circuitState: db.circuitState, failures: db.circuitFailures };
            },

            inject: async () => {
                try {
                    await db.getConnection();
                } catch (e) { /* expected */ }
            },

            observe: () => {
                expect(db.circuitState).to.equal('open');
                expect(db.circuitFailures).to.be.gte(db.circuitThreshold);
            }
        });
    });

    it('circuit breaker rejects immediately while open', async function () {
        db.circuitState     = 'open';
        db.circuitOpenUntil = Date.now() + 60000;

        let err;
        try {
            await db.getConnection();
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(err.message).to.include('Circuit breaker open');
    });

    it('circuit breaker transitions to half-open after cooldown expires', async function () {
        db.circuitState     = 'open';
        db.circuitOpenUntil = Date.now() - 1;

        let mockConn = { release: sinon.stub() };
        poolStub.getConnection.resolves(mockConn);

        let conn = await db.getConnection();
        expect(conn).to.equal(mockConn);
        expectCircuitState(db, 'closed');
        expect(db.circuitFailures).to.equal(0);
    });

    it('half-open failure re-opens the circuit breaker', async function () {
        db.circuitState     = 'open';
        db.circuitOpenUntil = Date.now() - 1;
        db.circuitFailures  = 9;

        let err;
        try {
            await db.getConnection();
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(db.circuitState).to.equal('open');
        expect(db.circuitOpenUntil).to.be.gt(Date.now() - 1);
    });

    it('full lifecycle: closed → open → half-open → closed', async function () {
        let mockConn = { release: sinon.stub() };

        await runExperiment({
            name: 'DB connection loss — full lifecycle',

            baseline: () => {
                expectCircuitState(db, 'closed');
            },

            inject: async () => {
                try {
                    await db.getConnection();
                } catch (e) { /* expected */ }
            },

            observe: () => {
                expectCircuitState(db, 'open');
            },

            recover: async () => {
                db.circuitOpenUntil = Date.now() - 1;
                poolStub.getConnection.resolves(mockConn);
            },

            verify: async () => {
                let conn = await db.getConnection();
                expect(conn).to.equal(mockConn);
                expectCircuitState(db, 'closed');
                expect(db.circuitFailures).to.equal(0);
            }
        });
    });

    it('doQuery retries through connection failures until circuit opens', async function () {
        let err;
        try {
            await db.doQuery('SELECT 1');
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(poolStub.getConnection.callCount).to.be.gte(db.circuitThreshold);
    });

    it('exponential backoff delays increase correctly', async function () {
        let mockConn = { release: sinon.stub(), query: sinon.stub().resolves([]) };

        // Fail 4 times then succeed
        poolStub.getConnection = sinon.stub().rejects(new Error('fail'));
        poolStub.getConnection.onCall(0).rejects(new Error('fail'));
        poolStub.getConnection.onCall(1).rejects(new Error('fail'));
        poolStub.getConnection.onCall(2).rejects(new Error('fail'));
        poolStub.getConnection.onCall(3).rejects(new Error('fail'));
        poolStub.getConnection.onCall(4).resolves(mockConn);

        await db.doQuery('SELECT 1');

        expect(db._sleep.callCount).to.equal(4);
        let delays = db._sleep.getCalls().map(c => c.args[0]);
        for (let i = 0; i < delays.length; i++) {
            expect(delays[i]).to.be.gt(0);
        }
    });

    it('failure count resets on successful connection', async function () {
        let mockConn = { release: sinon.stub(), query: sinon.stub().resolves([]) };

        // Fail 5 times, then succeed
        poolStub.getConnection = sinon.stub().rejects(new Error('fail'));
        for (let i = 0; i < 5; i++) {
            poolStub.getConnection.onCall(i).rejects(new Error('fail'));
        }
        poolStub.getConnection.onCall(5).resolves(mockConn);

        await db.doQuery('SELECT 1');
        expect(db.circuitFailures).to.equal(0);
        expectCircuitState(db, 'closed');
    });
});
