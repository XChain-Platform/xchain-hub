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

let feature11subsystemGettersHub;
function registerFeature11subsystemGettersPart1() {
  it('return the wired-in subsystem instances', function () {
    feature11subsystemGettersHub.peerManager = {
      a: 1
    };
    feature11subsystemGettersHub.consensus = {
      b: 2
    };
    feature11subsystemGettersHub.identity = {
      c: 3
    };
    feature11subsystemGettersHub.oracle = {
      d: 4
    };
    feature11subsystemGettersHub.crossChain = {
      e: 5
    };
    feature11subsystemGettersHub.crossChainDex = {
      f: 6
    };
    expect(feature11subsystemGettersHub.getPeerManager()).to.equal(feature11subsystemGettersHub.peerManager);
    expect(feature11subsystemGettersHub.getConsensus()).to.equal(feature11subsystemGettersHub.consensus);
    expect(feature11subsystemGettersHub.getIdentity()).to.equal(feature11subsystemGettersHub.identity);
    expect(feature11subsystemGettersHub.getOracle()).to.equal(feature11subsystemGettersHub.oracle);
    expect(feature11subsystemGettersHub.getCrossChain()).to.equal(feature11subsystemGettersHub.crossChain);
    expect(feature11subsystemGettersHub.getCrossChainDex()).to.equal(feature11subsystemGettersHub.crossChainDex);
  });
}
function registerFeature11subsystemGetters() {
  describe('subsystem getters', function () {
    beforeEach(function () {
      feature11subsystemGettersHub = new rootSuiteXChainHub('h', 1, 'd', 'u', 'p', null);
    });
    registerFeature11subsystemGettersPart1();
  });
}
let feature12subsystemDelegatorsHub;
function registerFeature12subsystemDelegatorsPart1() {
  it('reportReorg throws when the reorg handler is inactive, delegates when active', async function () {
    try {
      await feature12subsystemDelegatorsHub.reportReorg('BTC', 5, 1);
      expect.fail('should throw');
    } catch (e) {
      expect(e.message).to.include('Reorg handler not active');
    }
    feature12subsystemDelegatorsHub.reorgHandler = {
      reportReorg: sinon.stub().resolves('ok'),
      getReorgHistory: sinon.stub().resolves([1])
    };
    expect(await feature12subsystemDelegatorsHub.reportReorg('BTC', 5, 1)).to.equal('ok');
    expect(await feature12subsystemDelegatorsHub.getReorgHistory(10)).to.deep.equal([1]);
  });
  it('getReorgHistory returns [] when inactive', async function () {
    expect(await feature12subsystemDelegatorsHub.getReorgHistory()).to.deep.equal([]);
  });
  it('governance delegators: propose/vote throw inactive; getProposals/getProposal default', async function () {
    try {
      await feature12subsystemDelegatorsHub.propose('P', '1', '2');
      expect.fail('throw');
    } catch (e) {
      expect(e.message).to.include('Governance not active');
    }
    try {
      await feature12subsystemDelegatorsHub.vote('id', 'approve');
      expect.fail('throw');
    } catch (e) {
      expect(e.message).to.include('Governance not active');
    }
    expect(await feature12subsystemDelegatorsHub.getProposals()).to.deep.equal([]);
    expect(await feature12subsystemDelegatorsHub.getProposal('x')).to.be.null;
    feature12subsystemDelegatorsHub.governance = {
      propose: sinon.stub().resolves('p'),
      vote: sinon.stub().resolves('v'),
      getProposals: sinon.stub().resolves(['list']),
      getProposal: sinon.stub().resolves({
        id: 1
      })
    };
    expect(await feature12subsystemDelegatorsHub.propose('P', '1', '2', 'r')).to.equal('p');
    expect(await feature12subsystemDelegatorsHub.vote('id', 'approve')).to.equal('v');
    expect(await feature12subsystemDelegatorsHub.getProposals('voting')).to.deep.equal(['list']);
    expect(await feature12subsystemDelegatorsHub.getProposal('x')).to.deep.equal({
      id: 1
    });
  });
}
function registerFeature12subsystemDelegatorsPart2() {
  it('cross-chain + swap delegators: throw/default inactive, delegate active', async function () {
    try {
      await feature12subsystemDelegatorsHub.requestAttestation('BTC', 1, 'LTC');
      expect.fail('throw');
    } catch (e) {
      expect(e.message).to.include('Cross-chain engine not active');
    }
    try {
      await feature12subsystemDelegatorsHub.initiateSwap('BTC', 1, 'LTC', 2);
      expect.fail('throw');
    } catch (e) {
      expect(e.message).to.include('SWAP tracker not active');
    }
    expect(await feature12subsystemDelegatorsHub.getSwap('BTC', 1)).to.be.null;
    expect(await feature12subsystemDelegatorsHub.getSwaps()).to.deep.equal([]);
    feature12subsystemDelegatorsHub.crossChain = {
      requestAttestation: sinon.stub().resolves('att')
    };
    feature12subsystemDelegatorsHub.swapTracker = {
      initiateSwap: sinon.stub().resolves(),
      getSwap: sinon.stub().resolves({
        s: 1
      }),
      getSwaps: sinon.stub().resolves([{
        s: 2
      }])
    };
    expect(await feature12subsystemDelegatorsHub.requestAttestation('BTC', 1, 'LTC')).to.equal('att');
    expect(await feature12subsystemDelegatorsHub.initiateSwap('BTC', 1, 'LTC', 2)).to.equal(true);
    expect(await feature12subsystemDelegatorsHub.getSwap('BTC', 1)).to.deep.equal({
      s: 1
    });
    expect(await feature12subsystemDelegatorsHub.getSwaps('open', 5)).to.deep.equal([{
      s: 2
    }]);
  });
  it('addParametersFromJson routes through consensus when active, else applyConfig', async function () {
    feature12subsystemDelegatorsHub.consensus = {
      propose: sinon.stub().resolves(true)
    };
    expect(await feature12subsystemDelegatorsHub.addParametersFromJson({
      BTC: {
        X: '1'
      }
    })).to.equal(true);
    expect(feature12subsystemDelegatorsHub.consensus.propose.calledOnce).to.be.true;
    let hub2 = new rootSuiteXChainHub('h', 1, 'd', 'u', 'p', null);
    hub2.db = rootSuiteMockDb;
    let apply = sinon.stub(hub2, 'applyConfig').resolves();
    expect(await hub2.addParametersFromJson({
      BTC: {
        X: '1'
      }
    })).to.equal(true);
    expect(apply.calledOnce).to.be.true;
  });
}
function registerFeature12subsystemDelegators() {
  describe('subsystem delegators', function () {
    beforeEach(function () {
      feature12subsystemDelegatorsHub = new rootSuiteXChainHub('h', 1, 'd', 'u', 'p', null);
    });
    registerFeature12subsystemDelegatorsPart1();
    registerFeature12subsystemDelegatorsPart2();
  });
}
let feature13dBQueryWrappersHub;
function registerFeature13dBQueryWrappersPart1() {
  it('getConfigWatermark / getLastSeq delegate to the DB layer', async function () {
    rootSuiteMockDb.getConfigWatermark = sinon.stub().resolves(1700000000);
    rootSuiteMockDb.getLastSeq = sinon.stub().resolves(42);
    expect(await feature13dBQueryWrappersHub.getConfigWatermark()).to.equal(1700000000);
    expect(await feature13dBQueryWrappersHub.getLastSeq()).to.equal(42);
  });
  it('getPriceSnapshots and getPrice issue the expected queries', async function () {
    rootSuiteMockDb.doQuery.resolves([{
      coin_pair: 'BTC/USD'
    }]);
    await feature13dBQueryWrappersHub.getPriceSnapshots(5);
    expect(rootSuiteMockDb.doQuery.getCall(0).args[1]).to.deep.equal([5]);
    expect(rootSuiteMockDb.doQuery.getCall(0).args[0]).to.include('price_snapshots');
    // Default stays finalized-only (fee/price consumers unchanged);
    // status='all' additionally returns skipped/disputed rows so
    // health/monitoring consumers can see stall/fork states (#180 seam).
    expect(rootSuiteMockDb.doQuery.getCall(0).args[0]).to.include("status = 'finalized'");
    rootSuiteMockDb.doQuery.resetHistory();
    rootSuiteMockDb.doQuery.resolves([{
      coin_pair: 'BTC/USD'
    }]);
    await feature13dBQueryWrappersHub.getPriceSnapshots(5, 'all');
    expect(rootSuiteMockDb.doQuery.getCall(0).args[0]).to.include('price_snapshots');
    expect(rootSuiteMockDb.doQuery.getCall(0).args[0]).to.not.include("status = 'finalized'");
    expect(rootSuiteMockDb.doQuery.getCall(0).args[1]).to.deep.equal([5]);
    rootSuiteMockDb.doQuery.resetHistory();
    rootSuiteMockDb.doQuery.resolves([{
      coin_pair: 'BTC/USD'
    }]);
    expect(await feature13dBQueryWrappersHub.getPrice('BTC/USD')).to.deep.equal({
      coin_pair: 'BTC/USD'
    });
    rootSuiteMockDb.doQuery.resetHistory();
    rootSuiteMockDb.doQuery.resolves([]);
    expect(await feature13dBQueryWrappersHub.getPrice('NONE/USD')).to.be.null;
  });
  it('registerValidator validates pubkey + addr, then reloads', async function () {
    try {
      await feature13dBQueryWrappersHub.registerValidator('bad', 'ws://v:1');
      expect.fail('throw');
    } catch (e) {
      expect(e.message).to.include('Invalid signing pubkey');
    }
    try {
      await feature13dBQueryWrappersHub.registerValidator('ab'.repeat(32), '');
      expect.fail('throw');
    } catch (e) {
      expect(e.message).to.include('addr is required');
    }
    rootSuiteMockDb.doQuery.resolves([]);
    expect(await feature13dBQueryWrappersHub.registerValidator('ab'.repeat(32), 'ws://v:1')).to.equal(true);
    let insert = rootSuiteMockDb.doQuery.getCalls().find(c => /INSERT INTO validators/.test(c.args[0]));
    expect(insert).to.exist;
  });
}
function registerFeature13dBQueryWrappersPart2() {
  it('syncValidators rejects non-arrays, skips invalid entries, inserts valid ones', async function () {
    try {
      await feature13dBQueryWrappersHub.syncValidators('nope');
      expect.fail('throw');
    } catch (e) {
      expect(e.message).to.include('must be an array');
    }
    rootSuiteMockDb.doQuery.resolves([]);
    await feature13dBQueryWrappersHub.syncValidators([{
      signing_pubkey: 'cd'.repeat(32),
      addr: 'ws://v:1'
    }, {
      signing_pubkey: 'bad',
      addr: 'ws://v:2'
    },
    // skipped (bad pubkey)
    {
      signing_pubkey: 'ef'.repeat(32)
    } // skipped (no addr)
    ]);
    let inserts = rootSuiteMockDb.doQuery.getCalls().filter(c => /INSERT INTO validators/.test(c.args[0]));
    expect(inserts).to.have.length(1);
  });
  it('getValidators queries active validators', async function () {
    rootSuiteMockDb.doQuery.resolves([{
      addr: 'a'
    }]);
    await feature13dBQueryWrappersHub.getValidators();
    expect(rootSuiteMockDb.doQuery.getCall(0).args[0]).to.include("status = 'active'");
  });

  // the documented getvalidators response carries `chains`
  // (components/hub/api.md), and the explorer folds addr/chains/status onto
  // its on-chain /validators table. Dropping the column from the SELECT
  // blanks the served chains everywhere downstream.
  it('getValidators selects the registry addr, chains and status columns', async function () {
    rootSuiteMockDb.doQuery.resolves([{
      addr: 'a'
    }]);
    await feature13dBQueryWrappersHub.getValidators();
    let query = rootSuiteMockDb.doQuery.getCall(0).args[0];
    for (const col of ['signing_pubkey', 'addr', 'chains', 'status']) expect(query).to.include(col);
  });
}
function registerFeature13dBQueryWrappersPart3() {
  it('getValidatorStatus returns null when unknown, full status when known', async function () {
    rootSuiteMockDb.doQuery.resolves([]);
    expect(await feature13dBQueryWrappersHub.getValidatorStatus('ab'.repeat(32))).to.be.null;
    rootSuiteMockDb.doQuery.resolves([{
      signing_pubkey: 'ab'.repeat(32)
    }]);
    feature13dBQueryWrappersHub.rewardTracker = {
      getUnclaimedRewards: sinon.stub().resolves('5'),
      getRewardHistory: sinon.stub().resolves([{
        r: 1
      }])
    };
    feature13dBQueryWrappersHub.slashDetector = {
      getProposalsForValidator: sinon.stub().resolves([{
        s: 1
      }])
    };
    let st = await feature13dBQueryWrappersHub.getValidatorStatus('ab'.repeat(32));
    expect(st.unclaimedRewards).to.equal('5');
    expect(st.recentRewards).to.deep.equal([{
      r: 1
    }]);
    expect(st.slashProposals).to.deep.equal([{
      s: 1
    }]);
  });
  it('getValidatorStatus defaults rewards/slashes when those subsystems are absent', async function () {
    rootSuiteMockDb.doQuery.resolves([{
      signing_pubkey: 'ab'.repeat(32)
    }]);
    let st = await feature13dBQueryWrappersHub.getValidatorStatus('ab'.repeat(32));
    expect(st.unclaimedRewards).to.equal('0');
    expect(st.recentRewards).to.deep.equal([]);
    expect(st.slashProposals).to.deep.equal([]);
  });
}
function registerFeature13dBQueryWrappers() {
  describe('DB query wrappers', function () {
    beforeEach(function () {
      feature13dBQueryWrappersHub = new rootSuiteXChainHub('h', 1, 'd', 'u', 'p', null);
      feature13dBQueryWrappersHub.db = rootSuiteMockDb;
    });
    registerFeature13dBQueryWrappersPart1();
    registerFeature13dBQueryWrappersPart2();
    registerFeature13dBQueryWrappersPart3();
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
  registerFeature11subsystemGetters();
  registerFeature12subsystemDelegators();
  registerFeature13dBQueryWrappers();
});
