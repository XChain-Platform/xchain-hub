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

const sinon              = require('sinon');
const { expect }         = require('chai');
const EventEmitter       = require('events');
const ValidatorIdentity  = require('../../../../src/validators/identity');
const PeerManager        = require('../../../../src/peers/manager');
const observability      = require('../../../../src/observability');
const { waitUntil }      = require('../../../helpers/waitUntil');
const { DB_METHODS }     = require('../../../helpers/mockHub');

let rootSuiteConfig, rootSuiteDbStub, rootSuitePm, rootSuiteKeypair;
function feature11handleInboundBranchesMk(type, id, sender) {
  return JSON.stringify({
    id,
    type,
    sender: sender || 'ws://peer:10001',
    timestamp: Date.now(),
    data: {}
  });
}
function registerFeature11handleInboundBranchesPart1() {
  it('ignores non-object JSON and malformed envelopes', function () {
    let emitted = 0;
    rootSuitePm.on('message', () => emitted++);
    rootSuitePm.handleInbound({}, 'null', 'a');
    rootSuitePm.handleInbound({}, '123', 'a');
    rootSuitePm.handleInbound({}, '[1,2]', 'a');
    rootSuitePm.handleInbound({}, JSON.stringify({
      type: 'T'
    }), 'a'); // missing id/sender/ts
    rootSuitePm.handleInbound({}, JSON.stringify({
      id: 'x',
      type: 'T',
      sender: 's',
      timestamp: 'nan'
    }), 'a');
    expect(emitted).to.equal(0);
  });
  it('drops an envelope whose timestamp is outside the freshness window (anti-replay)', function () {
    let emitted = 0;
    rootSuitePm.on('message', () => emitted++);
    let stale = JSON.stringify({
      id: 'stale1',
      type: 'T',
      sender: 'ws://peer:10001',
      timestamp: Date.now() - 400000,
      data: {} // > default 300s skew
    });
    rootSuitePm.handleInbound({
      _peerAddr: 'ws://peer:10001'
    }, stale, 'ws://peer:10001');
    expect(emitted).to.equal(0);
  });
  it('closes a fresh self-connection', function () {
    let closed = null;
    let ws = {
      _peerAddr: null,
      close: (code, reason) => {
        closed = {
          code,
          reason
        };
      }
    };
    rootSuitePm.handleInbound(ws, feature11handleInboundBranchesMk('T', 'self1', rootSuitePm.validatorAddr), null);
    expect(closed.code).to.equal(1000);
  });
}
function registerFeature11handleInboundBranchesPart2() {
  it('drops messages once a peer exceeds the rate limit', function () {
    rootSuitePm.msgRateLimit = 1;
    let emitted = 0;
    rootSuitePm.on('message', () => emitted++);
    let ws = {
      _peerAddr: 'ws://peer:10001'
    };
    rootSuitePm.handleInbound(ws, feature11handleInboundBranchesMk('T', 'a'), 'ws://peer:10001');
    rootSuitePm.handleInbound(ws, feature11handleInboundBranchesMk('T', 'b'), 'ws://peer:10001');
    expect(emitted).to.equal(1);
  });
  it('an established federation peer gets the higher known-peer ceiling (consensus burst not dropped)', function () {
    // The tight anti-spam limit would drop all but the first message; an
    // established peer carrying a PBFT burst must use the higher ceiling so
    // consensus liveness is not throttled.
    rootSuitePm.msgRateLimit = 1;
    rootSuitePm.knownMsgRateLimit = 5;
    rootSuitePm.peers.set('ws://peer:10001', {
      lastSeen: Date.now()
    }); // established
    let emitted = 0;
    rootSuitePm.on('message', () => emitted++);
    let ws = {
      _peerAddr: 'ws://peer:10001'
    };
    for (let i = 0; i < 5; i++) rootSuitePm.handleInbound(ws, feature11handleInboundBranchesMk('T', 'k' + i), 'ws://peer:10001');
    expect(emitted, 'all 5 within the known ceiling (would be 1 at the spam limit)').to.equal(5);
    rootSuitePm.handleInbound(ws, feature11handleInboundBranchesMk('T', 'k5'), 'ws://peer:10001');
    expect(emitted, '6th exceeds even the known ceiling').to.equal(5);
  });
  it('drops messages with an invalid signature when signatures are required', function () {
    rootSuitePm.requireSigs = true;
    rootSuitePm.setValidatorPubkeys(new Map([['ws://peer:10001', rootSuiteKeypair.pubkeyHex]]));
    let emitted = 0;
    rootSuitePm.on('message', () => emitted++);
    let env = {
      id: 'sigbad',
      type: 'T',
      sender: 'ws://peer:10001',
      timestamp: Date.now(),
      data: {},
      sig: 'aa'.repeat(64)
    };
    rootSuitePm.handleInbound({
      _peerAddr: 'ws://peer:10001'
    }, JSON.stringify(env), 'ws://peer:10001');
    expect(emitted).to.equal(0);
  });
}
function registerFeature11handleInboundBranchesPart3() {
  it('emits heartbeat and capability events for the matching message types', function () {
    let hb = null,
      cap = null;
    rootSuitePm.on('heartbeat', (s, t) => {
      hb = {
        s,
        t
      };
    });
    rootSuitePm.on('capability', e => {
      cap = e;
    });
    rootSuitePm.handleInbound({
      _peerAddr: 'ws://peer:10001'
    }, feature11handleInboundBranchesMk('HEARTBEAT', 'h1'), 'ws://peer:10001');
    rootSuitePm.handleInbound({
      _peerAddr: 'ws://peer:10001'
    }, feature11handleInboundBranchesMk('CAPABILITY_ACTIVATED', 'c1'), 'ws://peer:10001');
    expect(hb).to.not.be.null;
    expect(cap).to.not.be.null;
    expect(cap.type).to.equal('CAPABILITY_ACTIVATED');
  });
  it('registers a previously-unknown inbound peer from the first message', function () {
    let ws = {
      _peerAddr: null
    };
    let connected = null;
    rootSuitePm.on('peer:connect', a => {
      connected = a;
    });
    rootSuitePm.handleInbound(ws, feature11handleInboundBranchesMk('T', 'reg1'), null);
    expect(ws._peerAddr).to.equal('ws://peer:10001');
    expect(rootSuitePm.peers.get('ws://peer:10001').inbound).to.be.true;
    expect(connected).to.equal('ws://peer:10001');
  });
  it('updates lastSeen for an already-known peer', function () {
    let ws = {
      _peerAddr: 'ws://peer:10001'
    };
    rootSuitePm.peers.set('ws://peer:10001', {
      ws,
      inbound: true,
      state: 'open',
      lastSeen: 0
    });
    rootSuitePm.handleInbound(ws, feature11handleInboundBranchesMk('T', 'ls1'), 'ws://peer:10001');
    expect(rootSuitePm.peers.get('ws://peer:10001').lastSeen).to.be.greaterThan(0);
  });
}
function registerFeature11handleInboundBranchesPart4() {
  it('unknown-sig inbound naming a known peer in envelope.sender is bounded by msgRateLimit, not knownMsgRateLimit', function () {
    // An attacker with no established transport identity (knownAddr=null,
    // ws._peerAddr=null) sets envelope.sender to a known peer's address.
    // The CEILING decision must use only transport-verified identifiers; the
    // spoofed envelope.sender must be excluded. We verify this by checking
    // the ceiling argument checkMsgRate is called with: it must be
    // msgRateLimit (tight), never knownMsgRateLimit (wide).
    rootSuitePm.msgRateLimit = 5;
    rootSuitePm.knownMsgRateLimit = 100;

    // Register a known peer by address so peers.has() returns true for it.
    rootSuitePm.peers.set('ws://known-peer:10001', {
      lastSeen: Date.now()
    });
    let ceilingSeen = null;
    let origCheck = rootSuitePm.checkMsgRate.bind(rootSuitePm);
    sinon.stub(rootSuitePm, 'checkMsgRate').callsFake(function (peer, ceil) {
      ceilingSeen = ceil;
      return origCheck(peer, ceil);
    });

    // Fresh WS connection with no established transport identity.
    let ws = {
      _peerAddr: null
    };
    let env = JSON.stringify({
      id: 'sp1',
      type: 'T',
      sender: 'ws://known-peer:10001',
      // spoofed
      timestamp: Date.now(),
      data: {}
    });
    rootSuitePm.handleInbound(ws, env, null);

    // The ceiling must be the tight msgRateLimit, not the known-peer ceiling.
    expect(ceilingSeen).to.equal(rootSuitePm.msgRateLimit);
    expect(ceilingSeen).to.not.equal(rootSuitePm.knownMsgRateLimit);
  });
}
function registerFeature11handleInboundBranches() {
  describe('handleInbound() branches', function () {
    registerFeature11handleInboundBranchesPart1();
    registerFeature11handleInboundBranchesPart2();
    registerFeature11handleInboundBranchesPart3();
    registerFeature11handleInboundBranchesPart4();
  });
}
function registerFeature12relayPart1() {
  it('sends to other open peers, skipping the original sender and the source ws', function () {
    let sourceWs = {
      readyState: 1,
      send: sinon.stub()
    };
    let otherWs = {
      readyState: 1,
      send: sinon.stub()
    };
    let senderWs = {
      readyState: 1,
      send: sinon.stub()
    };
    rootSuitePm.peers.set('ws://sender:1', {
      ws: senderWs
    }); // original sender, skipped
    rootSuitePm.peers.set('ws://src:1', {
      ws: sourceWs
    }); // source ws, skipped
    rootSuitePm.peers.set('ws://other:1', {
      ws: otherWs
    });
    rootSuitePm.relay({
      id: 'm',
      type: 'T',
      sender: 'ws://sender:1',
      timestamp: 1,
      data: {}
    }, sourceWs);
    expect(otherWs.send.calledOnce).to.be.true;
    expect(sourceWs.send.called).to.be.false;
    expect(senderWs.send.called).to.be.false;
  });
}
function registerFeature12relay() {
  describe('relay()', function () {
    registerFeature12relayPart1();
  });
}
describe('PeerManager', function () {
  beforeEach(function () {
    rootSuiteKeypair = ValidatorIdentity.generate();
    rootSuiteConfig = {
      P2P_VALIDATOR_ADDR: 'ws://self:10001',
      P2P_PORT: 0,
      // Don't bind
      P2P_HOST: '127.0.0.1',
      SEED_NODES: [],
      REQUIRE_SIGNATURES: false,
      P2P_MSG_DEDUP_TTL: 60000,
      P2P_MAX_PAYLOAD: 1048576,
      P2P_HEARTBEAT_INTERVAL: 15000,
      P2P_RECONNECT_BASE: 2000,
      P2P_RECONNECT_MAX: 60000
    };
    // DB_METHODS gives the double the real named query methods (setP2pPeer
    // among them), each routing through the doQuery stub the tests assert on.
    rootSuiteDbStub = {
      ...DB_METHODS,
      doQuery: sinon.stub().resolves([])
    };
    rootSuitePm = new PeerManager(rootSuiteConfig, rootSuiteDbStub);
  });
  afterEach(function () {
    sinon.restore();
  });

  // -----------------------------------------------------------------
  // buildEnvelope()
  // -----------------------------------------------------------------
  registerFeature11handleInboundBranches();
  registerFeature12relay();
});
