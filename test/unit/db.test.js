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

const sinon        = require('sinon');
const { expect }   = require('chai');
const proxyquire   = require('proxyquire');

let mockPool, mockConn, mockMariadb, Database, db;

function registerDatabaseHooks() {
        beforeEach(function () {
            mockConn = {
                query:   sinon.stub().resolves([]),
                release: sinon.stub().resolves(),
                end:     sinon.stub().resolves()
            };
            mockPool = {
                getConnection: sinon.stub().resolves(mockConn),
                end:           sinon.stub().resolves()
            };
            mockMariadb = {
                createPool:       sinon.stub().returns(mockPool),
                createConnection: sinon.stub().resolves(mockConn)
            };

            Database = proxyquire('../../src/db', {
                mariadb: mockMariadb,
                fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') },
                path:    require('path')
            });
        });

        afterEach(function () {
            sinon.restore();
        });
}

function registerConstructorTests() {
    // -----------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------

    describe('constructor', function () {
        it('creates pool with valid database name', function () {
            let db = new Database('localhost', 3306, 'xchain_hub', 'user', 'pass');
            expect(mockMariadb.createPool.calledOnce).to.be.true;
            expect(db.dbName).to.equal('xchain_hub');
        });

        it('throws on invalid database name (SQL injection)', function () {
            expect(() => new Database('host', 3306, 'DROP TABLE', 'u', 'p')).to.throw('Invalid database name');
        });

        it('throws on database name with special chars', function () {
            expect(() => new Database('host', 3306, 'db;--', 'u', 'p')).to.throw('Invalid database name');
        });

        it('accepts alphanumeric and underscore names', function () {
            expect(() => new Database('host', 3306, 'XChain_Hub_Test_123', 'u', 'p')).to.not.throw();
        });
    });
}

function registerCircuitBreakerTests() {
    // -----------------------------------------------------------------
    // Circuit breaker
    // -----------------------------------------------------------------

    describe('circuit breaker', function () {
        let db;

        beforeEach(function () {
            db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
        });

        it('opens after threshold consecutive failures', async function () {
            mockPool.getConnection = sinon.stub().rejects(new Error('conn failed'));
            db.circuitThreshold = 3; // lower for test speed
            db.circuitCooldown  = 100;

            try {
                await db.getConnection();
            } catch (e) {
                expect(e.message).to.include('Circuit breaker opened');
            }
            expect(db.circuitState).to.equal('open');
            expect(db.circuitFailures).to.equal(3);
        });

        it('rejects immediately when circuit is open', async function () {
            db.circuitState     = 'open';
            db.circuitOpenUntil = Date.now() + 60000;

            try {
                await db.getConnection();
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Circuit breaker open');
            }
        });

        it('transitions to half-open after cooldown', async function () {
            db.circuitState     = 'open';
            db.circuitOpenUntil = Date.now() - 1; // cooldown expired

            let conn = await db.getConnection();
            expect(db.circuitState).to.equal('closed');
            expect(db.circuitFailures).to.equal(0);
            expect(conn).to.equal(mockConn);
        });

        it('resets failure count on successful connection', async function () {
            db.circuitFailures = 5;
            let conn = await db.getConnection();
            expect(db.circuitFailures).to.equal(0);
            expect(conn).to.equal(mockConn);
        });
    });
}

function registerDoQueryBindingTests() {
        it('executes parameterized query and releases connection', async function () {
            mockConn.query.resolves([{ id: 1 }]);
            let result = await db.doQuery('SELECT * FROM foo WHERE id = ?', [1]);
            expect(mockConn.query.calledWith('SELECT * FROM foo WHERE id = ?', [1])).to.be.true;
            expect(mockConn.release.calledOnce).to.be.true;
            expect(result).to.deep.equal([{ id: 1 }]);
        });

        it('returns empty results for null query', async function () {
            let result = await db.doQuery(null);
            expect(result).to.deep.equal([]);
            expect(mockConn.query.called).to.be.false;
        });

        it('serializes object args to JSON strings', async function () {
            let objArg = { key: 'value' };
            await db.doQuery('INSERT INTO foo VALUES (?)', [objArg]);
            expect(mockConn.query.getCall(0).args[1][0]).to.equal('{"key":"value"}');
        });

        it('binds a Date as a UTC datetime literal', async function () {
            // Two bugs met here: JSON.stringify quoted the ISO string, which MariaDB
            // rejected outright (errno 1292), and the driver's own encoder writes a
            // Date in the PROCESS's local timezone against a UTC-pinned session, which
            // silently stored the wrong instant. A UTC literal settles both.
            let when = new Date('2026-07-29T23:24:46.579Z');
            await db.doQuery('INSERT INTO foo (created_at) VALUES (?)', [when]);
            expect(mockConn.query.getCall(0).args[1][0]).to.equal('2026-07-29 23:24:46.579');
        });
}

function registerDoQueryOutcomeTests() {
        it('binds a Date identically whatever the host timezone is', async function () {
            // Same instant, formatted from a Date object: the bound value must depend
            // only on the instant, never on where the hub runs.
            let when = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6));
            await db.doQuery('INSERT INTO foo (created_at) VALUES (?)', [when]);
            expect(mockConn.query.getCall(0).args[1][0]).to.equal('2026-01-02 03:04:05.006');
        });

        it('passes Buffer args through untouched', async function () {
            let blob = Buffer.from('deadbeef', 'hex');
            await db.doQuery('INSERT INTO foo (payload) VALUES (?)', [blob]);
            let bound = mockConn.query.getCall(0).args[1][0];
            expect(Buffer.isBuffer(bound)).to.be.true;
            expect(bound.equals(blob)).to.be.true;
        });

        it('still JSON-serializes arrays mixed alongside a Date', async function () {
            let when = new Date('2026-07-29T23:24:46.579Z');
            await db.doQuery('INSERT INTO foo (proof, created_at) VALUES (?, ?)', [['a', 'b'], when]);
            let args = mockConn.query.getCall(0).args[1];
            expect(args[0]).to.equal('["a","b"]');
            expect(args[1]).to.equal('2026-07-29 23:24:46.579');
        });

        it('throws on query error and still releases the connection (H-9: no false write success)', async function () {
            mockConn.query.rejects(new Error('syntax error'));
            let thrown = null;
            try {
                await db.doQuery('BAD SQL');
            } catch (e) {
                thrown = e;
            }
            expect(thrown).to.be.an('error');
            expect(thrown.message).to.equal('syntax error');
            expect(mockConn.release.calledOnce).to.be.true;
        });
}

function registerDoQueryTests() {
    // -----------------------------------------------------------------
    // doQuery()
    // -----------------------------------------------------------------
    describe('doQuery()', function () {
        beforeEach(function () {
            db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
        });
        registerDoQueryBindingTests();
        registerDoQueryOutcomeTests();
    });
}

describe('Database', function () {
    registerDatabaseHooks();
    registerConstructorTests();
    registerCircuitBreakerTests();
    registerDoQueryTests();
});
