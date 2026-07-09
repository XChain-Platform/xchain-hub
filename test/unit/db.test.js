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

describe('Database', function () {

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

    afterEach(function () {
        sinon.restore();
    });

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

    // -----------------------------------------------------------------
    // doQuery()
    // -----------------------------------------------------------------

    describe('doQuery()', function () {
        let db;

        beforeEach(function () {
            db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
        });

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
    });

    // -----------------------------------------------------------------
    // Config methods
    // -----------------------------------------------------------------

    describe('setParam()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('executes upsert query', async function () {
            mockConn.query.resolves([]);
            await db.setParam('BTC', 'mainnet', 'indexer', 'host', 'localhost');
            expect(mockConn.query.calledOnce).to.be.true;
            let sql = mockConn.query.getCall(0).args[0];
            expect(sql).to.include('INSERT INTO configs');
            expect(sql).to.include('ON DUPLICATE KEY UPDATE');
        });
    });

    describe('setParams()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('executes a single multi-row upsert', async function () {
            mockConn.query.resolves([]);
            let n = await db.setParams([
                { coin: 'BTC', network: 'mainnet', module: 'indexer', paramName: 'host', paramValue: 'h1' },
                { coin: 'BTC', network: 'mainnet', module: 'indexer', paramName: 'port', paramValue: '3309' },
                { coin: 'LTC', network: 'testnet', module: 'encoder', paramName: 'host', paramValue: 'h2' }
            ]);
            expect(n).to.equal(3);
            expect(mockConn.query.calledOnce).to.be.true;
            let [sql, args] = mockConn.query.getCall(0).args;
            expect(sql).to.include('INSERT INTO configs');
            expect(sql).to.include('ON DUPLICATE KEY UPDATE');
            expect(sql).to.include('VALUES(param_value)');
            // 3 rows × 5 placeholders each
            expect(args).to.have.length(15);
            expect(args.slice(0, 5)).to.deep.equal(['BTC', 'mainnet', 'indexer', 'host', 'h1']);
        });

        it('is a no-op on empty input', async function () {
            let n = await db.setParams([]);
            expect(n).to.equal(0);
            expect(mockConn.query.called).to.be.false;
        });

        it('is a no-op on null/undefined input', async function () {
            expect(await db.setParams(null)).to.equal(0);
            expect(await db.setParams(undefined)).to.equal(0);
            expect(mockConn.query.called).to.be.false;
        });
    });

    describe('getConfig()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('returns config as key-value object', async function () {
            mockConn.query.resolves([
                { param_name: 'host', param_value: 'localhost' },
                { param_name: 'port', param_value: '3306' }
            ]);

            let config = await db.getConfig('BTC', 'mainnet', 'indexer');
            expect(config).to.deep.equal({ host: 'localhost', port: '3306' });
        });

        it('returns empty object when no config', async function () {
            mockConn.query.resolves([]);
            let config = await db.getConfig('BTC', 'mainnet', 'encoder');
            expect(config).to.deep.equal({});
        });
    });

    describe('getAllConfigs()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('reconstructs nested hierarchy', async function () {
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

        it('returns empty object when no configs', async function () {
            mockConn.query.resolves([]);
            let configs = await db.getAllConfigs();
            expect(configs).to.deep.equal({});
        });
    });

    describe('getLastSeq()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('returns the persisted last_seq as an integer', async function () {
            mockConn.query.resolves([{ value: '42' }]);
            let seq = await db.getLastSeq();
            expect(seq).to.equal(42);
        });

        it('returns 0 when no consensus_state row exists', async function () {
            mockConn.query.resolves([]);
            let seq = await db.getLastSeq();
            expect(seq).to.equal(0);
        });

        it('returns 0 when the stored value is unparseable', async function () {
            mockConn.query.resolves([{ value: 'not-a-number' }]);
            let seq = await db.getLastSeq();
            expect(seq).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Price ingest watermark (HUB-RETRACT-4)
    // -----------------------------------------------------------------

    describe('getPriceIngestWatermark() / bumpPriceIngestWatermark()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('returns null when no watermark row exists for the chain (so pre-reorg pushes are never rejected)', async function () {
            mockConn.query.resolves([]);
            expect(await db.getPriceIngestWatermark('BTC')).to.equal(null);
        });

        it('returns the parsed generation + orphaned-range bound when a row exists', async function () {
            mockConn.query.resolves([{ retraction_generation: '5', from_action_index: '100' }]);
            expect(await db.getPriceIngestWatermark('BTC')).to.deep.equal({ retraction_generation: 5, from_action_index: 100 });
        });

        it('issues a generation-monotonic upsert (GREATEST generation, LEAST from at equal generation)', async function () {
            await db.bumpPriceIngestWatermark('DOGE', 7, 50);
            let call = mockConn.query.getCalls().find(c => /INSERT INTO price_ingest_watermarks/.test(c.args[0]));
            expect(call, 'upsert issued').to.exist;
            expect(call.args[0]).to.match(/ON DUPLICATE KEY UPDATE/);
            expect(call.args[0]).to.match(/retraction_generation = GREATEST\(retraction_generation, VALUES\(retraction_generation\)\)/);
            expect(call.args[0]).to.match(/LEAST\(from_action_index, VALUES\(from_action_index\)\)/);
            expect(call.args[1]).to.deep.equal(['DOGE', 7, 50]);
        });

        it('ignores a negative/non-finite generation without touching the DB', async function () {
            await db.bumpPriceIngestWatermark('BTC', -1, 10);
            expect(mockConn.query.called).to.equal(false);
        });

        it('coerces a negative from_action_index to 0', async function () {
            await db.bumpPriceIngestWatermark('BTC', 3, -9);
            let call = mockConn.query.getCalls().find(c => /INSERT INTO price_ingest_watermarks/.test(c.args[0]));
            expect(call.args[1]).to.deep.equal(['BTC', 3, 0]);
        });
    });

    // -----------------------------------------------------------------
    // close()
    // -----------------------------------------------------------------

    describe('close()', function () {
        it('closes the pool', async function () {
            let db = new Database('h', 3306, 'db', 'u', 'p');
            await db.close();
            expect(mockPool.end.calledOnce).to.be.true;
        });
    });
});
