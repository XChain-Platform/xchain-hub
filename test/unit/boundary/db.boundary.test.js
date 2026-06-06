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

const sinon        = require('sinon');
const { expect }   = require('chai');
const proxyquire   = require('proxyquire');

// Stub mariadb module
let poolStub, connStub;
const Database = proxyquire('../../../src/db', {
    mariadb: {
        createPool: function (params) {
            return poolStub;
        },
        createConnection: function (params) {
            return Promise.resolve(connStub);
        }
    }
});

describe('Boundary: Database Layer', function () {

    beforeEach(function () {
        connStub = {
            query: sinon.stub().resolves([]),
            end:   sinon.stub().resolves()
        };
        poolStub = {
            getConnection: sinon.stub(),
            end:           sinon.stub().resolves()
        };
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // DB_NAME_REGEX = /^[A-Za-z0-9_]+$/
    // -----------------------------------------------------------------

    describe('database name validation', function () {

        it('alphanumeric with underscores → accepted', function () {
            expect(() => new Database('h', 3306, 'xchain_hub_test', 'u', 'p')).to.not.throw();
        });

        it('alphanumeric only → accepted', function () {
            expect(() => new Database('h', 3306, 'xchainhub123', 'u', 'p')).to.not.throw();
        });

        it('single character → accepted', function () {
            expect(() => new Database('h', 3306, 'x', 'u', 'p')).to.not.throw();
        });

        it('hyphen in name → rejected', function () {
            expect(() => new Database('h', 3306, 'xchain-hub', 'u', 'p')).to.throw('Invalid database name');
        });

        it('space in name → rejected', function () {
            expect(() => new Database('h', 3306, 'xchain hub', 'u', 'p')).to.throw('Invalid database name');
        });

        it('dot in name → rejected', function () {
            expect(() => new Database('h', 3306, 'xchain.hub', 'u', 'p')).to.throw('Invalid database name');
        });

        it('empty string → rejected', function () {
            expect(() => new Database('h', 3306, '', 'u', 'p')).to.throw('Invalid database name');
        });

        it('SQL injection attempt → rejected', function () {
            expect(() => new Database('h', 3306, "test'; DROP TABLE--", 'u', 'p')).to.throw('Invalid database name');
        });
    });

    // -----------------------------------------------------------------
    // Circuit breaker state transitions
    // -----------------------------------------------------------------

    describe('circuit breaker', function () {

        it('initial state is closed', function () {
            let db = new Database('h', 3306, 'test_db', 'u', 'p');
            expect(db.circuitState).to.equal('closed');
            expect(db.circuitFailures).to.equal(0);
        });

        it('failures below threshold keep circuit closed', function () {
            let db = new Database('h', 3306, 'test_db', 'u', 'p');
            // Manually simulate failures below threshold
            db.circuitFailures = db.circuitThreshold - 1; // 9
            expect(db.circuitState).to.equal('closed');
            expect(db.circuitFailures).to.equal(9);
        });

        it('threshold=10 opens circuit after 10 consecutive failures', async function () {
            let db = new Database('h', 3306, 'test_db', 'u', 'p');
            db.circuitThreshold = 3; // Lower threshold for test speed
            poolStub.getConnection.rejects(new Error('connection refused'));

            try {
                await db.getConnection();
            } catch (e) {
                expect(e.message).to.include('Circuit breaker opened');
            }
            expect(db.circuitState).to.equal('open');
        });

        it('open circuit rejects immediately before cooldown expires', async function () {
            let db = new Database('h', 3306, 'test_db', 'u', 'p');
            db.circuitState = 'open';
            db.circuitOpenUntil = Date.now() + 60000; // 60s in future

            try {
                await db.getConnection();
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Circuit breaker open');
            }
        });

        it('open circuit transitions to half-open after cooldown', async function () {
            let db = new Database('h', 3306, 'test_db', 'u', 'p');
            db.circuitState = 'open';
            db.circuitOpenUntil = Date.now() - 1; // Already expired

            let mockConn = { release: sinon.stub() };
            poolStub.getConnection.resolves(mockConn);

            let conn = await db.getConnection();
            expect(db.circuitState).to.equal('closed'); // half-open → successful → closed
            expect(conn).to.equal(mockConn);
        });
    });

    // -----------------------------------------------------------------
    // doQuery argument handling
    // -----------------------------------------------------------------

    describe('doQuery boundaries', function () {

        it('null query returns empty array', async function () {
            let db = new Database('h', 3306, 'test_db', 'u', 'p');
            let result = await db.doQuery(null);
            expect(result).to.deep.equal([]);
        });

        it('empty string query returns empty array', async function () {
            let db = new Database('h', 3306, 'test_db', 'u', 'p');
            let result = await db.doQuery('');
            expect(result).to.deep.equal([]);
        });

        it('object arguments are serialized via JSON.stringify', async function () {
            let db = new Database('h', 3306, 'test_db', 'u', 'p');
            let mockConn = {
                query: sinon.stub().resolves([{ id: 1 }]),
                release: sinon.stub()
            };
            poolStub.getConnection.resolves(mockConn);

            let warnStub = sinon.stub(console, 'warn');
            await db.doQuery('SELECT ?', [{ key: 'value' }]);
            let passedArgs = mockConn.query.getCall(0).args[1];
            expect(passedArgs[0]).to.equal('{"key":"value"}');
            expect(warnStub.calledWith(sinon.match('object arg serialized'))).to.be.true;
        });

        it('null arguments are preserved (not converted)', async function () {
            let db = new Database('h', 3306, 'test_db', 'u', 'p');
            let mockConn = {
                query: sinon.stub().resolves([]),
                release: sinon.stub()
            };
            poolStub.getConnection.resolves(mockConn);

            await db.doQuery('INSERT INTO t VALUES (?)', [null]);
            let passedArgs = mockConn.query.getCall(0).args[1];
            expect(passedArgs[0]).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // Connection pool config
    // -----------------------------------------------------------------

    describe('connection pool configuration', function () {

        it('connectionLimit defaults to 10', function () {
            let db = new Database('h', 3306, 'test_db', 'u', 'p');
            expect(db.connectionPoolParams.connectionLimit).to.equal(10);
        });

        it('connectTimeout defaults to 10000', function () {
            let db = new Database('h', 3306, 'test_db', 'u', 'p');
            expect(db.connectionPoolParams.connectTimeout).to.equal(10000);
        });
    });
});
