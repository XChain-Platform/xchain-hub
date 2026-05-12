'use strict';

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

        it('returns empty array on query error (non-transaction)', async function () {
            mockConn.query.rejects(new Error('syntax error'));
            let result = await db.doQuery('BAD SQL');
            expect(result).to.deep.equal([]);
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
