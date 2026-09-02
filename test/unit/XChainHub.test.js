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

describe('XChainHub', function () {

    let mockDb, mockPool, mockConn, mockMariadb, XChainHub;

    // proxyquire busts the require cache and recompiles XChainHub's whole
    // dependency tree (~10s cold on the Parallels share), so do it ONCE here
    // rather than per-test. The Database stub reads `mockDb` at call time, so
    // each test still gets the fresh mock created in beforeEach.
    before(function () {
        this.timeout(30000);
        XChainHub = proxyquire('../../src/XChainHub', {
            './db': function () { return mockDb; }
        });
    });

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
            expect(hub.p2pConfig.P2P_PORT).to.equal(10001);
            // The constructor also seeds the canonical NODEPROOF parameters from the
            // pinned coin bundle, because startP2P builds FullNodeChallengeRound
            // before startCapabilities runs.
            expect(hub.p2pConfig.FULLNODE.REWARD_SHARE).to.equal('0');
            expect(Object.keys(hub.p2pConfig).sort()).to.deep.equal(['FULLNODE', 'P2P_PORT']);
        });

        it('handles null p2pConfig', function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            expect(hub.p2pConfig).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // start(): fail-closed consensus-pin verification at boot
    // -----------------------------------------------------------------

    describe('start() consensus-pin verification', function () {
        const coins = require('../../src/coins');

        it('fails closed on an armed-pin mismatch before any DB work', async function () {
            let verify = sinon.stub(coins, 'verifyConsensusPin')
                .throws(new Error('CONSENSUS CONFIG PIN MISMATCH for BTC/testnet'));
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', {});
            try {
                await hub.start();
                expect.fail('start() must not resolve on a pin mismatch');
            } catch (e) {
                expect(e.message).to.match(/PIN MISMATCH/);
            }
            expect(verify.called).to.equal(true);
            // Fail-closed: the drifted node never reached DB/serving work.
            expect(mockDb.createDatabase.called).to.equal(false);
        });

        it('verifies every network before DB/serving work begins', async function () {
            let verify = sinon.stub(coins, 'verifyConsensusPin').returns({ ok: true, skipped: false });
            // Sentinel on the LAST network proves all networks are checked
            // before start() proceeds to DB construction.
            verify.onCall(coins.NETWORKS.length - 1).throws(new Error('sentinel: last network reached'));
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', {});
            try { await hub.start(); } catch (e) { /* sentinel */ }
            expect(verify.callCount).to.equal(coins.NETWORKS.length);
            for (let i = 0; i < coins.NETWORKS.length; i++)
                expect(verify.getCall(i).args[0]).to.equal(coins.NETWORKS[i]);
            expect(mockDb.createDatabase.called).to.equal(false);
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

        // The explorer's self-synced checkpoint mirror needs BOTH halves of the block
        // xchain-node generates: self_sync says "you write this schema yourself" and
        // hub_url says where to read the feed. They ship together for exactly that
        // reason, so this path must not carry one and drop the other - an explorer
        // told to self-sync with no endpoint writes nothing, and its hub-mirrored
        // routes (price_snapshots, oracle_prices, state_checkpoints) serve a frozen
        // mirror or fail loud per request.
        it('keeps the hub endpoint that travels with a self-synced checkpoint block', async function () {
            let hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;

            await hub.applyConfig({
                BTC: {
                    regtest: {
                        checkpoint: {
                            db_host:   'mariadb',
                            db_port:   '3306',
                            name:      'XChain_BTC_Regtest_Indexer_HubMirror',
                            user:      'xchain_indexer',
                            pass:      'secret',
                            self_sync: 'true',
                            hub_url:   'http://xchain-node-xchain-hub:10000'
                        }
                    }
                }
            });

            let rows = mockDb.setParams.getCall(0).args[0];
            let hubUrl = rows.find(r => r.paramName === 'hub_url');
            expect(hubUrl).to.exist;
            expect(hubUrl.paramValue).to.equal('http://xchain-node-xchain-hub:10000');
            expect(hubUrl.module).to.equal('checkpoint');
            expect(rows.map(r => r.paramName)).to.include('self_sync');
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
    // Oracle price staleness (deepdive L-5)
    // -----------------------------------------------------------------

    describe('oracle price staleness (L-5)', function () {
        let hub;
        beforeEach(function () {
            hub = new XChainHub('host', 3306, 'db', 'user', 'pass', null);
            hub.db = mockDb;
        });

        const nowS = () => Math.floor(Date.now() / 1000);

        it('getPriceStatus flags a snapshot older than the max age as stale', async function () {
            // block_timestamp 2h old, default bound 1800s -> stale.
            mockDb.doQuery.resolves([{ price: '100000', coin_pair: 'BTC/USD', block_timestamp: nowS() - 7200 }]);
            let s = await hub.getPriceStatus('BTC/USD');
            expect(s.stale).to.equal(true);
            expect(s.fresh).to.equal(false);
            expect(s.missing).to.equal(false);
            expect(s.maxAgeSeconds).to.equal(1800);
            expect(s.ageSeconds).to.be.greaterThan(1800);
        });

        it('getPriceStatus keeps a fresh snapshot fresh', async function () {
            mockDb.doQuery.resolves([{ price: '100000', coin_pair: 'BTC/USD', block_timestamp: nowS() - 60 }]);
            let s = await hub.getPriceStatus('BTC/USD');
            expect(s.fresh).to.equal(true);
            expect(s.stale).to.equal(false);
        });

        it('getPriceStatus never ages out a snapshot with no usable block_timestamp', async function () {
            mockDb.doQuery.resolves([{ price: '100000', coin_pair: 'BTC/USD', block_timestamp: 0 }]);
            let s = await hub.getPriceStatus('BTC/USD');
            expect(s.fresh).to.equal(true);
            expect(s.ageSeconds).to.equal(null);
        });

        it('getPrice returns null for a stale snapshot (fails closed)', async function () {
            mockDb.doQuery.resolves([{ price: '100000', coin_pair: 'BTC/USD', block_timestamp: nowS() - 7200 }]);
            expect(await hub.getPrice('BTC/USD')).to.be.null;
        });

        it('getFeeQuote refuses to quote off a stale XCHAIN/USD price', async function () {
            // Both getPrice calls resolve the same stale row; XCHAIN/USD stale -> throw.
            mockDb.doQuery.resolves([{ price: '1.00', coin_pair: 'XCHAIN/USD', block_timestamp: nowS() - 7200 }]);
            let threw = false;
            try { await hub.getFeeQuote('ISSUE', 'BTC'); } catch (e) { threw = true; }
            expect(threw, 'stale oracle must fail the quote closed').to.equal(true);
        });

        // ORACLE_MAX_PRICE_AGE_SECONDS is consensus-pinned (coins/index.js consensusSubset)
        // and the indexer reads only the pinned bundle, so the hub's override is a regtest
        // bring-up seam: honored there, set-but-IGNORED and warned on every other network
        // (standalone's empty network included, which fails closed like the sibling seams).
        it('honours ORACLE_MAX_PRICE_AGE_SECONDS from p2pConfig on regtest (0 disables the bound)', async function () {
            let h = new XChainHub('host', 3306, 'db', 'user', 'pass',
                { HUB_NETWORK: 'regtest', ORACLE_MAX_PRICE_AGE_SECONDS: 0 });
            h.db = mockDb;
            mockDb.doQuery.resolves([{ price: '100000', coin_pair: 'BTC/USD', block_timestamp: nowS() - 999999 }]);
            let s = await h.getPriceStatus('BTC/USD');
            expect(s.stale).to.equal(false);
            expect(s.maxAgeSeconds).to.equal(0);
        });

        ['mainnet', 'testnet'].forEach(function (network) {
            it('ignores the p2pConfig override on ' + network + ' and warns once', async function () {
                const coins  = require('../../src/coins');
                const pinned = Number(coins.getCoinConfig('BTC', network).ORACLE_MAX_PRICE_AGE_SECONDS);
                let h = new XChainHub('host', 3306, 'db', 'user', 'pass',
                    { HUB_NETWORK: network, ORACLE_MAX_PRICE_AGE_SECONDS: 0 });
                h.db = mockDb;
                mockDb.doQuery.resolves([{ price: '100000', coin_pair: 'BTC/USD', block_timestamp: nowS() - 999999 }]);
                let logs = [];
                let stub = sinon.stub(console, 'log').callsFake(m => logs.push(String(m)));
                let s;
                try {
                    s = await h.getPriceStatus('BTC/USD');
                    await h.getPriceStatus('BTC/USD');
                } finally { stub.restore(); }
                expect(s.maxAgeSeconds).to.equal(pinned);
                expect(s.stale).to.equal(true);
                let warned = logs.filter(l => l.indexOf('ORACLE_MAX_PRICE_AGE_SECONDS') !== -1);
                expect(warned.length).to.equal(1);
                expect(warned[0]).to.contain('IGNORED on ' + network);
            });
        });

        it('ignores the override in standalone mode, where the network is unset', function () {
            const coins  = require('../../src/coins');
            const pinned = Number(coins.getCoinConfig('BTC', 'mainnet').ORACLE_MAX_PRICE_AGE_SECONDS);
            let h = new XChainHub('host', 3306, 'db', 'user', 'pass', { ORACLE_MAX_PRICE_AGE_SECONDS: 0 });
            let stub = sinon.stub(console, 'log');
            try { expect(h._oracleMaxAgeSeconds('BTC/USD')).to.equal(pinned); } finally { stub.restore(); }
        });

        it('sources the default bound from the consensus-pinned coin registry (no literal 1800)', function () {
            const coins = require('../../src/coins');
            // No env/p2pConfig override -> the bound is the registry value, not a literal.
            const pinned = Number(coins.getCoinConfig('BTC', 'mainnet').ORACLE_MAX_PRICE_AGE_SECONDS);
            expect(hub._oracleMaxAgeSeconds('BTC/USD')).to.equal(pinned);
            // A non-registry advisory pair (XCHAIN/USD) still resolves via the BTC fallback.
            expect(hub._oracleMaxAgeSeconds('XCHAIN/USD')).to.equal(pinned);
        });

        // Item #4479: getoraclesubmissions publishes this bound as the scalar
        // oracleMaxPriceAgeSeconds, so a cadence-derived health consumer cannot
        // call a row fresh that getprice already rejects. The RPC calls it with
        // NO pair, so that arity must resolve to the registry default rather
        // than null, or the consumer's clamp silently no-ops.
        it('resolves the representative scalar when called with no coin pair (#4479)', function () {
            const coins = require('../../src/coins');
            const pinned = Number(coins.getCoinConfig('BTC', 'mainnet').ORACLE_MAX_PRICE_AGE_SECONDS);
            expect(hub._oracleMaxAgeSeconds()).to.equal(pinned);
            expect(hub._oracleMaxAgeSeconds()).to.be.greaterThan(0);
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

        it('does NOT apply a finalized CAPABILITY_*_MIN_STAKE change (pinned pre-launch #4352)', async function () {
            expect(hub.capabilityRegistry.getMinStake('price')).to.equal('10000');
            await hub._applyCapabilityGovernanceChange({
                parameter: 'CAPABILITY_PRICE_MIN_STAKE', oldValue: '10000', newValue: '25000',
                activationBlock: 1000
            });
            // The pin (#4352) keeps getMinStake pinned to the genesis value for every block,
            // so it can never drift from the indexer's frozen configs/<COIN>.js constant.
            expect(hub.capabilityRegistry.getMinStake('price', 999)).to.equal('10000');
            expect(hub.capabilityRegistry.getMinStake('price', 1000)).to.equal('10000');
            expect(hub.capabilityRegistry.getMinStake('price')).to.equal('10000');
        });

        it('does NOT apply a MIN_STAKE change with no activation block either', async function () {
            await hub._applyCapabilityGovernanceChange({
                parameter: 'CAPABILITY_PRICE_MIN_STAKE', oldValue: '10000', newValue: '25000'
            });
            expect(hub.capabilityRegistry.getMinStake('price', 1000)).to.equal('10000');
        });

        it('does not re-qualify on a pinned MIN_STAKE change (no apply, no setQualification)', async function () {
            let setQual = sinon.spy(hub.capabilityRegistry, 'setQualification');
            hub._latestStakeAmount = '15000';
            await hub._applyCapabilityGovernanceChange({
                parameter: 'CAPABILITY_PRICE_MIN_STAKE', oldValue: '10000', newValue: '25000',
                activationBlock: 1000
            });
            // The pin returns before flush + refreshOwnQualification, so price is not re-evaluated
            // and the threshold is unchanged.
            let priceCall = setQual.getCalls().find(c => c.args[1] === 'price');
            expect(priceCall, 'no setQualification for a pinned MIN_STAKE change').to.equal(undefined);
            expect(hub.capabilityRegistry.getMinStake('price')).to.equal('10000');
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

    // -----------------------------------------------------------------
    // subsystem getters
    // -----------------------------------------------------------------

    describe('subsystem getters', function () {
        let hub;
        beforeEach(function () { hub = new XChainHub('h', 1, 'd', 'u', 'p', null); });

        it('return the wired-in subsystem instances', function () {
            hub.peerManager = { a: 1 }; hub.consensus = { b: 2 }; hub.identity = { c: 3 };
            hub.oracle = { d: 4 }; hub.crossChain = { e: 5 };
            hub.crossChainDex = { f: 6 };
            expect(hub.getPeerManager()).to.equal(hub.peerManager);
            expect(hub.getConsensus()).to.equal(hub.consensus);
            expect(hub.getIdentity()).to.equal(hub.identity);
            expect(hub.getOracle()).to.equal(hub.oracle);
            expect(hub.getCrossChain()).to.equal(hub.crossChain);
            expect(hub.getCrossChainDex()).to.equal(hub.crossChainDex);
        });
    });

    // -----------------------------------------------------------------
    // thin delegators (inactive vs active subsystem)
    // -----------------------------------------------------------------

    describe('subsystem delegators', function () {
        let hub;
        beforeEach(function () { hub = new XChainHub('h', 1, 'd', 'u', 'p', null); });

        it('reportReorg throws when the reorg handler is inactive, delegates when active', async function () {
            try { await hub.reportReorg('BTC', 5, 1); expect.fail('should throw'); }
            catch (e) { expect(e.message).to.include('Reorg handler not active'); }

            hub.reorgHandler = { reportReorg: sinon.stub().resolves('ok'), getReorgHistory: sinon.stub().resolves([1]) };
            expect(await hub.reportReorg('BTC', 5, 1)).to.equal('ok');
            expect(await hub.getReorgHistory(10)).to.deep.equal([1]);
        });

        it('getReorgHistory returns [] when inactive', async function () {
            expect(await hub.getReorgHistory()).to.deep.equal([]);
        });

        it('governance delegators: propose/vote throw inactive; getProposals/getProposal default', async function () {
            try { await hub.propose('P', '1', '2'); expect.fail('throw'); } catch (e) { expect(e.message).to.include('Governance not active'); }
            try { await hub.vote('id', 'approve'); expect.fail('throw'); } catch (e) { expect(e.message).to.include('Governance not active'); }
            expect(await hub.getProposals()).to.deep.equal([]);
            expect(await hub.getProposal('x')).to.be.null;

            hub.governance = {
                propose: sinon.stub().resolves('p'), vote: sinon.stub().resolves('v'),
                getProposals: sinon.stub().resolves(['list']), getProposal: sinon.stub().resolves({ id: 1 })
            };
            expect(await hub.propose('P', '1', '2', 'r')).to.equal('p');
            expect(await hub.vote('id', 'approve')).to.equal('v');
            expect(await hub.getProposals('voting')).to.deep.equal(['list']);
            expect(await hub.getProposal('x')).to.deep.equal({ id: 1 });
        });

        it('cross-chain + swap delegators: throw/default inactive, delegate active', async function () {
            try { await hub.requestAttestation('BTC', 1, 'LTC'); expect.fail('throw'); } catch (e) { expect(e.message).to.include('Cross-chain engine not active'); }
            try { await hub.initiateSwap('BTC', 1, 'LTC', 2); expect.fail('throw'); } catch (e) { expect(e.message).to.include('SWAP tracker not active'); }
            expect(await hub.getSwap('BTC', 1)).to.be.null;
            expect(await hub.getSwaps()).to.deep.equal([]);

            hub.crossChain = { requestAttestation: sinon.stub().resolves('att') };
            hub.swapTracker = {
                initiateSwap: sinon.stub().resolves(), getSwap: sinon.stub().resolves({ s: 1 }),
                getSwaps: sinon.stub().resolves([{ s: 2 }])
            };
            expect(await hub.requestAttestation('BTC', 1, 'LTC')).to.equal('att');
            expect(await hub.initiateSwap('BTC', 1, 'LTC', 2)).to.equal(true);
            expect(await hub.getSwap('BTC', 1)).to.deep.equal({ s: 1 });
            expect(await hub.getSwaps('open', 5)).to.deep.equal([{ s: 2 }]);
        });

        it('addParametersFromJson routes through consensus when active, else applyConfig', async function () {
            hub.consensus = { propose: sinon.stub().resolves(true) };
            expect(await hub.addParametersFromJson({ BTC: { X: '1' } })).to.equal(true);
            expect(hub.consensus.propose.calledOnce).to.be.true;

            let hub2 = new XChainHub('h', 1, 'd', 'u', 'p', null);
            hub2.db = mockDb;
            let apply = sinon.stub(hub2, 'applyConfig').resolves();
            expect(await hub2.addParametersFromJson({ BTC: { X: '1' } })).to.equal(true);
            expect(apply.calledOnce).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // DB-backed query wrappers
    // -----------------------------------------------------------------

    describe('DB query wrappers', function () {
        let hub;
        beforeEach(function () {
            hub = new XChainHub('h', 1, 'd', 'u', 'p', null);
            hub.db = mockDb;
        });

        it('getConfigWatermark / getLastSeq delegate to the DB layer', async function () {
            mockDb.getConfigWatermark = sinon.stub().resolves(1700000000);
            mockDb.getLastSeq = sinon.stub().resolves(42);
            expect(await hub.getConfigWatermark()).to.equal(1700000000);
            expect(await hub.getLastSeq()).to.equal(42);
        });

        it('getPriceSnapshots and getPrice issue the expected queries', async function () {
            mockDb.doQuery.resolves([{ coin_pair: 'BTC/USD' }]);
            await hub.getPriceSnapshots(5);
            expect(mockDb.doQuery.getCall(0).args[1]).to.deep.equal([5]);
            expect(mockDb.doQuery.getCall(0).args[0]).to.include('price_snapshots');
            // Default stays finalized-only (fee/price consumers unchanged);
            // status='all' additionally returns skipped/disputed rows so
            // health/monitoring consumers can see stall/fork states (#180 seam).
            expect(mockDb.doQuery.getCall(0).args[0]).to.include("status = 'finalized'");
            mockDb.doQuery.resetHistory();
            mockDb.doQuery.resolves([{ coin_pair: 'BTC/USD' }]);
            await hub.getPriceSnapshots(5, 'all');
            expect(mockDb.doQuery.getCall(0).args[0]).to.include('price_snapshots');
            expect(mockDb.doQuery.getCall(0).args[0]).to.not.include("status = 'finalized'");
            expect(mockDb.doQuery.getCall(0).args[1]).to.deep.equal([5]);

            mockDb.doQuery.resetHistory();
            mockDb.doQuery.resolves([{ coin_pair: 'BTC/USD' }]);
            expect(await hub.getPrice('BTC/USD')).to.deep.equal({ coin_pair: 'BTC/USD' });
            mockDb.doQuery.resetHistory();
            mockDb.doQuery.resolves([]);
            expect(await hub.getPrice('NONE/USD')).to.be.null;
        });

        it('registerValidator validates pubkey + addr, then reloads', async function () {
            try { await hub.registerValidator('bad', 'ws://v:1'); expect.fail('throw'); }
            catch (e) { expect(e.message).to.include('Invalid signing pubkey'); }
            try { await hub.registerValidator('ab'.repeat(32), ''); expect.fail('throw'); }
            catch (e) { expect(e.message).to.include('addr is required'); }

            mockDb.doQuery.resolves([]);
            expect(await hub.registerValidator('ab'.repeat(32), 'ws://v:1')).to.equal(true);
            let insert = mockDb.doQuery.getCalls().find(c => /INSERT INTO validators/.test(c.args[0]));
            expect(insert).to.exist;
        });

        it('syncValidators rejects non-arrays, skips invalid entries, inserts valid ones', async function () {
            try { await hub.syncValidators('nope'); expect.fail('throw'); }
            catch (e) { expect(e.message).to.include('must be an array'); }

            mockDb.doQuery.resolves([]);
            await hub.syncValidators([
                { signing_pubkey: 'cd'.repeat(32), addr: 'ws://v:1' },
                { signing_pubkey: 'bad', addr: 'ws://v:2' },   // skipped (bad pubkey)
                { signing_pubkey: 'ef'.repeat(32) }             // skipped (no addr)
            ]);
            let inserts = mockDb.doQuery.getCalls().filter(c => /INSERT INTO validators/.test(c.args[0]));
            expect(inserts).to.have.length(1);
        });

        it('getValidators queries active validators', async function () {
            mockDb.doQuery.resolves([{ addr: 'a' }]);
            await hub.getValidators();
            expect(mockDb.doQuery.getCall(0).args[0]).to.include("status = 'active'");
        });

        // the documented getvalidators response carries `chains`
        // (components/hub/api.md), and the explorer folds addr/chains/status onto
        // its on-chain /validators table. Dropping the column from the SELECT
        // blanks the served chains everywhere downstream.
        it('getValidators selects the registry addr, chains and status columns', async function () {
            mockDb.doQuery.resolves([{ addr: 'a' }]);
            await hub.getValidators();
            let query = mockDb.doQuery.getCall(0).args[0];
            for (const col of ['signing_pubkey', 'addr', 'chains', 'status'])
                expect(query).to.include(col);
        });

        it('getValidatorStatus returns null when unknown, full status when known', async function () {
            mockDb.doQuery.resolves([]);
            expect(await hub.getValidatorStatus('ab'.repeat(32))).to.be.null;

            mockDb.doQuery.resolves([{ signing_pubkey: 'ab'.repeat(32) }]);
            hub.rewardTracker = { getUnclaimedRewards: sinon.stub().resolves('5'), getRewardHistory: sinon.stub().resolves([{ r: 1 }]) };
            hub.slashDetector = { getProposalsForValidator: sinon.stub().resolves([{ s: 1 }]) };
            let st = await hub.getValidatorStatus('ab'.repeat(32));
            expect(st.unclaimedRewards).to.equal('5');
            expect(st.recentRewards).to.deep.equal([{ r: 1 }]);
            expect(st.slashProposals).to.deep.equal([{ s: 1 }]);
        });

        it('getValidatorStatus defaults rewards/slashes when those subsystems are absent', async function () {
            mockDb.doQuery.resolves([{ signing_pubkey: 'ab'.repeat(32) }]);
            let st = await hub.getValidatorStatus('ab'.repeat(32));
            expect(st.unclaimedRewards).to.equal('0');
            expect(st.recentRewards).to.deep.equal([]);
            expect(st.slashProposals).to.deep.equal([]);
        });
    });

    // -----------------------------------------------------------------
    // _resolveBtcLatestBlock: pushed-tip freshness bound (#1795)
    // -----------------------------------------------------------------

    describe('_resolveBtcLatestBlock pushed-tip freshness', function () {
        let hub;
        beforeEach(function () {
            hub = new XChainHub('h', 1, 'd', 'u', 'p', null);
            hub.db = mockDb;
            sinon.stub(hub, '_resolveBtcNetwork').resolves('regtest');
        });

        it('returns the pushed tip when its block_time is fresh', async function () {
            let now = Math.floor(Date.now() / 1000);
            mockDb.getChainTip = sinon.stub().resolves({ blockHeight: 800000, blockTime: now - 60 });
            let direct = sinon.stub(hub, '_resolveBtcIndexerUrl').resolves(null);
            expect(await hub._resolveBtcLatestBlock()).to.equal(800000);
            // Fresh tip short-circuits path 1; the direct path is never consulted.
            expect(direct.called).to.equal(false);
        });

        it('falls through to the direct path when the pushed tip is stale', async function () {
            let now = Math.floor(Date.now() / 1000);
            // 2 hours old, well past the default 2x round-interval (1200s) bound.
            mockDb.getChainTip = sinon.stub().resolves({ blockHeight: 800000, blockTime: now - 7200 });
            sinon.stub(hub, '_resolveBtcIndexerUrl').resolves(null);  // direct path unavailable → null
            expect(await hub._resolveBtcLatestBlock()).to.equal(null);
        });

        it('falls through when the pushed tip has no block_time (unverifiable)', async function () {
            mockDb.getChainTip = sinon.stub().resolves({ blockHeight: 800000, blockTime: 0 });
            sinon.stub(hub, '_resolveBtcIndexerUrl').resolves(null);
            expect(await hub._resolveBtcLatestBlock()).to.equal(null);
        });
    });

    // -----------------------------------------------------------------
    // transport signer-set self-report
    // -----------------------------------------------------------------
    //
    // The hub knows its own pubkey and resolves the effective signer set, so
    // it reports its own membership locally; without this the only evidence of
    // being outside the set is a reject line in the logs of the PEERS dropping
    // it, which this hub's operator cannot read.

    describe('own-pubkey signer-set self-report', function () {

        const OWN   = 'ab'.repeat(32);
        const OTHER = 'cd'.repeat(32);

        let hub, warnings, logs;

        function refreshWith(pubkeys) {
            hub.capabilitySnapshot = {
                getActiveValidatorSnapshot: sinon.stub().resolves({ validators: pubkeys.map(pk => ({ pubkey: pk })) })
            };
            return hub._refreshTransportSignerSet();
        }

        beforeEach(function () {
            hub = new XChainHub('h', 1, 'd', 'u', 'p', { HUB_NETWORK: 'testnet' });
            hub.db = mockDb;
            hub.peerManager = { setEffectiveSignerSet: sinon.stub() };
            hub.identity    = { getPubkeyHex: () => OWN };
            hub._resolveBtcLatestBlock = async () => 100;
            warnings = [];
            logs     = [];
            sinon.stub(console, 'warn').callsFake((m) => warnings.push(String(m)));
            sinon.stub(console, 'log').callsFake((m) => logs.push(String(m)));
        });

        it('warns once that peers will reject this hub while its pubkey is out of the set', async function () {
            await refreshWith([OTHER]);
            let line = warnings.find(l => l.includes('NOT in the chain-effective signer set'));
            expect(line, 'the out-of-set state is reported locally').to.be.a('string');
            expect(line).to.include('until a STAKE for it confirms and activates');
            expect(line, 'the operator can match the key').to.include(OWN);

            // A refresh loop must not turn one standing condition into a log flood.
            await refreshWith([OTHER]);
            expect(warnings.filter(l => l.includes('NOT in the chain-effective signer set'))).to.have.lengthOf(1);
        });

        it('logs once when the pubkey is admitted, and stays quiet after', async function () {
            await refreshWith([OTHER]);
            await refreshWith([OTHER, OWN]);
            await refreshWith([OTHER, OWN]);

            let admitted = logs.filter(l => l.includes('is now in the chain-effective signer set'));
            expect(admitted, 'one line on the transition, not one per refresh').to.have.lengthOf(1);
            expect(admitted[0]).to.include(OWN);
        });

        it('says nothing on a hub with no signing identity', async function () {
            hub.identity = null;
            await refreshWith([OTHER]);
            expect(warnings.filter(l => l.includes('signer set'))).to.have.lengthOf(0);
        });
    });

    // -----------------------------------------------------------------
    // validator-set loaders
    // -----------------------------------------------------------------

    describe('validator-set loaders', function () {
        let hub;
        beforeEach(function () {
            hub = new XChainHub('h', 1, 'd', 'u', 'p', null);
            hub.db = mockDb;
        });

        it('_loadValidatorPubkeys is a no-op without a peer manager', async function () {
            await hub._loadValidatorPubkeys(); // no peerManager → returns
            expect(mockDb.doQuery.called).to.be.false;
        });

        it('_loadValidatorPubkeys builds the addr→pubkey map on the peer manager', async function () {
            hub.peerManager = { setValidatorPubkeys: sinon.stub() };
            mockDb.doQuery.resolves([{ addr: 'ws://v:1', signing_pubkey: 'pk1' }]);
            await hub._loadValidatorPubkeys();
            let map = hub.peerManager.setValidatorPubkeys.getCall(0).args[0];
            expect(map.get('ws://v:1')).to.equal('pk1');
        });

        it('_loadValidatorPubkeys propagates DB errors and leaves the registry unset (fail closed)', async function () {
            hub.peerManager = { setValidatorPubkeys: sinon.stub() };
            mockDb.doQuery.rejects(new Error('db down'));
            let threw = false;
            try { await hub._loadValidatorPubkeys(); } catch (e) { threw = true; }
            // Must propagate so startP2P never opens the listener with a null
            // registry (a null registry makes _verifySignature accept any
            // signed envelope; see PeerManager).
            expect(threw).to.be.true;
            expect(hub.peerManager.setValidatorPubkeys.called).to.be.false;
        });

        it('_loadValidatorSet maps rows and returns [] on error', async function () {
            mockDb.doQuery.resolves([{ signing_pubkey: 'pk1', addr: 'a1' }]);
            expect(await hub._loadValidatorSet()).to.deep.equal([{ pubkey: 'pk1', addr: 'a1' }]);
            mockDb.doQuery.rejects(new Error('db down'));
            expect(await hub._loadValidatorSet()).to.deep.equal([]);
        });

        it('_loadChainPairValidators filters validators by supported chains', async function () {
            mockDb.doQuery.resolves([
                { signing_pubkey: 'pk1', addr: 'a1', chains: null },             // all chains
                { signing_pubkey: 'pk2', addr: 'a2', chains: 'BTC,LTC' },        // BTC-LTC only
                { signing_pubkey: 'pk3', addr: 'a3', chains: 'DOGE' }            // none of the pairs
            ]);
            let map = await hub._loadChainPairValidators();
            expect(map.get('BTC-LTC').map(v => v.pubkey)).to.have.members(['pk1', 'pk2']);
            expect(map.get('BTC-DOGE').map(v => v.pubkey)).to.deep.equal(['pk1']);
        });

        it('_loadChainPairValidators returns an empty map on DB error', async function () {
            mockDb.doQuery.rejects(new Error('db down'));
            let map = await hub._loadChainPairValidators();
            expect(map.size).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // pure helpers + close()
    // -----------------------------------------------------------------

    describe('pure helpers + close()', function () {
        let hub;
        beforeEach(function () { hub = new XChainHub('h', 1, 'd', 'u', 'p', null); });

        it('_btcIndexerHeaders includes x-api-key only when configured', function () {
            delete process.env.BTC_INDEXER_API_KEY;
            expect(hub._btcIndexerHeaders()).to.not.have.property('x-api-key');
            process.env.BTC_INDEXER_API_KEY = 'fixture';
            expect(hub._btcIndexerHeaders()['x-api-key']).to.equal('fixture');
            delete process.env.BTC_INDEXER_API_KEY;
        });

        it('_resolveBtcIndexerUrl prefers BTC_INDEXER_API_URL, falls back to BTC_INDEXER_URL, then configs', async function () {
            delete process.env.BTC_INDEXER_API_URL;
            delete process.env.BTC_INDEXER_URL;
            hub.db = mockDb;
            mockDb.getAllConfigs.resolves({ bitcoin: { regtest: { 'xchain-indexer': { host: 'cfg-host', port: 4001 } } } });
            expect(await hub._resolveBtcIndexerUrl()).to.equal('http://cfg-host:4001');

            // The footgun: a hub configured with only BTC_INDEXER_URL silently
            // fell to seed-local capability snapshots (quorum-0 self-sign).
            process.env.BTC_INDEXER_URL = 'http://alias:4000';
            expect(await hub._resolveBtcIndexerUrl()).to.equal('http://alias:4000');

            process.env.BTC_INDEXER_API_URL = 'http://canonical:4000';
            expect(await hub._resolveBtcIndexerUrl()).to.equal('http://canonical:4000');

            delete process.env.BTC_INDEXER_API_URL;
            delete process.env.BTC_INDEXER_URL;
        });

        it('_parseDecimalParts parses decimals and rejects junk', function () {
            expect(hub._parseDecimalParts('12.50')).to.deep.equal({ neg: false, int: '12', frac: '50' });
            expect(hub._parseDecimalParts('-3')).to.deep.equal({ neg: true, int: '3', frac: '' });
            expect(hub._parseDecimalParts('+.5')).to.deep.equal({ neg: false, int: '0', frac: '5' });
            expect(hub._parseDecimalParts('-0.0')).to.deep.equal({ neg: false, int: '0', frac: '0' }); // negative-zero normalised
            expect(hub._parseDecimalParts('abc')).to.be.null;
            expect(hub._parseDecimalParts(null)).to.be.null;
        });

        it('_compareDecimal orders values exactly (incl. signs and scale)', function () {
            expect(hub._compareDecimal('10', '10.00')).to.equal(0);
            expect(hub._compareDecimal('1.5', '1.50001')).to.equal(-1);
            expect(hub._compareDecimal('2', '1.9')).to.equal(1);
            expect(hub._compareDecimal('-5', '3')).to.equal(-1);   // different signs
            expect(hub._compareDecimal('-2', '-9')).to.equal(1);   // both negative
            expect(hub._compareDecimal('abc', '1')).to.equal(0);   // unparseable → 0
        });

        it('close() clears timers and stops every active subsystem', async function () {
            hub._capabilityRecheckTimer = setInterval(() => {}, 60000);
            hub._stakePollTimer = setInterval(() => {}, 60000);
            hub.governance      = { stop: sinon.stub().resolves() };
            hub.reorgHandler    = { stop: sinon.stub().resolves() };
            hub.crossChain      = { stop: sinon.stub().resolves() };
            hub.oracle          = { stop: sinon.stub().resolves() };
            hub.oracleConsensus = { stop: sinon.stub().resolves() };
            hub.consensus       = { stop: sinon.stub().resolves() };
            hub.peerManager     = { stop: sinon.stub().resolves() };
            hub.db              = { close: sinon.stub().resolves() };

            await hub.close();

            expect(hub._capabilityRecheckTimer).to.be.null;
            expect(hub._stakePollTimer).to.be.null;
            expect(hub.governance.stop.calledOnce).to.be.true;
            expect(hub.peerManager.stop.calledOnce).to.be.true;
            expect(hub.db.close.calledOnce).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // startAttestation(): operator signer wiring
    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // round:finalized validator-set freshness (SLASH-STATIC-VSET-1)
    // -----------------------------------------------------------------

    describe('round:finalized validator-set freshness (SLASH-STATIC-VSET-1)', function () {

        function makeOracleStubs() {
            const handlers = {};
            const oracleConsensus = {
                setValidatorSet: sinon.stub(),
                on:    (evt, fn) => { handlers[evt] = fn; },
                start: sinon.stub().resolves()
            };
            const slashDetector = { checkRound: sinon.stub().resolves() };
            return {
                handlers, oracleConsensus, slashDetector,
                modules: {
                    './db':                  function () { return mockDb; },
                    './OracleConsensus.js':  function () { return oracleConsensus; },
                    './OracleRound.js':      function () { return { setConsensus: sinon.stub(), start: sinon.stub().resolves() }; },
                    './RewardTracker.js':    function () { return { distributeRewards: sinon.stub().resolves() }; },
                    './SlashDetector.js':    function () { return slashDetector; },
                    // Stubbed here too: this describe block is about validator-set
                    // freshness, not the signing round, and the fixture peerManager
                    // below has no .on(), which the real OracleBatchSigner.start()
                    // would call.
                    './OracleBatchSigner.js': function () { return { start: sinon.stub().resolves(), stop: sinon.stub().resolves(), getStats: sinon.stub().returns({}) }; },
                    './OraclePublisher.js':  function () { return { start: sinon.stub().resolves() }; },
                    './lib/signer-loader.js': { loadSignerHooks: () => null, applySignerHooks: () => {} }
                }
            };
        }

        function finalizedEvent(round) {
            return { round, submissions: new Map(), prices: [], participants: [], btcBlockHeight: 1 };
        }

        it('re-loads the validator set per finalized round so rotated-in validators are slashable', async function () {
            this.timeout(30000);
            const stubs = makeOracleStubs();
            const Hub = proxyquire('../../src/XChainHub', stubs.modules);
            let hub = new Hub('h', 1, 'd', 'u', 'p', { P2P_PORT: 10001 });
            hub.peerManager = { validatorPubkeys: new Map() };

            const stale = [{ pubkey: 'pk1', addr: 'a1' }];
            const fresh = [{ pubkey: 'pk1', addr: 'a1' }, { pubkey: 'pk2', addr: 'a2' }];
            const load = sinon.stub(hub, '_loadValidatorSet');
            load.resolves(fresh);          // per-round reloads see the current set
            load.onFirstCall().resolves(stale); // startOracle() sees the boot-time set

            await hub.startOracle();
            await stubs.handlers['round:finalized'](finalizedEvent(7));

            // Slashing must be evaluated against the freshly loaded set, not
            // the set captured at startOracle() time.
            expect(stubs.slashDetector.checkRound.calledOnce).to.be.true;
            expect(stubs.slashDetector.checkRound.getCall(0).args[4]).to.deep.equal(fresh);
        });

        it('falls back to the last-known-good set when the per-round reload fails', async function () {
            this.timeout(30000);
            const stubs = makeOracleStubs();
            const Hub = proxyquire('../../src/XChainHub', stubs.modules);
            let hub = new Hub('h', 1, 'd', 'u', 'p', { P2P_PORT: 10001 });
            hub.peerManager = { validatorPubkeys: new Map() };

            const fresh = [{ pubkey: 'pk1', addr: 'a1' }, { pubkey: 'pk2', addr: 'a2' }];
            const load = sinon.stub(hub, '_loadValidatorSet');
            load.onFirstCall().resolves([{ pubkey: 'pk1', addr: 'a1' }]); // startOracle()
            load.onSecondCall().resolves(fresh);                          // round 1 reload
            load.onThirdCall().resolves([]);                              // round 2 reload fails (DB error path returns [])

            await hub.startOracle();
            await stubs.handlers['round:finalized'](finalizedEvent(1));
            await stubs.handlers['round:finalized'](finalizedEvent(2));

            expect(stubs.slashDetector.checkRound.callCount).to.equal(2);
            expect(stubs.slashDetector.checkRound.getCall(1).args[4]).to.deep.equal(fresh);
        });
    });

    // -----------------------------------------------------------------
    // startOracle() constructs/starts OracleBatchSigner; close() stops it
    // -----------------------------------------------------------------

    describe('startOracle() wires OracleBatchSigner', function () {

        // Every OTHER oracle dependency is stubbed so this suite exercises the
        // hub's wiring, not their internals. OracleBatchSigner itself is
        // deliberately left un-stubbed (the real './OracleBatchSigner.js' is
        // required): the row this covers is "the hub constructs the REAL class",
        // so a fake standing in for it would prove nothing.
        function batchSignerDeps() {
            return {
                './db':                 function () { return mockDb; },
                './OracleConsensus.js': function () { return { setValidatorSet: sinon.stub(), on: sinon.stub(), start: sinon.stub().resolves(), stop: sinon.stub().resolves() }; },
                './OracleRound.js':     function () { return { setConsensus: sinon.stub(), start: sinon.stub().resolves(), stop: sinon.stub().resolves() }; },
                './RewardTracker.js':   function () { return { distributeRewards: sinon.stub().resolves() }; },
                './SlashDetector.js':   function () { return { checkRound: sinon.stub().resolves() }; },
                './OraclePublisher.js': function () { return { start: sinon.stub().resolves() }; },
                './lib/signer-loader.js': { loadSignerHooks: () => null, applySignerHooks: () => {} }
            };
        }

        it('constructs, starts, subscribes and cleanly stops OracleBatchSigner on a hub running oracle consensus', async function () {
            this.timeout(30000);
            const Hub = proxyquire('../../src/XChainHub', batchSignerDeps());
            let hub = new Hub('h', 1, 'd', 'u', 'p', { P2P_PORT: 10001 });
            sinon.stub(hub, '_loadValidatorSet').resolves([]);

            const handlers = new Map();
            hub.peerManager = {
                on:             sinon.stub().callsFake((evt, fn) => handlers.set(evt, fn)),
                removeListener: sinon.stub(),
                stop:           sinon.stub().resolves(),
                validatorPubkeys: new Map()
            };

            await hub.startOracle();

            // Constructed and exposed on the hub the same way its siblings
            // (oraclePublisher, stateAnchorPublisher) are: a plain property, so
            // the publisher can reach hub.oracleBatchSigner.collectBatchSignatures().
            expect(hub.oracleBatchSigner).to.be.an('object');
            expect(hub.oracleBatchSigner.getStats()).to.have.property('batchSignTimeouts', 0);

            // Started: subscribed to the peer message bus exactly once.
            expect(hub.peerManager.on.calledOnceWith('message')).to.be.true;
            let messageHandler = handlers.get('message');
            expect(messageHandler).to.be.a('function');

            hub.db = { close: sinon.stub().resolves() };
            await hub.close();

            // Stopped cleanly: the SAME handler instance is unsubscribed.
            expect(hub.peerManager.removeListener.calledOnceWith('message', messageHandler)).to.be.true;
        });

        it('starts and stops with no OracleBatchSigner on a hub not running oracle consensus', async function () {
            const Hub = proxyquire('../../src/XChainHub', batchSignerDeps());
            let hub = new Hub('h', 1, 'd', 'u', 'p', null);   // no p2pConfig -> no peerManager

            await hub.startOracle();
            expect(hub.oracleBatchSigner).to.be.null;

            hub.db = { close: sinon.stub().resolves() };
            await hub.close();   // must not throw with no signer ever started
            expect(hub.oracleBatchSigner).to.be.null;
        });
    });

    describe('startAttestation() signer wiring', function () {

        function makeAttestationStubs() {
            const publisher = {
                start:             sinon.stub().resolves(),
                setWalletSignHook: sinon.stub(),
                setBroadcastHook:  sinon.stub()
            };
            return {
                publisher,
                modules: {
                    './ProviderRegistry.js':       function () { return { load: sinon.stub().resolves(), loadGovernanceHistory: sinon.stub().resolves(), listProviderIds: sinon.stub().returns([]) }; },
                    './AttestationConsensus.js':   function () { return { start: sinon.stub().resolves(), on: sinon.stub() }; },
                    './AttestationRound.js':       function () { return { start: sinon.stub().resolves(), setConsensus: sinon.stub() }; },
                    './AttestationPublisher.js':   function () { return publisher; },
                    './AttestationSpotChecker.js': function () { return { start: sinon.stub().resolves() }; }
                }
            };
        }

        it('applies HUB_SIGNER_MODULE hooks to the attestation publisher', async function () {
            this.timeout(30000);
            const realLoader = require('../../src/lib/signer-loader.js');
            const fakeHooks = {
                source:       'fake-signer',
                walletSignFn: sinon.stub(),
                broadcastFn:  sinon.stub(),
                getBalanceFn: null
            };
            const stubs = makeAttestationStubs();
            const HubWithSigner = proxyquire('../../src/XChainHub', Object.assign({
                './db': function () { return mockDb; },
                './lib/signer-loader.js': {
                    loadSignerHooks:  () => fakeHooks,
                    applySignerHooks: realLoader.applySignerHooks
                }
            }, stubs.modules));

            let hub = new HubWithSigner('host', 3306, 'db', 'user', 'pass', { P2P_PORT: 10001, HUB_NETWORK: 'regtest' });
            hub.peerManager = { on: () => {} }; // startAttestation now starts FullNodeChallengeRound, which registers a peerManager 'message' handler
            await hub.startAttestation();

            expect(stubs.publisher.setWalletSignHook.calledOnceWith(fakeHooks.walletSignFn)).to.be.true;
            expect(stubs.publisher.setBroadcastHook.calledOnceWith(fakeHooks.broadcastFn)).to.be.true;
            expect(stubs.publisher.start.calledOnce).to.be.true;
        });

        it('starts cleanly with no signer configured (hooks null)', async function () {
            this.timeout(30000);
            const stubs = makeAttestationStubs();
            const HubNoSigner = proxyquire('../../src/XChainHub', Object.assign({
                './db': function () { return mockDb; },
                './lib/signer-loader.js': {
                    loadSignerHooks:  () => null,
                    applySignerHooks: () => { throw new Error('must not be called'); }
                }
            }, stubs.modules));

            let hub = new HubNoSigner('host', 3306, 'db', 'user', 'pass', { P2P_PORT: 10001, HUB_NETWORK: 'regtest' });
            hub.peerManager = { on: () => {} }; // startAttestation now starts FullNodeChallengeRound, which registers a peerManager 'message' handler
            await hub.startAttestation();

            expect(stubs.publisher.setWalletSignHook.called).to.be.false;
            expect(stubs.publisher.start.calledOnce).to.be.true;
        });
    });
});
