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

function feature20startAttestationSignerWiringMakeAttestationStubs() {
  const publisher = {
    start: sinon.stub().resolves(),
    setWalletSignHook: sinon.stub(),
    setBroadcastHook: sinon.stub()
  };
  return {
    publisher,
    modules: {
      './validators/provider_registry.js': function () {
        return {
          load: sinon.stub().resolves(),
          loadGovernanceHistory: sinon.stub().resolves(),
          listProviderIds: sinon.stub().returns([])
        };
      },
      './attestation/consensus.js': function () {
        return {
          start: sinon.stub().resolves(),
          on: sinon.stub()
        };
      },
      './attestation/round.js': function () {
        return {
          start: sinon.stub().resolves(),
          setConsensus: sinon.stub()
        };
      },
      './attestation/publisher.js': function () {
        return publisher;
      },
      './attestation/spot_checker.js': function () {
        return {
          start: sinon.stub().resolves()
        };
      }
    }
  };
}
function registerFeature20startAttestationSignerWiringPart1() {
  it('applies HUB_SIGNER_MODULE hooks to the attestation publisher', async function () {
    this.timeout(30000);
    const realLoader = require('../../src/lib/signer_loader.js');
    const fakeHooks = {
      source: 'fake-signer',
      walletSignFn: sinon.stub(),
      broadcastFn: sinon.stub(),
      getBalanceFn: null
    };
    const stubs = feature20startAttestationSignerWiringMakeAttestationStubs();
    const HubWithSigner = proxyquire('../../src/XChainHub', Object.assign({
      './db': function () {
        return rootSuiteMockDb;
      },
      './lib/signer_loader.js': {
        loadSignerHooks: () => fakeHooks,
        applySignerHooks: realLoader.applySignerHooks
      }
    }, stubs.modules));
    let hub = new HubWithSigner('host', 3306, 'db', 'user', 'pass', {
      P2P_PORT: 10001,
      HUB_NETWORK: 'regtest'
    });
    hub.peerManager = {
      on: () => {}
    }; // startAttestation now starts FullNodeChallengeRound, which registers a peerManager 'message' handler
    await hub.startAttestation();
    expect(stubs.publisher.setWalletSignHook.calledOnceWith(fakeHooks.walletSignFn)).to.be.true;
    expect(stubs.publisher.setBroadcastHook.calledOnceWith(fakeHooks.broadcastFn)).to.be.true;
    expect(stubs.publisher.start.calledOnce).to.be.true;
  });
  it('starts cleanly with no signer configured (hooks null)', async function () {
    this.timeout(30000);
    const stubs = feature20startAttestationSignerWiringMakeAttestationStubs();
    const HubNoSigner = proxyquire('../../src/XChainHub', Object.assign({
      './db': function () {
        return rootSuiteMockDb;
      },
      './lib/signer_loader.js': {
        loadSignerHooks: () => null,
        applySignerHooks: () => {
          throw new Error('must not be called');
        }
      }
    }, stubs.modules));
    let hub = new HubNoSigner('host', 3306, 'db', 'user', 'pass', {
      P2P_PORT: 10001,
      HUB_NETWORK: 'regtest'
    });
    hub.peerManager = {
      on: () => {}
    }; // startAttestation now starts FullNodeChallengeRound, which registers a peerManager 'message' handler
    await hub.startAttestation();
    expect(stubs.publisher.setWalletSignHook.called).to.be.false;
    expect(stubs.publisher.start.calledOnce).to.be.true;
  });
}
function registerFeature20startAttestationSignerWiring() {
  describe('startAttestation() signer wiring', function () {
    registerFeature20startAttestationSignerWiringPart1();
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
  registerFeature20startAttestationSignerWiring();
});
