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

describe('Regression: Database', function () {

    let mockPool, mockConn, mockMariadb, Database;

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

    afterEach(function () { sinon.restore(); });

    // -----------------------------------------------------------------
    // REG-DB-003: Circuit breaker opens after threshold failures
    // -----------------------------------------------------------------

    describe('REG-DB-003: Circuit breaker opens after consecutive failures', function () {
        it('opens after threshold consecutive failures @regression-p1', async function () {
            let db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
            mockPool.getConnection = sinon.stub().rejects(new Error('conn failed'));
            db.circuitThreshold = 3;
            db.circuitCooldown  = 100;

            try {
                await db.getConnection();
            } catch (e) {
                expect(e.message).to.include('Circuit breaker opened');
            }
            expect(db.circuitState).to.equal('open');
            expect(db.circuitFailures).to.equal(3);
        });

        it('rejects immediately when circuit is open @regression-p1', async function () {
            let db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
            db.circuitState     = 'open';
            db.circuitOpenUntil = Date.now() + 60000;

            try {
                await db.getConnection();
                expect.fail('should throw');
            } catch (e) {
                expect(e.message).to.include('Circuit breaker open');
            }
        });
    });

    // -----------------------------------------------------------------
    // REG-DB-004: Circuit breaker half-open recovery
    // -----------------------------------------------------------------

    describe('REG-DB-004: Circuit breaker half-open recovery', function () {
        it('transitions to closed after cooldown @regression-p2', async function () {
            let db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
            db.circuitState     = 'open';
            db.circuitOpenUntil = Date.now() - 1;

            let conn = await db.getConnection();
            expect(db.circuitState).to.equal('closed');
            expect(db.circuitFailures).to.equal(0);
            expect(conn).to.equal(mockConn);
        });

        it('resets failure count on successful connection @regression-p2', async function () {
            let db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
            db.circuitFailures = 5;
            let conn = await db.getConnection();
            expect(db.circuitFailures).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // REG-DB-005: Parameterized queries prevent SQL injection
    // -----------------------------------------------------------------

    describe('REG-DB-005: Parameterized queries', function () {
        it('executes parameterized query and releases connection @regression-p0', async function () {
            let db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
            mockConn.query.resolves([{ id: 1 }]);

            let result = await db.doQuery('SELECT * FROM foo WHERE id = ?', [1]);
            expect(mockConn.query.calledWith('SELECT * FROM foo WHERE id = ?', [1])).to.be.true;
            expect(mockConn.release.calledOnce).to.be.true;
            expect(result).to.deep.equal([{ id: 1 }]);
        });

        it('rejects invalid database name (SQL injection) @regression-p0', function () {
            expect(() => new Database('host', 3306, 'DROP TABLE', 'u', 'p')).to.throw('Invalid database name');
        });

        it('rejects database name with special chars @regression-p0', function () {
            expect(() => new Database('host', 3306, 'db;--', 'u', 'p')).to.throw('Invalid database name');
        });

        it('accepts alphanumeric and underscore names @regression-p0', function () {
            expect(() => new Database('host', 3306, 'XChain_Hub_Test_123', 'u', 'p')).to.not.throw();
        });

        it('serializes object args to JSON strings @regression-p0', async function () {
            let db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
            let objArg = { key: 'value' };
            await db.doQuery('INSERT INTO foo VALUES (?)', [objArg]);
            expect(mockConn.query.getCall(0).args[1][0]).to.equal('{"key":"value"}');
        });
    });

    // -----------------------------------------------------------------
    // REG-DB-002: Config CRUD
    // -----------------------------------------------------------------

    describe('REG-DB-002: Config CRUD', function () {
        it('setParam executes upsert query @regression-p1', async function () {
            let db = new Database('h', 3306, 'db', 'u', 'p');
            mockConn.query.resolves([]);

            await db.setParam('BTC', 'mainnet', 'indexer', 'host', 'localhost');
            expect(mockConn.query.calledOnce).to.be.true;
            let sql = mockConn.query.getCall(0).args[0];
            expect(sql).to.include('INSERT INTO configs');
            expect(sql).to.include('ON DUPLICATE KEY UPDATE');
        });

        it('getConfig returns key-value object @regression-p1', async function () {
            let db = new Database('h', 3306, 'db', 'u', 'p');
            mockConn.query.resolves([
                { param_name: 'host', param_value: 'localhost' },
                { param_name: 'port', param_value: '3306' }
            ]);

            let config = await db.getConfig('BTC', 'mainnet', 'indexer');
            expect(config).to.deep.equal({ host: 'localhost', port: '3306' });
        });

        it('getConfig returns empty object when no config @regression-p1', async function () {
            let db = new Database('h', 3306, 'db', 'u', 'p');
            mockConn.query.resolves([]);
            let config = await db.getConfig('BTC', 'mainnet', 'encoder');
            expect(config).to.deep.equal({});
        });

        it('getAllConfigs reconstructs nested hierarchy @regression-p1', async function () {
            let db = new Database('h', 3306, 'db', 'u', 'p');
            mockConn.query.resolves([
                { coin: 'BTC', network: 'mainnet', module: 'indexer', param_name: 'host', param_value: 'idx-host' },
                { coin: 'BTC', network: 'mainnet', module: 'indexer', param_name: 'port', param_value: '3309' },
                { coin: 'LTC', network: 'testnet', module: 'decoder', param_name: 'host', param_value: 'dec-host' }
            ]);

            let configs = await db.getAllConfigs();
            expect(configs.BTC.mainnet.indexer.host).to.equal('idx-host');
            expect(configs.BTC.mainnet.indexer.port).to.equal('3309');
            expect(configs.LTC.testnet.decoder.host).to.equal('dec-host');
        });
    });

    // -----------------------------------------------------------------
    // REG-DB-006 & 007: Pool and timeout
    // -----------------------------------------------------------------

    describe('REG-DB-006: Connection pool', function () {
        it('creates pool on construction @regression-p2', function () {
            let db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
            expect(mockMariadb.createPool.calledOnce).to.be.true;
            expect(db.dbName).to.equal('test_db');
        });
    });

    // -----------------------------------------------------------------
    // REG-DB-008: Transactions
    // -----------------------------------------------------------------

    describe('REG-DB-008: doQuery error handling', function () {
        it('returns empty results for null query @regression-p1', async function () {
            let db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
            let result = await db.doQuery(null);
            expect(result).to.deep.equal([]);
        });

        it('returns empty array on query error @regression-p1', async function () {
            let db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
            mockConn.query.rejects(new Error('syntax error'));
            let result = await db.doQuery('BAD SQL');
            expect(result).to.deep.equal([]);
            expect(mockConn.release.calledOnce).to.be.true;
        });
    });

    // Close
    describe('close()', function () {
        it('closes the pool @regression-p2', async function () {
            let db = new Database('h', 3306, 'db', 'u', 'p');
            await db.close();
            expect(mockPool.end.calledOnce).to.be.true;
        });
    });
});
