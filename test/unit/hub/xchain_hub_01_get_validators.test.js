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
const AttestationConsensus = require('../../../src/attestation/consensus.js');
const { DB_METHODS } = require('../../helpers/mockHub.js');

let rootSuiteMockDb, rootSuiteMockPool, rootSuiteMockConn, rootSuiteMockMariadb, rootSuiteXChainHub;

// proxyquire busts the require cache and recompiles XChainHub's whole
// dependency tree (~10s cold on the Parallels share), so do it ONCE here
// rather than per-test. The Database stub reads `mockDb` at call time, so
// each test still gets the fresh mock created in beforeEach.
function registerFeature7getValidatorsPart1() {
  it('returns active validators from DB', async function () {
    let hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
    hub.db = rootSuiteMockDb;
    rootSuiteMockDb.doQuery.resolves([{
      signing_pubkey: 'aa'.repeat(32),
      addr: 'ws://v1:10001',
      status: 'active'
    }]);
    let result = await hub.getValidators();
    expect(result).to.have.lengthOf(1);
  });
}
function registerFeature7getValidators() {
  describe('getValidators()', function () {
    registerFeature7getValidatorsPart1();
  });
}
let feature8delegationToSubsystemsHub;
function registerFeature8delegationToSubsystemsPart1() {
  it('getPriceSnapshots() queries DB', async function () {
    rootSuiteMockDb.doQuery.resolves([{
      round_number: 1
    }]);
    let result = await feature8delegationToSubsystemsHub.getPriceSnapshots(5);
    expect(rootSuiteMockDb.doQuery.called).to.be.true;
  });
  it('getPrice() queries latest finalized price', async function () {
    rootSuiteMockDb.doQuery.resolves([{
      price: '100000',
      coin_pair: 'BTC/USD'
    }]);
    let result = await feature8delegationToSubsystemsHub.getPrice('BTC/USD');
    expect(result).to.not.be.null;
  });
}
function registerFeature8delegationToSubsystems() {
  describe('delegation to subsystems', function () {
    beforeEach(function () {
      feature8delegationToSubsystemsHub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
      feature8delegationToSubsystemsHub.db = rootSuiteMockDb;
    });
    registerFeature8delegationToSubsystemsPart1();
  });
}
let feature9oraclePriceStalenessL5Hub;
const feature9oraclePriceStalenessL5NowS = () => Math.floor(Date.now() / 1000);
function registerFeature9oraclePriceStalenessL5Part1() {
  it('getPriceStatus flags a snapshot older than the max age as stale', async function () {
    // block_timestamp 2h old, default bound 1800s -> stale.
    rootSuiteMockDb.doQuery.resolves([{
      price: '100000',
      coin_pair: 'BTC/USD',
      block_timestamp: feature9oraclePriceStalenessL5NowS() - 7200
    }]);
    let s = await feature9oraclePriceStalenessL5Hub.getPriceStatus('BTC/USD');
    expect(s.stale).to.equal(true);
    expect(s.fresh).to.equal(false);
    expect(s.missing).to.equal(false);
    expect(s.maxAgeSeconds).to.equal(1800);
    expect(s.ageSeconds).to.be.greaterThan(1800);
  });
  it('getPriceStatus keeps a fresh snapshot fresh', async function () {
    rootSuiteMockDb.doQuery.resolves([{
      price: '100000',
      coin_pair: 'BTC/USD',
      block_timestamp: feature9oraclePriceStalenessL5NowS() - 60
    }]);
    let s = await feature9oraclePriceStalenessL5Hub.getPriceStatus('BTC/USD');
    expect(s.fresh).to.equal(true);
    expect(s.stale).to.equal(false);
  });
  it('getPriceStatus never ages out a snapshot with no usable block_timestamp', async function () {
    rootSuiteMockDb.doQuery.resolves([{
      price: '100000',
      coin_pair: 'BTC/USD',
      block_timestamp: 0
    }]);
    let s = await feature9oraclePriceStalenessL5Hub.getPriceStatus('BTC/USD');
    expect(s.fresh).to.equal(true);
    expect(s.ageSeconds).to.equal(null);
  });
  it('getPrice returns null for a stale snapshot (fails closed)', async function () {
    rootSuiteMockDb.doQuery.resolves([{
      price: '100000',
      coin_pair: 'BTC/USD',
      block_timestamp: feature9oraclePriceStalenessL5NowS() - 7200
    }]);
    expect(await feature9oraclePriceStalenessL5Hub.getPrice('BTC/USD')).to.be.null;
  });
}
function registerFeature9oraclePriceStalenessL5Part2() {
  it('getFeeQuote refuses to quote off a stale XCHAIN/USD price', async function () {
    // Both getPrice calls resolve the same stale row; XCHAIN/USD stale -> throw.
    rootSuiteMockDb.doQuery.resolves([{
      price: '1.00',
      coin_pair: 'XCHAIN/USD',
      block_timestamp: feature9oraclePriceStalenessL5NowS() - 7200
    }]);
    let threw = false;
    try {
      await feature9oraclePriceStalenessL5Hub.getFeeQuote('ISSUE', 'BTC');
    } catch (e) {
      threw = true;
    }
    expect(threw, 'stale oracle must fail the quote closed').to.equal(true);
  });

  // ORACLE_MAX_PRICE_AGE_SECONDS is consensus-pinned (coins/index.js consensusSubset)
  // and the indexer reads only the pinned bundle, so the hub's override is a regtest
  // bring-up seam: honored there, set-but-IGNORED and warned on every other network
  // (standalone's empty network included, which fails closed like the sibling seams).
  it('honours ORACLE_MAX_PRICE_AGE_SECONDS from p2pConfig on regtest (0 disables the bound)', async function () {
    let h = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', {
      HUB_NETWORK: 'regtest',
      ORACLE_MAX_PRICE_AGE_SECONDS: 0
    });
    h.db = rootSuiteMockDb;
    rootSuiteMockDb.doQuery.resolves([{
      price: '100000',
      coin_pair: 'BTC/USD',
      block_timestamp: feature9oraclePriceStalenessL5NowS() - 999999
    }]);
    let s = await h.getPriceStatus('BTC/USD');
    expect(s.stale).to.equal(false);
    expect(s.maxAgeSeconds).to.equal(0);
  });
}
function registerFeature9oraclePriceStalenessL5Part3() {
  ['mainnet', 'testnet'].forEach(function (network) {
    it('ignores the p2pConfig override on ' + network + ' and warns once', async function () {
      const coins = require('../../../src/coins');
      const pinned = Number(coins.getCoinConfig('BTC', network).ORACLE_MAX_PRICE_AGE_SECONDS);
      let h = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', {
        HUB_NETWORK: network,
        ORACLE_MAX_PRICE_AGE_SECONDS: 0
      });
      h.db = rootSuiteMockDb;
      rootSuiteMockDb.doQuery.resolves([{
        price: '100000',
        coin_pair: 'BTC/USD',
        block_timestamp: feature9oraclePriceStalenessL5NowS() - 999999
      }]);
      let logs = [];
      let stub = sinon.stub(console, 'log').callsFake(m => logs.push(String(m)));
      let s;
      try {
        s = await h.getPriceStatus('BTC/USD');
        await h.getPriceStatus('BTC/USD');
      } finally {
        stub.restore();
      }
      expect(s.maxAgeSeconds).to.equal(pinned);
      expect(s.stale).to.equal(true);
      let warned = logs.filter(l => l.indexOf('ORACLE_MAX_PRICE_AGE_SECONDS') !== -1);
      expect(warned.length).to.equal(1);
      expect(warned[0]).to.contain('IGNORED on ' + network);
    });
  });
  it('ignores the override in standalone mode, where the network is unset', function () {
    const coins = require('../../../src/coins');
    const pinned = Number(coins.getCoinConfig('BTC', 'mainnet').ORACLE_MAX_PRICE_AGE_SECONDS);
    let h = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', {
      ORACLE_MAX_PRICE_AGE_SECONDS: 0
    });
    let stub = sinon.stub(console, 'log');
    try {
      expect(h.oracleMaxAgeSeconds('BTC/USD')).to.equal(pinned);
    } finally {
      stub.restore();
    }
  });
}
function registerFeature9oraclePriceStalenessL5Part4() {
  it('sources the default bound from the consensus-pinned coin registry (no literal 1800)', function () {
    const coins = require('../../../src/coins');
    // No env/p2pConfig override -> the bound is the registry value, not a literal.
    const pinned = Number(coins.getCoinConfig('BTC', 'mainnet').ORACLE_MAX_PRICE_AGE_SECONDS);
    expect(feature9oraclePriceStalenessL5Hub.oracleMaxAgeSeconds('BTC/USD')).to.equal(pinned);
    // A non-registry advisory pair (XCHAIN/USD) still resolves via the BTC fallback.
    expect(feature9oraclePriceStalenessL5Hub.oracleMaxAgeSeconds('XCHAIN/USD')).to.equal(pinned);
  });

  // Item #4479: getoraclesubmissions publishes this bound as the scalar
  // oracleMaxPriceAgeSeconds, so a cadence-derived health consumer cannot
  // call a row fresh that getprice already rejects. The RPC calls it with
  // NO pair, so that arity must resolve to the registry default rather
  // than null, or the consumer's clamp silently no-ops.
  it('resolves the representative scalar when called with no coin pair (#4479)', function () {
    const coins = require('../../../src/coins');
    const pinned = Number(coins.getCoinConfig('BTC', 'mainnet').ORACLE_MAX_PRICE_AGE_SECONDS);
    expect(feature9oraclePriceStalenessL5Hub.oracleMaxAgeSeconds()).to.equal(pinned);
    expect(feature9oraclePriceStalenessL5Hub.oracleMaxAgeSeconds()).to.be.greaterThan(0);
  });
}
function registerFeature9oraclePriceStalenessL5() {
  describe('oracle price staleness (L-5)', function () {
    beforeEach(function () {
      feature9oraclePriceStalenessL5Hub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', null);
      feature9oraclePriceStalenessL5Hub.db = rootSuiteMockDb;
    });
    registerFeature9oraclePriceStalenessL5Part1();
    registerFeature9oraclePriceStalenessL5Part2();
    registerFeature9oraclePriceStalenessL5Part3();
    registerFeature9oraclePriceStalenessL5Part4();
  });
}
const feature10capabilityGovernanceHotReloadCapabilityRegistry = require('../../../src/validators/capability_registry');
let feature10capabilityGovernanceHotReloadHub;
function registerFeature10capabilityGovernanceHotReloadPart1() {
  it('parseCapabilityParameter recognizes CAPABILITY_<CAP>_MIN_STAKE', function () {
    expect(feature10capabilityGovernanceHotReloadHub.parseCapabilityParameter('CAPABILITY_PRICE_MIN_STAKE')).to.deep.equal({
      capability: 'price',
      parameterKey: 'MIN_STAKE'
    });
    expect(feature10capabilityGovernanceHotReloadHub.parseCapabilityParameter('CAPABILITY_CROSS_CHAIN_MIN_STAKE')).to.deep.equal({
      capability: 'cross_chain',
      parameterKey: 'MIN_STAKE'
    });
  });
  it('parseCapabilityParameter returns null for non-capability params', function () {
    expect(feature10capabilityGovernanceHotReloadHub.parseCapabilityParameter('ORACLE_ROUND_INTERVAL')).to.be.null;
    expect(feature10capabilityGovernanceHotReloadHub.parseCapabilityParameter('CAPABILITY_BOGUS_MIN_STAKE')).to.be.null;
    expect(feature10capabilityGovernanceHotReloadHub.parseCapabilityParameter('')).to.be.null;
  });
  it('does NOT apply a finalized CAPABILITY_*_MIN_STAKE change (pinned pre-launch #4352)', async function () {
    expect(feature10capabilityGovernanceHotReloadHub.capabilityRegistry.getMinStake('price')).to.equal('10000');
    await feature10capabilityGovernanceHotReloadHub.applyCapabilityGovernanceChange({
      parameter: 'CAPABILITY_PRICE_MIN_STAKE',
      oldValue: '10000',
      newValue: '25000',
      activationBlock: 1000
    });
    // The pin (#4352) keeps getMinStake pinned to the genesis value for every block,
    // so it can never drift from the indexer's frozen configs/<COIN>.js constant.
    expect(feature10capabilityGovernanceHotReloadHub.capabilityRegistry.getMinStake('price', 999)).to.equal('10000');
    expect(feature10capabilityGovernanceHotReloadHub.capabilityRegistry.getMinStake('price', 1000)).to.equal('10000');
    expect(feature10capabilityGovernanceHotReloadHub.capabilityRegistry.getMinStake('price')).to.equal('10000');
  });
  it('does NOT apply a MIN_STAKE change with no activation block either', async function () {
    await feature10capabilityGovernanceHotReloadHub.applyCapabilityGovernanceChange({
      parameter: 'CAPABILITY_PRICE_MIN_STAKE',
      oldValue: '10000',
      newValue: '25000'
    });
    expect(feature10capabilityGovernanceHotReloadHub.capabilityRegistry.getMinStake('price', 1000)).to.equal('10000');
  });
  it('does not re-qualify on a pinned MIN_STAKE change (no apply, no setQualification)', async function () {
    let setQual = sinon.spy(feature10capabilityGovernanceHotReloadHub.capabilityRegistry, 'setQualification');
    feature10capabilityGovernanceHotReloadHub._latestStakeAmount = '15000';
    await feature10capabilityGovernanceHotReloadHub.applyCapabilityGovernanceChange({
      parameter: 'CAPABILITY_PRICE_MIN_STAKE',
      oldValue: '10000',
      newValue: '25000',
      activationBlock: 1000
    });
    // The pin returns before flush + refreshOwnQualification, so price is not re-evaluated
    // and the threshold is unchanged.
    let priceCall = setQual.getCalls().find(c => c.args[1] === 'price');
    expect(priceCall, 'no setQualification for a pinned MIN_STAKE change').to.equal(undefined);
    expect(feature10capabilityGovernanceHotReloadHub.capabilityRegistry.getMinStake('price')).to.equal('10000');
  });
}
function registerFeature10capabilityGovernanceHotReloadPart2() {
  it('ignores non-capability proposals', async function () {
    let setQual = sinon.spy(feature10capabilityGovernanceHotReloadHub.capabilityRegistry, 'setQualification');
    await feature10capabilityGovernanceHotReloadHub.applyCapabilityGovernanceChange({
      parameter: 'ORACLE_ROUND_INTERVAL',
      oldValue: '600000',
      newValue: '900000'
    });
    expect(setQual.called).to.be.false;
    expect(feature10capabilityGovernanceHotReloadHub.capabilityRegistry.getMinStake('price')).to.equal('10000');
  });
}
function registerFeature10capabilityGovernanceHotReload() {
  describe('capability governance hot-reload', function () {
    beforeEach(function () {
      rootSuiteMockDb.getConnection = sinon.stub().resolves(rootSuiteMockConn);
      feature10capabilityGovernanceHotReloadHub = new rootSuiteXChainHub('host', 3306, 'db', 'user', 'pass', {
        CAPABILITIES: {
          price: {
            MIN_STAKE: '10000'
          }
        }
      });
      feature10capabilityGovernanceHotReloadHub.db = rootSuiteMockDb;
      feature10capabilityGovernanceHotReloadHub.capabilityRegistry = new feature10capabilityGovernanceHotReloadCapabilityRegistry(feature10capabilityGovernanceHotReloadHub);
      feature10capabilityGovernanceHotReloadHub.identity = {
        getPubkeyHex: () => 'aa'.repeat(33)
      };
    });
    registerFeature10capabilityGovernanceHotReloadPart1();
    registerFeature10capabilityGovernanceHotReloadPart2();
  });
}
describe('XChainHub', function () {
  // proxyquire busts the require cache and recompiles XChainHub's whole
  // dependency tree (~10s cold on the Parallels share), so do it ONCE here
  // rather than per-test. The Database stub reads `mockDb` at call time, so
  // each test still gets the fresh mock created in beforeEach.
  before(function () {
    this.timeout(30000);
    rootSuiteXChainHub = proxyquire('../../../src/XChainHub', {
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
  registerFeature7getValidators();
  registerFeature8delegationToSubsystems();
  registerFeature9oraclePriceStalenessL5();
  registerFeature10capabilityGovernanceHotReload();
});
