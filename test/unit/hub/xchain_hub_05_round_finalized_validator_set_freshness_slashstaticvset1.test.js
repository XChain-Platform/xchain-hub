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

function feature18roundFinalizedValidatorSetFreshnessSLASHSTATICVSET1MakeOracleStubs() {
  const handlers = {};
  const oracleConsensus = {
    setValidatorSet: sinon.stub(),
    on: (evt, fn) => {
      handlers[evt] = fn;
    },
    start: sinon.stub().resolves()
  };
  const slashDetector = {
    checkRound: sinon.stub().resolves()
  };
  return {
    handlers,
    oracleConsensus,
    slashDetector,
    modules: {
      './db': function () {
        return rootSuiteMockDb;
      },
      './oracle/consensus.js': function () {
        return oracleConsensus;
      },
      './oracle/round.js': function () {
        return {
          setConsensus: sinon.stub(),
          start: sinon.stub().resolves()
        };
      },
      './anchor/reward_tracker.js': function () {
        return {
          distributeRewards: sinon.stub().resolves()
        };
      },
      './validators/slash_detector.js': function () {
        return slashDetector;
      },
      // Stubbed here too: this describe block is about validator-set
      // freshness, not the signing round, and the fixture peerManager
      // below has no .on(), which the real OracleBatchSigner.start()
      // would call.
      './oracle/batch_signer.js': function () {
        return {
          start: sinon.stub().resolves(),
          stop: sinon.stub().resolves(),
          getStats: sinon.stub().returns({})
        };
      },
      './oracle/publisher.js': function () {
        return {
          start: sinon.stub().resolves()
        };
      },
      './lib/signer_loader.js': {
        loadSignerHooks: () => null,
        applySignerHooks: () => {}
      }
    }
  };
}
function feature18roundFinalizedValidatorSetFreshnessSLASHSTATICVSET1FinalizedEvent(round) {
  return {
    round,
    submissions: new Map(),
    prices: [],
    participants: [],
    btcBlockHeight: 1
  };
}
function registerFeature18roundFinalizedValidatorSetFreshnessSLASHSTATICVSET1Part1() {
  it('re-loads the validator set per finalized round so rotated-in validators are slashable', async function () {
    this.timeout(30000);
    const stubs = feature18roundFinalizedValidatorSetFreshnessSLASHSTATICVSET1MakeOracleStubs();
    const Hub = proxyquire('../../../src/XChainHub', stubs.modules);
    let hub = new Hub('h', 1, 'd', 'u', 'p', {
      P2P_PORT: 10001
    });
    hub.peerManager = {
      validatorPubkeys: new Map()
    };
    const stale = [{
      pubkey: 'pk1',
      addr: 'a1'
    }];
    const fresh = [{
      pubkey: 'pk1',
      addr: 'a1'
    }, {
      pubkey: 'pk2',
      addr: 'a2'
    }];
    const load = sinon.stub(hub, 'loadValidatorSet');
    load.resolves(fresh); // per-round reloads see the current set
    load.onFirstCall().resolves(stale); // startOracle() sees the boot-time set

    await hub.startOracle();
    await stubs.handlers['round:finalized'](feature18roundFinalizedValidatorSetFreshnessSLASHSTATICVSET1FinalizedEvent(7));

    // Slashing must be evaluated against the freshly loaded set, not
    // the set captured at startOracle() time.
    expect(stubs.slashDetector.checkRound.calledOnce).to.be.true;
    expect(stubs.slashDetector.checkRound.getCall(0).args[4]).to.deep.equal(fresh);
  });
}
function registerFeature18roundFinalizedValidatorSetFreshnessSLASHSTATICVSET1Part2() {
  it('falls back to the last-known-good set when the per-round reload fails', async function () {
    this.timeout(30000);
    const stubs = feature18roundFinalizedValidatorSetFreshnessSLASHSTATICVSET1MakeOracleStubs();
    const Hub = proxyquire('../../../src/XChainHub', stubs.modules);
    let hub = new Hub('h', 1, 'd', 'u', 'p', {
      P2P_PORT: 10001
    });
    hub.peerManager = {
      validatorPubkeys: new Map()
    };
    const fresh = [{
      pubkey: 'pk1',
      addr: 'a1'
    }, {
      pubkey: 'pk2',
      addr: 'a2'
    }];
    const load = sinon.stub(hub, 'loadValidatorSet');
    load.onFirstCall().resolves([{
      pubkey: 'pk1',
      addr: 'a1'
    }]); // startOracle()
    load.onSecondCall().resolves(fresh); // round 1 reload
    load.onThirdCall().resolves([]); // round 2 reload fails (DB error path returns [])

    await hub.startOracle();
    await stubs.handlers['round:finalized'](feature18roundFinalizedValidatorSetFreshnessSLASHSTATICVSET1FinalizedEvent(1));
    await stubs.handlers['round:finalized'](feature18roundFinalizedValidatorSetFreshnessSLASHSTATICVSET1FinalizedEvent(2));
    expect(stubs.slashDetector.checkRound.callCount).to.equal(2);
    expect(stubs.slashDetector.checkRound.getCall(1).args[4]).to.deep.equal(fresh);
  });
}
function registerFeature18roundFinalizedValidatorSetFreshnessSLASHSTATICVSET1() {
  describe('round:finalized validator-set freshness (SLASH-STATIC-VSET-1)', function () {
    registerFeature18roundFinalizedValidatorSetFreshnessSLASHSTATICVSET1Part1();
    registerFeature18roundFinalizedValidatorSetFreshnessSLASHSTATICVSET1Part2();
  });
}
// Every OTHER oracle dependency is stubbed so this suite exercises the
// hub's wiring, not their internals. OracleBatchSigner itself is
// deliberately left un-stubbed (the real './OracleBatchSigner.js' is
// required): the row this covers is "the hub constructs the REAL class",
// so a fake standing in for it would prove nothing.
function feature19startOracleWiresOracleBatchSignerBatchSignerDeps() {
  return {
    './db': function () {
      return rootSuiteMockDb;
    },
    './oracle/consensus.js': function () {
      return {
        setValidatorSet: sinon.stub(),
        on: sinon.stub(),
        start: sinon.stub().resolves(),
        stop: sinon.stub().resolves()
      };
    },
    './oracle/round.js': function () {
      return {
        setConsensus: sinon.stub(),
        start: sinon.stub().resolves(),
        stop: sinon.stub().resolves()
      };
    },
    './anchor/reward_tracker.js': function () {
      return {
        distributeRewards: sinon.stub().resolves()
      };
    },
    './validators/slash_detector.js': function () {
      return {
        checkRound: sinon.stub().resolves()
      };
    },
    './oracle/publisher.js': function () {
      return {
        start: sinon.stub().resolves()
      };
    },
    './lib/signer_loader.js': {
      loadSignerHooks: () => null,
      applySignerHooks: () => {}
    }
  };
}
function registerFeature19startOracleWiresOracleBatchSignerPart1() {
  it('constructs, starts, subscribes and cleanly stops OracleBatchSigner on a hub running oracle consensus', async function () {
    this.timeout(30000);
    const Hub = proxyquire('../../../src/XChainHub', feature19startOracleWiresOracleBatchSignerBatchSignerDeps());
    let hub = new Hub('h', 1, 'd', 'u', 'p', {
      P2P_PORT: 10001
    });
    sinon.stub(hub, 'loadValidatorSet').resolves([]);
    const handlers = new Map();
    hub.peerManager = {
      on: sinon.stub().callsFake((evt, fn) => handlers.set(evt, fn)),
      removeListener: sinon.stub(),
      stop: sinon.stub().resolves(),
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
    hub.db = {
      close: sinon.stub().resolves()
    };
    await hub.close();

    // Stopped cleanly: the SAME handler instance is unsubscribed.
    expect(hub.peerManager.removeListener.calledOnceWith('message', messageHandler)).to.be.true;
  });
  it('starts and stops with no OracleBatchSigner on a hub not running oracle consensus', async function () {
    const Hub = proxyquire('../../../src/XChainHub', feature19startOracleWiresOracleBatchSignerBatchSignerDeps());
    let hub = new Hub('h', 1, 'd', 'u', 'p', null); // no p2pConfig -> no peerManager

    await hub.startOracle();
    expect(hub.oracleBatchSigner).to.be.null;
    hub.db = {
      close: sinon.stub().resolves()
    };
    await hub.close(); // must not throw with no signer ever started
    expect(hub.oracleBatchSigner).to.be.null;
  });
}
function registerFeature19startOracleWiresOracleBatchSigner() {
  describe('startOracle() wires OracleBatchSigner', function () {
    registerFeature19startOracleWiresOracleBatchSignerPart1();
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
  registerFeature18roundFinalizedValidatorSetFreshnessSLASHSTATICVSET1();
  registerFeature19startOracleWiresOracleBatchSigner();
});
