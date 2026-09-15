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

let feature17pureHelpersCloseHub;
function registerFeature17pureHelpersClosePart1() {
  it('btcIndexerHeaders includes x-api-key only when configured', function () {
    delete process.env.BTC_INDEXER_API_KEY;
    expect(feature17pureHelpersCloseHub.btcIndexerHeaders()).to.not.have.property('x-api-key');
    process.env.BTC_INDEXER_API_KEY = 'fixture';
    expect(feature17pureHelpersCloseHub.btcIndexerHeaders()['x-api-key']).to.equal('fixture');
    delete process.env.BTC_INDEXER_API_KEY;
  });
  it('_resolveBtcIndexerUrl prefers BTC_INDEXER_API_URL, falls back to BTC_INDEXER_URL, then configs', async function () {
    delete process.env.BTC_INDEXER_API_URL;
    delete process.env.BTC_INDEXER_URL;
    feature17pureHelpersCloseHub.db = rootSuiteMockDb;
    rootSuiteMockDb.getAllConfigs.resolves({
      bitcoin: {
        regtest: {
          'xchain-indexer': {
            host: 'cfg-host',
            port: 4001
          }
        }
      }
    });
    expect(await feature17pureHelpersCloseHub._resolveBtcIndexerUrl()).to.equal('http://cfg-host:4001');

    // The footgun: a hub configured with only BTC_INDEXER_URL silently
    // fell to seed-local capability snapshots (quorum-0 self-sign).
    process.env.BTC_INDEXER_URL = 'http://alias:4000';
    expect(await feature17pureHelpersCloseHub._resolveBtcIndexerUrl()).to.equal('http://alias:4000');
    process.env.BTC_INDEXER_API_URL = 'http://canonical:4000';
    expect(await feature17pureHelpersCloseHub._resolveBtcIndexerUrl()).to.equal('http://canonical:4000');
    delete process.env.BTC_INDEXER_API_URL;
    delete process.env.BTC_INDEXER_URL;
  });
  it('parseDecimalParts parses decimals and rejects junk', function () {
    expect(feature17pureHelpersCloseHub.parseDecimalParts('12.50')).to.deep.equal({
      neg: false,
      int: '12',
      frac: '50'
    });
    expect(feature17pureHelpersCloseHub.parseDecimalParts('-3')).to.deep.equal({
      neg: true,
      int: '3',
      frac: ''
    });
    expect(feature17pureHelpersCloseHub.parseDecimalParts('+.5')).to.deep.equal({
      neg: false,
      int: '0',
      frac: '5'
    });
    expect(feature17pureHelpersCloseHub.parseDecimalParts('-0.0')).to.deep.equal({
      neg: false,
      int: '0',
      frac: '0'
    }); // negative-zero normalised
    expect(feature17pureHelpersCloseHub.parseDecimalParts('abc')).to.be.null;
    expect(feature17pureHelpersCloseHub.parseDecimalParts(null)).to.be.null;
  });
}
function registerFeature17pureHelpersClosePart2() {
  it('compareDecimal orders values exactly (incl. signs and scale)', function () {
    expect(feature17pureHelpersCloseHub.compareDecimal('10', '10.00')).to.equal(0);
    expect(feature17pureHelpersCloseHub.compareDecimal('1.5', '1.50001')).to.equal(-1);
    expect(feature17pureHelpersCloseHub.compareDecimal('2', '1.9')).to.equal(1);
    expect(feature17pureHelpersCloseHub.compareDecimal('-5', '3')).to.equal(-1); // different signs
    expect(feature17pureHelpersCloseHub.compareDecimal('-2', '-9')).to.equal(1); // both negative
    expect(feature17pureHelpersCloseHub.compareDecimal('abc', '1')).to.equal(0); // unparseable → 0
  });
  it('close() clears timers and stops every active subsystem', async function () {
    feature17pureHelpersCloseHub._capabilityRecheckTimer = setInterval(() => {}, 60000);
    feature17pureHelpersCloseHub._stakePollTimer = setInterval(() => {}, 60000);
    feature17pureHelpersCloseHub.governance = {
      stop: sinon.stub().resolves()
    };
    feature17pureHelpersCloseHub.reorgHandler = {
      stop: sinon.stub().resolves()
    };
    feature17pureHelpersCloseHub.crossChain = {
      stop: sinon.stub().resolves()
    };
    feature17pureHelpersCloseHub.oracle = {
      stop: sinon.stub().resolves()
    };
    feature17pureHelpersCloseHub.oracleConsensus = {
      stop: sinon.stub().resolves()
    };
    feature17pureHelpersCloseHub.consensus = {
      stop: sinon.stub().resolves()
    };
    feature17pureHelpersCloseHub.peerManager = {
      stop: sinon.stub().resolves()
    };
    feature17pureHelpersCloseHub.db = {
      close: sinon.stub().resolves()
    };
    await feature17pureHelpersCloseHub.close();
    expect(feature17pureHelpersCloseHub._capabilityRecheckTimer).to.be.null;
    expect(feature17pureHelpersCloseHub._stakePollTimer).to.be.null;
    expect(feature17pureHelpersCloseHub.governance.stop.calledOnce).to.be.true;
    expect(feature17pureHelpersCloseHub.peerManager.stop.calledOnce).to.be.true;
    expect(feature17pureHelpersCloseHub.db.close.calledOnce).to.be.true;
  });

  // Row: close() stops every attestation engine it started. Before this,
  // close() only detached the mirror and the batch publisher (their own
  // rows), leaving the publisher, spot checker, round, full-node challenge
  // and relay listening past a close. A same-process restart then leaves the
  // request:finalized listener from the PRIOR cycle's (now orphaned) consensus
  // instance still attached, which is the leak this guards against.
}
function registerFeature17pureHelpersClosePart3() {
  // Row: close() stops every attestation engine it started. Before this,
  // close() only detached the mirror and the batch publisher (their own
  // rows), leaving the publisher, spot checker, round, full-node challenge
  // and relay listening past a close. A same-process restart then leaves the
  // request:finalized listener from the PRIOR cycle's (now orphaned) consensus
  // instance still attached, which is the leak this guards against.
  it('close() stops the publisher, spot checker, round, full-node challenge and relay', async function () {
    feature17pureHelpersCloseHub.db = {
      close: sinon.stub().resolves()
    };
    feature17pureHelpersCloseHub.attestationPublisher = {
      stop: sinon.stub().resolves()
    };
    feature17pureHelpersCloseHub.attestationSpotChecker = {
      stop: sinon.stub().resolves()
    };
    feature17pureHelpersCloseHub.attestationRound = {
      stop: sinon.stub().resolves()
    };
    feature17pureHelpersCloseHub.fullNodeChallenge = {
      stop: sinon.stub().resolves()
    };
    feature17pureHelpersCloseHub.attestationRelay = {
      stop: sinon.stub().resolves()
    };
    await feature17pureHelpersCloseHub.close();
    expect(feature17pureHelpersCloseHub.attestationPublisher.stop.calledOnce).to.be.true;
    expect(feature17pureHelpersCloseHub.attestationSpotChecker.stop.calledOnce).to.be.true;
    expect(feature17pureHelpersCloseHub.attestationRound.stop.calledOnce).to.be.true;
    expect(feature17pureHelpersCloseHub.fullNodeChallenge.stop.calledOnce).to.be.true;
    expect(feature17pureHelpersCloseHub.attestationRelay.stop.calledOnce).to.be.true;
  });

  // A restart within one process reuses the hub instance: close() must be
  // safe to call more than once (an operator retry, or a caller that awaits
  // close() from two paths), and a fresh startAttestation() must not find any
  // request:finalized listener still attached to the PRIOR cycle's consensus.
}
function registerFeature17pureHelpersClosePart4() {
  // A restart within one process reuses the hub instance: close() must be
  // safe to call more than once (an operator retry, or a caller that awaits
  // close() from two paths), and a fresh startAttestation() must not find any
  // request:finalized listener still attached to the PRIOR cycle's consensus.
  it('close() is safe to call twice, and a close-then-reopen cycle leaves no extra request:finalized listener', async function () {
    feature17pureHelpersCloseHub.db = {
      close: sinon.stub().resolves()
    };

    // A minimal stand-in for an engine that behaves the way the real
    // publisher/spot-checker/mirror do: it attaches on "start" and its
    // stop() detaches the SAME handler, which is exactly what close()
    // is responsible for invoking.
    function attach(consensus) {
      let handler = () => {};
      consensus.on('request:finalized', handler);
      return {
        stop: sinon.stub().callsFake(async () => consensus.removeListener('request:finalized', handler))
      };
    }
    for (let cycle = 0; cycle < 2; cycle++) {
      let consensus = new EventEmitter();
      consensus.stop = sinon.stub().resolves();
      feature17pureHelpersCloseHub.attestationConsensus = consensus;
      feature17pureHelpersCloseHub.attestationPublisher = attach(consensus);
      feature17pureHelpersCloseHub.attestationSpotChecker = attach(consensus);
      feature17pureHelpersCloseHub.attestationResponseMirror = attach(consensus);
      feature17pureHelpersCloseHub.attestationBatchPublisher = {
        stop: sinon.stub().resolves()
      };
      feature17pureHelpersCloseHub.attestationRound = {
        stop: sinon.stub().resolves()
      };
      feature17pureHelpersCloseHub.fullNodeChallenge = {
        stop: sinon.stub().resolves()
      };
      feature17pureHelpersCloseHub.attestationRelay = {
        stop: sinon.stub().resolves()
      };
      expect(consensus.listenerCount('request:finalized'), 'cycle ' + cycle + ' before close').to.equal(3);
      await feature17pureHelpersCloseHub.close();
      await feature17pureHelpersCloseHub.close(); // double-close must not throw or double-detach

      expect(consensus.listenerCount('request:finalized'), 'cycle ' + cycle + ' after close').to.equal(0);
    }
  });

  // Row: attestationConsensus keeps its own peer-manager 'message' listener
  // across close(), the leak class row above closed for the other five
  // engines. A mirror venue stops and restarts a hub per cycle, so a
  // rising listener count here corrupts exactly that run.
}
function registerFeature17pureHelpersClosePart5() {
  // Row: attestationConsensus keeps its own peer-manager 'message' listener
  // across close(), the leak class row above closed for the other five
  // engines. A mirror venue stops and restarts a hub per cycle, so a
  // rising listener count here corrupts exactly that run.
  it('close() stops attestationConsensus, leaving no peer-manager listener across repeated close/reopen cycles', async function () {
    feature17pureHelpersCloseHub.db = {
      close: sinon.stub().resolves()
    };
    let peerManager = new EventEmitter();
    peerManager.stop = sinon.stub().resolves();
    feature17pureHelpersCloseHub.peerManager = peerManager;
    for (let cycle = 0; cycle < 3; cycle++) {
      let consensus = new AttestationConsensus(feature17pureHelpersCloseHub, null);
      await consensus.start();
      feature17pureHelpersCloseHub.attestationConsensus = consensus;
      expect(peerManager.listenerCount('message'), 'cycle ' + cycle + ' before close').to.equal(1);
      await feature17pureHelpersCloseHub.close();
      await feature17pureHelpersCloseHub.close(); // double-close must not throw or double-detach

      expect(peerManager.listenerCount('message'), 'cycle ' + cycle + ' after close').to.equal(0);
    }
  });
}
function registerFeature17pureHelpersClose() {
  describe('pure helpers + close()', function () {
    beforeEach(function () {
      feature17pureHelpersCloseHub = new rootSuiteXChainHub('h', 1, 'd', 'u', 'p', null);
    });
    registerFeature17pureHelpersClosePart1();
    registerFeature17pureHelpersClosePart2();
    registerFeature17pureHelpersClosePart3();
    registerFeature17pureHelpersClosePart4();
    registerFeature17pureHelpersClosePart5();
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
  registerFeature17pureHelpersClose();
});
