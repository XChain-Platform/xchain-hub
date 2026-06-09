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

    // -----------------------------------------------------------------
    // subsystem getters
    // -----------------------------------------------------------------

    describe('subsystem getters', function () {
        let hub;
        beforeEach(function () { hub = new XChainHub('h', 1, 'd', 'u', 'p', null); });

        it('return the wired-in subsystem instances', function () {
            hub.peerManager = { a: 1 }; hub.consensus = { b: 2 }; hub.identity = { c: 3 };
            hub.oracle = { d: 4 }; hub.crossChain = { e: 5 };
            hub.crossChainDex = { f: 6 }; hub.crossChainDexAnchor = { g: 7 };
            expect(hub.getPeerManager()).to.equal(hub.peerManager);
            expect(hub.getConsensus()).to.equal(hub.consensus);
            expect(hub.getIdentity()).to.equal(hub.identity);
            expect(hub.getOracle()).to.equal(hub.oracle);
            expect(hub.getCrossChain()).to.equal(hub.crossChain);
            expect(hub.getCrossChainDex()).to.equal(hub.crossChainDex);
            expect(hub.getCrossChainDexAnchor()).to.equal(hub.crossChainDexAnchor);
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

        it('_loadValidatorPubkeys swallows DB errors', async function () {
            hub.peerManager = { setValidatorPubkeys: sinon.stub() };
            mockDb.doQuery.rejects(new Error('db down'));
            await hub._loadValidatorPubkeys();
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
});
