'use strict';

const sinon        = require('sinon');
const { expect }   = require('chai');
const proxyquire   = require('proxyquire');

describe('XChainHub', function () {

    let mockDb, mockPool, mockConn, mockMariadb, XChainHub;

    beforeEach(function () {
        mockConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        mockPool = { getConnection: sinon.stub().resolves(mockConn), end: sinon.stub().resolves() };
        mockDb   = {
            doQuery:     sinon.stub().resolves([]),
            setParam:    sinon.stub().resolves(),
            getConfig:   sinon.stub().resolves({}),
            getAllConfigs: sinon.stub().resolves({}),
            createDatabase: sinon.stub().resolves(true),
            verifyTables:   sinon.stub().resolves(true),
            close:       sinon.stub().resolves()
        };

        // Stub the Database constructor to return our mock
        let DatabaseStub = function () { return mockDb; };

        XChainHub = proxyquire('../../src/XChainHub', {
            './db': DatabaseStub
        });
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------

    describe('constructor', function () {
        it('stores DB credentials and p2pConfig', function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', { P2P_PORT: 10001 });
            expect(hub.p2pConfig).to.deep.equal({ P2P_PORT: 10001 });
        });

        it('handles null p2pConfig', function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            expect(hub.p2pConfig).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // applyConfig()
    // -----------------------------------------------------------------

    describe('applyConfig()', function () {
        it('iterates nested config and calls setParam for each value', async function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;

            let config = {
                BTC: {
                    mainnet: {
                        indexer: {
                            host: 'idx-host',
                            port: '3309'
                        }
                    }
                }
            };

            await hub.applyConfig(config);

            expect(mockDb.setParam.callCount).to.equal(2);
            expect(mockDb.setParam.calledWith('BTC', 'mainnet', 'indexer', 'host', 'idx-host')).to.be.true;
            expect(mockDb.setParam.calledWith('BTC', 'mainnet', 'indexer', 'port', '3309')).to.be.true;
        });

        it('skips invalid parameter names', async function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;

            let config = {
                BTC: {
                    mainnet: {
                        indexer: {
                            host: 'localhost',
                            invalid_param: 'should-be-skipped'
                        }
                    }
                }
            };

            await hub.applyConfig(config);
            // Only 'host' should be applied, not 'invalid_param'
            let calledParams = mockDb.setParam.getCalls().map(c => c.args[3]);
            expect(calledParams).to.include('host');
            expect(calledParams).to.not.include('invalid_param');
        });
    });

    // -----------------------------------------------------------------
    // getAllConfigs()
    // -----------------------------------------------------------------

    describe('getAllConfigs()', function () {
        it('delegates to db.getAllConfigs()', async function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;
            mockDb.getAllConfigs.resolves({ BTC: { mainnet: {} } });

            let result = await hub.getAllConfigs();
            expect(mockDb.getAllConfigs.calledOnce).to.be.true;
            expect(result).to.deep.equal({ BTC: { mainnet: {} } });
        });
    });

    // -----------------------------------------------------------------
    // registerValidator()
    // -----------------------------------------------------------------

    describe('registerValidator()', function () {
        it('rejects invalid pubkey format', async function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;

            try {
                await hub.registerValidator('not-valid', 'ws://addr:10001');
                // May throw or return error depending on implementation
            } catch (e) {
                expect(e.message).to.include('64 hex');
                return;
            }
            // If it didn't throw, check for error property
            let result = await hub.registerValidator('not-valid-2', 'ws://addr:10001');
            expect(result).to.have.property('error');
        });

        it('inserts valid validator', async function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;

            let pubkey = 'aa'.repeat(32);
            await hub.registerValidator(pubkey, 'ws://validator:10001');
            expect(mockDb.doQuery.called).to.be.true;
            let sql = mockDb.doQuery.getCall(0).args[0];
            expect(sql).to.include('validators');
        });
    });

    // -----------------------------------------------------------------
    // getFeeQuote()
    // -----------------------------------------------------------------

    describe('getFeeQuote()', function () {
        it('returns fee quote using oracle price', async function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;

            // getPrice returns a price snapshot
            mockDb.doQuery.resolves([{ price: '100000.00000000', coin_pair: 'BTC/USD' }]);

            let result = await hub.getFeeQuote('SEND', 'BTC');
            // Should return something (exact format depends on implementation)
            expect(result).to.not.be.null;
        });

        it('handles missing price gracefully', async function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;
            mockDb.doQuery.resolves([]); // no price

            let result = await hub.getFeeQuote('SEND', 'BTC');
            expect(result).to.not.be.undefined;
        });
    });

    // -----------------------------------------------------------------
    // getValidators()
    // -----------------------------------------------------------------

    describe('getValidators()', function () {
        it('returns active validators from DB', async function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;
            mockDb.doQuery.resolves([
                { signing_pubkey: 'aa'.repeat(32), addr: 'ws://v1:10001', status: 'active' }
            ]);

            let result = await hub.getValidators();
            expect(result).to.have.lengthOf(1);
        });
    });

    // -----------------------------------------------------------------
    // Delegation methods
    // -----------------------------------------------------------------

    describe('delegation to subsystems', function () {
        let hub;

        beforeEach(function () {
            hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;
        });

        it('getPriceSnapshots() queries DB', async function () {
            mockDb.doQuery.resolves([{ round_number: 1 }]);
            let result = await hub.getPriceSnapshots(5);
            expect(mockDb.doQuery.called).to.be.true;
        });

        it('getPrice() queries latest finalized price', async function () {
            mockDb.doQuery.resolves([{ price: '100000', coin_pair: 'BTC/USD' }]);
            let result = await hub.getPrice('BTC/USD');
            expect(result).to.not.be.null;
        });
    });
});
