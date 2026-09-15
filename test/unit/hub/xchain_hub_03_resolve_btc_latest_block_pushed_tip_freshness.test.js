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

let feature14resolveBtcLatestBlockPushedTipFreshnessHub;
function registerFeature14resolveBtcLatestBlockPushedTipFreshnessPart1() {
  it('returns the pushed tip when its block_time is fresh', async function () {
    let now = Math.floor(Date.now() / 1000);
    rootSuiteMockDb.getChainTip = sinon.stub().resolves({
      blockHeight: 800000,
      blockTime: now - 60
    });
    let direct = sinon.stub(feature14resolveBtcLatestBlockPushedTipFreshnessHub, '_resolveBtcIndexerUrl').resolves(null);
    expect(await feature14resolveBtcLatestBlockPushedTipFreshnessHub.resolveBtcLatestBlock()).to.equal(800000);
    // Fresh tip short-circuits path 1; the direct path is never consulted.
    expect(direct.called).to.equal(false);
  });
  it('falls through to the direct path when the pushed tip is stale', async function () {
    let now = Math.floor(Date.now() / 1000);
    // 2 hours old, well past the default 2x round-interval (1200s) bound.
    rootSuiteMockDb.getChainTip = sinon.stub().resolves({
      blockHeight: 800000,
      blockTime: now - 7200
    });
    sinon.stub(feature14resolveBtcLatestBlockPushedTipFreshnessHub, '_resolveBtcIndexerUrl').resolves(null); // direct path unavailable → null
    expect(await feature14resolveBtcLatestBlockPushedTipFreshnessHub.resolveBtcLatestBlock()).to.equal(null);
  });
  it('falls through when the pushed tip has no block_time (unverifiable)', async function () {
    rootSuiteMockDb.getChainTip = sinon.stub().resolves({
      blockHeight: 800000,
      blockTime: 0
    });
    sinon.stub(feature14resolveBtcLatestBlockPushedTipFreshnessHub, '_resolveBtcIndexerUrl').resolves(null);
    expect(await feature14resolveBtcLatestBlockPushedTipFreshnessHub.resolveBtcLatestBlock()).to.equal(null);
  });
}
function registerFeature14resolveBtcLatestBlockPushedTipFreshness() {
  describe('resolveBtcLatestBlock pushed-tip freshness', function () {
    beforeEach(function () {
      feature14resolveBtcLatestBlockPushedTipFreshnessHub = new rootSuiteXChainHub('h', 1, 'd', 'u', 'p', null);
      feature14resolveBtcLatestBlockPushedTipFreshnessHub.db = rootSuiteMockDb;
      sinon.stub(feature14resolveBtcLatestBlockPushedTipFreshnessHub, 'resolveBtcNetwork').resolves('regtest');
    });
    registerFeature14resolveBtcLatestBlockPushedTipFreshnessPart1();
  });
}
const feature15ownPubkeySignerSetSelfReportOWN = 'ab'.repeat(32);
const feature15ownPubkeySignerSetSelfReportOTHER = 'cd'.repeat(32);
let feature15ownPubkeySignerSetSelfReportHub, feature15ownPubkeySignerSetSelfReportWarnings, feature15ownPubkeySignerSetSelfReportLogs;
function feature15ownPubkeySignerSetSelfReportRefreshWith(pubkeys) {
  feature15ownPubkeySignerSetSelfReportHub.capabilitySnapshot = {
    getActiveValidatorSnapshot: sinon.stub().resolves({
      validators: pubkeys.map(pk => ({
        pubkey: pk
      }))
    })
  };
  return feature15ownPubkeySignerSetSelfReportHub.refreshTransportSignerSet();
}
function registerFeature15ownPubkeySignerSetSelfReportPart1() {
  it('warns once that peers will reject this hub while its pubkey is out of the set', async function () {
    await feature15ownPubkeySignerSetSelfReportRefreshWith([feature15ownPubkeySignerSetSelfReportOTHER]);
    let line = feature15ownPubkeySignerSetSelfReportWarnings.find(l => l.includes('NOT in the chain-effective signer set'));
    expect(line, 'the out-of-set state is reported locally').to.be.a('string');
    expect(line).to.include('until a STAKE for it confirms and activates');
    expect(line, 'the operator can match the key').to.include(feature15ownPubkeySignerSetSelfReportOWN);

    // A refresh loop must not turn one standing condition into a log flood.
    await feature15ownPubkeySignerSetSelfReportRefreshWith([feature15ownPubkeySignerSetSelfReportOTHER]);
    expect(feature15ownPubkeySignerSetSelfReportWarnings.filter(l => l.includes('NOT in the chain-effective signer set'))).to.have.lengthOf(1);
  });
  it('logs once when the pubkey is admitted, and stays quiet after', async function () {
    await feature15ownPubkeySignerSetSelfReportRefreshWith([feature15ownPubkeySignerSetSelfReportOTHER]);
    await feature15ownPubkeySignerSetSelfReportRefreshWith([feature15ownPubkeySignerSetSelfReportOTHER, feature15ownPubkeySignerSetSelfReportOWN]);
    await feature15ownPubkeySignerSetSelfReportRefreshWith([feature15ownPubkeySignerSetSelfReportOTHER, feature15ownPubkeySignerSetSelfReportOWN]);
    let admitted = feature15ownPubkeySignerSetSelfReportLogs.filter(l => l.includes('is now in the chain-effective signer set'));
    expect(admitted, 'one line on the transition, not one per refresh').to.have.lengthOf(1);
    expect(admitted[0]).to.include(feature15ownPubkeySignerSetSelfReportOWN);
  });
  it('says nothing on a hub with no signing identity', async function () {
    feature15ownPubkeySignerSetSelfReportHub.identity = null;
    await feature15ownPubkeySignerSetSelfReportRefreshWith([feature15ownPubkeySignerSetSelfReportOTHER]);
    expect(feature15ownPubkeySignerSetSelfReportWarnings.filter(l => l.includes('signer set'))).to.have.lengthOf(0);
  });
}
function registerFeature15ownPubkeySignerSetSelfReport() {
  describe('own-pubkey signer-set self-report', function () {
    beforeEach(function () {
      feature15ownPubkeySignerSetSelfReportHub = new rootSuiteXChainHub('h', 1, 'd', 'u', 'p', {
        HUB_NETWORK: 'testnet'
      });
      feature15ownPubkeySignerSetSelfReportHub.db = rootSuiteMockDb;
      feature15ownPubkeySignerSetSelfReportHub.peerManager = {
        setEffectiveSignerSet: sinon.stub()
      };
      feature15ownPubkeySignerSetSelfReportHub.identity = {
        getPubkeyHex: () => feature15ownPubkeySignerSetSelfReportOWN
      };
      feature15ownPubkeySignerSetSelfReportHub.resolveBtcLatestBlock = async () => 100;
      feature15ownPubkeySignerSetSelfReportWarnings = [];
      feature15ownPubkeySignerSetSelfReportLogs = [];
      sinon.stub(console, 'warn').callsFake(m => feature15ownPubkeySignerSetSelfReportWarnings.push(String(m)));
      sinon.stub(console, 'log').callsFake(m => feature15ownPubkeySignerSetSelfReportLogs.push(String(m)));
    });
    registerFeature15ownPubkeySignerSetSelfReportPart1();
  });
}
let feature16validatorSetLoadersHub;
function registerFeature16validatorSetLoadersPart1() {
  it('loadValidatorPubkeys is a no-op without a peer manager', async function () {
    await feature16validatorSetLoadersHub.loadValidatorPubkeys(); // no peerManager → returns
    expect(rootSuiteMockDb.doQuery.called).to.be.false;
  });
  it('loadValidatorPubkeys builds the addr→pubkey map on the peer manager', async function () {
    feature16validatorSetLoadersHub.peerManager = {
      setValidatorPubkeys: sinon.stub()
    };
    rootSuiteMockDb.doQuery.resolves([{
      addr: 'ws://v:1',
      signing_pubkey: 'pk1'
    }]);
    await feature16validatorSetLoadersHub.loadValidatorPubkeys();
    let map = feature16validatorSetLoadersHub.peerManager.setValidatorPubkeys.getCall(0).args[0];
    expect(map.get('ws://v:1')).to.equal('pk1');
  });
  it('loadValidatorPubkeys propagates DB errors and leaves the registry unset (fail closed)', async function () {
    feature16validatorSetLoadersHub.peerManager = {
      setValidatorPubkeys: sinon.stub()
    };
    rootSuiteMockDb.doQuery.rejects(new Error('db down'));
    let threw = false;
    try {
      await feature16validatorSetLoadersHub.loadValidatorPubkeys();
    } catch (e) {
      threw = true;
    }
    // Must propagate so startP2P never opens the listener with a null
    // registry (a null registry makes verifySignature accept any
    // signed envelope; see PeerManager).
    expect(threw).to.be.true;
    expect(feature16validatorSetLoadersHub.peerManager.setValidatorPubkeys.called).to.be.false;
  });
  it('loadValidatorSet maps rows and returns [] on error', async function () {
    rootSuiteMockDb.doQuery.resolves([{
      signing_pubkey: 'pk1',
      addr: 'a1'
    }]);
    expect(await feature16validatorSetLoadersHub.loadValidatorSet()).to.deep.equal([{
      pubkey: 'pk1',
      addr: 'a1'
    }]);
    rootSuiteMockDb.doQuery.rejects(new Error('db down'));
    expect(await feature16validatorSetLoadersHub.loadValidatorSet()).to.deep.equal([]);
  });
}
function registerFeature16validatorSetLoadersPart2() {
  it('loadChainPairValidators filters validators by supported chains', async function () {
    rootSuiteMockDb.doQuery.resolves([{
      signing_pubkey: 'pk1',
      addr: 'a1',
      chains: null
    },
    // all chains
    {
      signing_pubkey: 'pk2',
      addr: 'a2',
      chains: 'BTC,LTC'
    },
    // BTC-LTC only
    {
      signing_pubkey: 'pk3',
      addr: 'a3',
      chains: 'DOGE'
    } // none of the pairs
    ]);
    let map = await feature16validatorSetLoadersHub.loadChainPairValidators();
    expect(map.get('BTC-LTC').map(v => v.pubkey)).to.have.members(['pk1', 'pk2']);
    expect(map.get('BTC-DOGE').map(v => v.pubkey)).to.deep.equal(['pk1']);
  });
  it('loadChainPairValidators returns an empty map on DB error', async function () {
    rootSuiteMockDb.doQuery.rejects(new Error('db down'));
    let map = await feature16validatorSetLoadersHub.loadChainPairValidators();
    expect(map.size).to.equal(0);
  });
}
function registerFeature16validatorSetLoaders() {
  describe('validator-set loaders', function () {
    beforeEach(function () {
      feature16validatorSetLoadersHub = new rootSuiteXChainHub('h', 1, 'd', 'u', 'p', null);
      feature16validatorSetLoadersHub.db = rootSuiteMockDb;
    });
    registerFeature16validatorSetLoadersPart1();
    registerFeature16validatorSetLoadersPart2();
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
  registerFeature14resolveBtcLatestBlockPushedTipFreshness();
  registerFeature15ownPubkeySignerSetSelfReport();
  registerFeature16validatorSetLoaders();
});
