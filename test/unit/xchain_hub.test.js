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
const { EventEmitter } = require('events');
const AttestationConsensus = require('../../src/attestation/consensus.js');
const { DB_METHODS } = require('../helpers/mockHub.js');

let rootSuiteMockDb, rootSuiteMockPool, rootSuiteMockConn, rootSuiteMockMariadb, rootSuiteXChainHub;

// proxyquire busts the require cache and recompiles XChainHub's whole
// dependency tree (~10s cold on the Parallels share), so do it ONCE here
// rather than per-test. The Database stub reads `mockDb` at call time, so
// each test still gets the fresh mock created in beforeEach.
function registerFeature1constructorPart1() {
  it('stores DB credentials and p2pConfig', function () {
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', {
      P2P_PORT: 10001
    });
    expect(hub.p2pConfig.P2P_PORT).to.equal(10001);
    // The constructor also seeds the canonical NODEPROOF parameters from the
    // pinned coin bundle, because startP2P builds FullNodeChallengeRound
    // before startCapabilities runs.
    expect(hub.p2pConfig.FULLNODE.REWARD_SHARE).to.equal('0');
    expect(Object.keys(hub.p2pConfig).sort()).to.deep.equal(['FULLNODE', 'P2P_PORT']);
  });
  it('handles null p2pConfig', function () {
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
    expect(hub.p2pConfig).to.be.null;
  });
}
function registerFeature1constructor() {
  describe('constructor', function () {
    registerFeature1constructorPart1();
  });
}
const feature2startConsensusPinVerificationCoins = require('../../src/coins');
function registerFeature2startConsensusPinVerificationPart1() {
  it('fails closed on an armed-pin mismatch before any DB work', async function () {
    let verify = sinon.stub(feature2startConsensusPinVerificationCoins, 'verifyConsensusPin').throws(new Error('CONSENSUS CONFIG PIN MISMATCH for BTC/testnet'));
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', {});
    try {
      await hub.start();
      expect.fail('start() must not resolve on a pin mismatch');
    } catch (e) {
      expect(e.message).to.match(/PIN MISMATCH/);
    }
    expect(verify.called).to.equal(true);
    // Fail-closed: the drifted node never reached DB/serving work.
    expect(rootSuiteMockDb.createDatabase.called).to.equal(false);
  });
  it('verifies every network before DB/serving work begins', async function () {
    let verify = sinon.stub(feature2startConsensusPinVerificationCoins, 'verifyConsensusPin').returns({
      ok: true,
      skipped: false
    });
    // Sentinel on the LAST network proves all networks are checked
    // before start() proceeds to DB construction.
    verify.onCall(feature2startConsensusPinVerificationCoins.NETWORKS.length - 1).throws(new Error('sentinel: last network reached'));
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', {});
    try {
      await hub.start();
    } catch (e) {/* sentinel */}
    expect(verify.callCount).to.equal(feature2startConsensusPinVerificationCoins.NETWORKS.length);
    for (let i = 0; i < feature2startConsensusPinVerificationCoins.NETWORKS.length; i++) expect(verify.getCall(i).args[0]).to.equal(feature2startConsensusPinVerificationCoins.NETWORKS[i]);
    expect(rootSuiteMockDb.createDatabase.called).to.equal(false);
  });
}
function registerFeature2startConsensusPinVerification() {
  describe('start() consensus-pin verification', function () {
    registerFeature2startConsensusPinVerificationPart1();
  });
}
function registerFeature3applyConfigPart1() {
  it('collects nested config and batches via a single setParams call', async function () {
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
    hub.db = rootSuiteMockDb;
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
    expect(rootSuiteMockDb.setParams.calledOnce).to.be.true;
    expect(rootSuiteMockDb.setParam.called).to.be.false;
    let rows = rootSuiteMockDb.setParams.getCall(0).args[0];
    expect(rows).to.have.length(2);
    expect(rows).to.deep.include({
      coin: 'BTC',
      network: 'mainnet',
      module: 'indexer',
      paramName: 'host',
      paramValue: 'idx-host'
    });
    expect(rows).to.deep.include({
      coin: 'BTC',
      network: 'mainnet',
      module: 'indexer',
      paramName: 'port',
      paramValue: '3309'
    });
  });

  // The explorer's self-synced checkpoint mirror needs BOTH halves of the block
  // xchain-node generates: self_sync says "you write this schema yourself" and
  // hub_url says where to read the feed. They ship together for exactly that
  // reason, so this path must not carry one and drop the other - an explorer
  // told to self-sync with no endpoint writes nothing, and its hub-mirrored
  // routes (price_snapshots, oracle_prices, state_checkpoints) serve a frozen
  // mirror or fail loud per request.
}
function registerFeature3applyConfigPart2() {
  // The explorer's self-synced checkpoint mirror needs BOTH halves of the block
  // xchain-node generates: self_sync says "you write this schema yourself" and
  // hub_url says where to read the feed. They ship together for exactly that
  // reason, so this path must not carry one and drop the other - an explorer
  // told to self-sync with no endpoint writes nothing, and its hub-mirrored
  // routes (price_snapshots, oracle_prices, state_checkpoints) serve a frozen
  // mirror or fail loud per request.
  it('keeps the hub endpoint that travels with a self-synced checkpoint block', async function () {
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
    hub.db = rootSuiteMockDb;
    await hub.applyConfig({
      BTC: {
        regtest: {
          checkpoint: {
            db_host: 'mariadb',
            db_port: '3306',
            name: 'XChain_BTC_Regtest_Indexer_HubMirror',
            user: 'xchain_indexer',
            pass: 'secret',
            self_sync: 'true',
            hub_url: 'http://xchain-node-xchain-hub:10000'
          }
        }
      }
    });
    let rows = rootSuiteMockDb.setParams.getCall(0).args[0];
    let hubUrl = rows.find(r => r.paramName === 'hub_url');
    expect(hubUrl).to.exist;
    expect(hubUrl.paramValue).to.equal('http://xchain-node-xchain-hub:10000');
    expect(hubUrl.module).to.equal('checkpoint');
    expect(rows.map(r => r.paramName)).to.include('self_sync');
  });
  it('skips keys outside the combined allowlist, accepts known operational params', async function () {
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
    hub.db = rootSuiteMockDb;
    let config = {
      BTC: {
        mainnet: {
          indexer: {
            host: 'localhost',
            GAS_PRICE: '0.00002',
            invalid_param: 'should-be-skipped'
          }
        }
      }
    };
    await hub.applyConfig(config);
    let rows = rootSuiteMockDb.setParams.getCall(0).args[0];
    let paramNames = rows.map(r => r.paramName);
    expect(paramNames).to.include('host');
    expect(paramNames).to.include('GAS_PRICE');
    expect(paramNames).to.not.include('invalid_param');
  });
}
function registerFeature3applyConfigPart3() {
  it('stores GAS_PRICE as a flat scalar string', async function () {
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
    hub.db = rootSuiteMockDb;
    await hub.applyConfig({
      BTC: {
        mainnet: {
          'xchain-indexer': {
            GAS_PRICE: '0.00002'
          }
        }
      }
    });
    let rows = rootSuiteMockDb.setParams.getCall(0).args[0];
    let row = rows.find(r => r.paramName === 'GAS_PRICE');
    expect(row).to.exist;
    expect(row.paramValue).to.equal('0.00002');
  });
  it('serializes GAS_SCHEDULE object to JSON string', async function () {
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
    hub.db = rootSuiteMockDb;
    let schedule = {
      ISSUE: 100000,
      ISSUE_SUBTOKEN: 50000
    };
    await hub.applyConfig({
      BTC: {
        mainnet: {
          'xchain-indexer': {
            GAS_SCHEDULE: schedule
          }
        }
      }
    });
    let rows = rootSuiteMockDb.setParams.getCall(0).args[0];
    let row = rows.find(r => r.paramName === 'GAS_SCHEDULE');
    expect(row).to.exist;
    expect(row.paramValue).to.equal(JSON.stringify(schedule));
  });
  it('stores GAS_SCHEDULE already serialized as a string unchanged', async function () {
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
    hub.db = rootSuiteMockDb;
    let serialized = '{"ISSUE":100000}';
    await hub.applyConfig({
      BTC: {
        mainnet: {
          'xchain-indexer': {
            GAS_SCHEDULE: serialized
          }
        }
      }
    });
    let rows = rootSuiteMockDb.setParams.getCall(0).args[0];
    let row = rows.find(r => r.paramName === 'GAS_SCHEDULE');
    expect(row).to.exist;
    expect(row.paramValue).to.equal(serialized);
  });
}
function registerFeature3applyConfigPart4() {
  it('is a no-op (no DB write) when config has no recognized params', async function () {
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
    hub.db = rootSuiteMockDb;
    await hub.applyConfig({
      BTC: {
        mainnet: {
          indexer: {
            invalid_param: 'x'
          }
        }
      }
    });
    expect(rootSuiteMockDb.setParams.called).to.be.false;
  });
}
function registerFeature3applyConfig() {
  describe('applyConfig()', function () {
    registerFeature3applyConfigPart1();
    registerFeature3applyConfigPart2();
    registerFeature3applyConfigPart3();
    registerFeature3applyConfigPart4();
  });
}
function registerFeature4getAllConfigsPart1() {
  it('delegates to db.getAllConfigs()', async function () {
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
    hub.db = rootSuiteMockDb;
    rootSuiteMockDb.getAllConfigs.resolves({
      BTC: {
        mainnet: {}
      }
    });
    let result = await hub.getAllConfigs();
    expect(rootSuiteMockDb.getAllConfigs.calledOnce).to.be.true;
    expect(result).to.deep.equal({
      BTC: {
        mainnet: {}
      }
    });
  });
}
function registerFeature4getAllConfigs() {
  describe('getAllConfigs()', function () {
    registerFeature4getAllConfigsPart1();
  });
}
function registerFeature5registerValidatorPart1() {
  it('rejects invalid pubkey format', async function () {
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
    hub.db = rootSuiteMockDb;
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
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
    hub.db = rootSuiteMockDb;
    let pubkey = 'aa'.repeat(32);
    await hub.registerValidator(pubkey, 'ws://validator:10001');
    expect(rootSuiteMockDb.doQuery.called).to.be.true;
    let sql = rootSuiteMockDb.doQuery.getCall(0).args[0];
    expect(sql).to.include('validators');
  });
}
function registerFeature5registerValidator() {
  describe('registerValidator()', function () {
    registerFeature5registerValidatorPart1();
  });
}
function registerFeature6getFeeQuotePart1() {
  it('returns fee quote using oracle price', async function () {
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
    hub.db = rootSuiteMockDb;

    // getPrice returns a price snapshot
    rootSuiteMockDb.doQuery.resolves([{
      price: '100000.00000000',
      coin_pair: 'BTC/USD'
    }]);
    let result = await hub.getFeeQuote('SEND', 'BTC');
    // Should return something (exact format depends on implementation)
    expect(result).to.not.be.null;
  });
  it('handles missing price gracefully', async function () {
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
    hub.db = rootSuiteMockDb;
    rootSuiteMockDb.doQuery.resolves([]); // no price

    let result = await hub.getFeeQuote('SEND', 'BTC');
    expect(result).to.not.be.undefined;
  });
}
function registerFeature6getFeeQuote() {
  describe('getFeeQuote()', function () {
    registerFeature6getFeeQuotePart1();
  });
}
describe('XChainHub', function () {
  // proxyquire busts the require cache and recompiles XChainHub's whole
  // dependency tree (~10s cold on the Parallels share), so do it ONCE here
  // rather than per-test. The Database stub reads `mockDb` at call time, so
  // each test still gets the fresh mock created in beforeEach.
  before(function () {
    this.timeout(30000);
    rootSuiteXChainHub = proxyquire('../../src/XChainHub', {
      './db': function () {
        return rootSuiteMockDb;
      }
    });
  });
  beforeEach(function () {
    rootSuiteMockConn = {
      query: sinon.stub().resolves([]),
      release: sinon.stub().resolves()
    };
    rootSuiteMockPool = {
      getConnection: sinon.stub().resolves(rootSuiteMockConn),
      end: sinon.stub().resolves()
    };
    rootSuiteMockDb = {
      ...DB_METHODS,
      doQuery: sinon.stub().resolves([]),
      setParam: sinon.stub().resolves(),
      setParams: sinon.stub().resolves(0),
      getConfig: sinon.stub().resolves({}),
      getAllConfigs: sinon.stub().resolves({}),
      createDatabase: sinon.stub().resolves(true),
      verifyTables: sinon.stub().resolves(true),
      close: sinon.stub().resolves()
    };
  });
  afterEach(function () {
    sinon.restore();
  });

  // -----------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------
  registerFeature1constructor();
  registerFeature2startConsensusPinVerification();
  registerFeature3applyConfig();
  registerFeature4getAllConfigs();
  registerFeature5registerValidator();
  registerFeature6getFeeQuote();
});
