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

describe('XChainHub', function () {

    let mockDb, mockPool, mockConn, mockMariadb, XChainHub;

    beforeEach(function () {
        mockConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves() };
        mockPool = { getConnection: sinon.stub().resolves(mockConn), end: sinon.stub().resolves() };
        mockDb   = {
            doQuery:     sinon.stub().resolves([]),
            setParam:    sinon.stub().resolves(),
            setParams:   sinon.stub().resolves(0),
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
        it('collects nested config and batches via a single setParams call', async function () {
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

            expect(mockDb.setParams.calledOnce).to.be.true;
            expect(mockDb.setParam.called).to.be.false;
            let rows = mockDb.setParams.getCall(0).args[0];
            expect(rows).to.have.length(2);
            expect(rows).to.deep.include({ coin: 'BTC', network: 'mainnet', module: 'indexer', paramName: 'host', paramValue: 'idx-host' });
            expect(rows).to.deep.include({ coin: 'BTC', network: 'mainnet', module: 'indexer', paramName: 'port', paramValue: '3309' });
        });

        it('skips keys outside the combined allowlist, accepts known operational params', async function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;

            let config = {
                BTC: {
                    mainnet: {
                        indexer: {
                            host:          'localhost',
                            GAS_PRICE:     '0.00002',
                            invalid_param: 'should-be-skipped'
                        }
                    }
                }
            };

            await hub.applyConfig(config);
            let rows = mockDb.setParams.getCall(0).args[0];
            let paramNames = rows.map(r => r.paramName);
            expect(paramNames).to.include('host');
            expect(paramNames).to.include('GAS_PRICE');
            expect(paramNames).to.not.include('invalid_param');
        });

        it('stores GAS_PRICE as a flat scalar string', async function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;

            await hub.applyConfig({
                BTC: { mainnet: { 'xchain-indexer': { GAS_PRICE: '0.00002' } } }
            });

            let rows = mockDb.setParams.getCall(0).args[0];
            let row = rows.find(r => r.paramName === 'GAS_PRICE');
            expect(row).to.exist;
            expect(row.paramValue).to.equal('0.00002');
        });

        it('serializes GAS_SCHEDULE object to JSON string', async function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;

            let schedule = { ISSUE: 100000, ISSUE_SUBTOKEN: 50000 };
            await hub.applyConfig({
                BTC: { mainnet: { 'xchain-indexer': { GAS_SCHEDULE: schedule } } }
            });

            let rows = mockDb.setParams.getCall(0).args[0];
            let row = rows.find(r => r.paramName === 'GAS_SCHEDULE');
            expect(row).to.exist;
            expect(row.paramValue).to.equal(JSON.stringify(schedule));
        });

        it('stores GAS_SCHEDULE already serialized as a string unchanged', async function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;

            let serialized = '{"ISSUE":100000}';
            await hub.applyConfig({
                BTC: { mainnet: { 'xchain-indexer': { GAS_SCHEDULE: serialized } } }
            });

            let rows = mockDb.setParams.getCall(0).args[0];
            let row = rows.find(r => r.paramName === 'GAS_SCHEDULE');
            expect(row).to.exist;
            expect(row.paramValue).to.equal(serialized);
        });

        it('is a no-op (no DB write) when config has no recognized params', async function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;

            await hub.applyConfig({ BTC: { mainnet: { indexer: { invalid_param: 'x' } } } });
            expect(mockDb.setParams.called).to.be.false;
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

    // -----------------------------------------------------------------
    // Governance-driven capability config hot-reload
    // -----------------------------------------------------------------

    describe('capability governance hot-reload', function () {
        const CapabilityRegistry = require('../../src/CapabilityRegistry');
        let hub;

        beforeEach(function () {
            mockDb.getConnection = sinon.stub().resolves(mockConn);
            hub = new XChainHub('host', 3306, 'db', 'user', 'pass',
                { CAPABILITIES: { price: { MIN_STAKE: '10000' } } });
            hub.db = mockDb;
            hub.capabilityRegistry = new CapabilityRegistry(hub);
            hub.identity = { getPubkeyHex: () => 'aa'.repeat(33) };
        });

        it('_parseCapabilityParameter recognizes CAPABILITY_<CAP>_MIN_STAKE', function () {
            expect(hub._parseCapabilityParameter('CAPABILITY_PRICE_MIN_STAKE'))
                .to.deep.equal({ capability: 'price', parameterKey: 'MIN_STAKE' });
            expect(hub._parseCapabilityParameter('CAPABILITY_CROSS_CHAIN_MIN_STAKE'))
                .to.deep.equal({ capability: 'cross_chain', parameterKey: 'MIN_STAKE' });
        });

        it('_parseCapabilityParameter returns null for non-capability params', function () {
            expect(hub._parseCapabilityParameter('ORACLE_ROUND_INTERVAL')).to.be.null;
            expect(hub._parseCapabilityParameter('CAPABILITY_BOGUS_MIN_STAKE')).to.be.null;
            expect(hub._parseCapabilityParameter('')).to.be.null;
        });

        it('mutates capConfig in place on a finalized capability proposal', async function () {
            expect(hub.capabilityRegistry.getMinStake('price')).to.equal('10000');
            await hub._applyCapabilityGovernanceChange({
                parameter: 'CAPABILITY_PRICE_MIN_STAKE', oldValue: '10000', newValue: '25000'
            });
            expect(hub.capabilityRegistry.getMinStake('price')).to.equal('25000');
        });

        it('re-evaluates own qualification against the new threshold', async function () {
            let setQual = sinon.spy(hub.capabilityRegistry, 'setQualification');
            hub._latestStakeAmount = '15000';   // between old (10000) and new (25000) thresholds
            await hub._applyCapabilityGovernanceChange({
                parameter: 'CAPABILITY_PRICE_MIN_STAKE', oldValue: '10000', newValue: '25000'
            });
            // 15000 < 25000 → no longer qualified for price under the raised threshold
            let priceCall = setQual.getCalls().find(c => c.args[1] === 'price');
            expect(priceCall, 'setQualification called for price').to.exist;
            expect(priceCall.args[2]).to.equal(false);
        });

        it('ignores non-capability proposals', async function () {
            let setQual = sinon.spy(hub.capabilityRegistry, 'setQualification');
            await hub._applyCapabilityGovernanceChange({
                parameter: 'ORACLE_ROUND_INTERVAL', oldValue: '600000', newValue: '900000'
            });
            expect(setQual.called).to.be.false;
            expect(hub.capabilityRegistry.getMinStake('price')).to.equal('10000');
        });
    });
});
