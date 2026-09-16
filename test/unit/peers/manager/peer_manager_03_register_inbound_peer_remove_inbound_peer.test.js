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
function registerFeature13registerInboundPeerRemoveInboundPeerPart1() {
  it('keeps an existing outbound connection when an inbound arrives for the same addr', function () {
    let outboundWs = {
      readyState: 1
    };
    rootSuitePm.peers.set('ws://p:1', {
      ws: outboundWs,
      inbound: false,
      state: 'open'
    });
    let inboundWs = {};
    rootSuitePm.registerInboundPeer(inboundWs, 'ws://p:1');
    expect(rootSuitePm.peers.get('ws://p:1').ws).to.equal(outboundWs); // outbound preserved
    expect(inboundWs._peerAddr).to.equal('ws://p:1');
  });
  it('registers a brand-new inbound peer', function () {
    let connected = null;
    rootSuitePm.on('peer:connect', a => {
      connected = a;
    });
    rootSuitePm.registerInboundPeer({}, 'ws://p:2');
    expect(rootSuitePm.peers.get('ws://p:2').inbound).to.be.true;
    expect(connected).to.equal('ws://p:2');
  });
  it('removeInboundPeer returns quietly when the ws has no addr', function () {
    expect(() => rootSuitePm.removeInboundPeer({
      _peerAddr: null
    })).to.not.throw();
  });
  it('removeInboundPeer deletes the peer, emits disconnect, and decrements the IP count', function () {
    let ws = {
      _peerAddr: 'ws://p:1',
      _remoteIp: '1.2.3.4'
    };
    rootSuitePm.peers.set('ws://p:1', {
      ws,
      inbound: true,
      state: 'open'
    });
    rootSuitePm.ipConnectionCounts.set('1.2.3.4', 2);
    let dis = null;
    rootSuitePm.on('peer:disconnect', a => {
      dis = a;
    });
    rootSuitePm.removeInboundPeer(ws);
    expect(rootSuitePm.peers.has('ws://p:1')).to.be.false;
    expect(dis).to.equal('ws://p:1');
    expect(rootSuitePm.ipConnectionCounts.get('1.2.3.4')).to.equal(1);
  });
}
function registerFeature13registerInboundPeerRemoveInboundPeerPart2() {
  it('removeInboundPeer clears the IP entry when the count reaches zero', function () {
    let ws = {
      _peerAddr: 'ws://p:1',
      _remoteIp: '5.6.7.8'
    };
    rootSuitePm.peers.set('ws://p:1', {
      ws,
      inbound: true,
      state: 'open'
    });
    rootSuitePm.ipConnectionCounts.set('5.6.7.8', 1);
    rootSuitePm.removeInboundPeer(ws);
    expect(rootSuitePm.ipConnectionCounts.has('5.6.7.8')).to.be.false;
  });

  // The per-IP count is incremented for every ACCEPTED socket, but ws._peerAddr
  // is only set once a frame has passed signature verification, so a socket that
  // closes before authenticating once kept its increment forever and marched the
  // IP to maxConnectionsPerIp.
  it('removeInboundPeer releases the IP count for a socket that closed before authenticating', function () {
    let ws = {
      _peerAddr: null,
      _remoteIp: '9.9.9.9'
    };
    rootSuitePm.ipConnectionCounts.set('9.9.9.9', 1);
    rootSuitePm.removeInboundPeer(ws);
    expect(rootSuitePm.ipConnectionCounts.has('9.9.9.9')).to.be.false;
  });
  it('removeInboundPeer does not double-decrement when invoked twice for one socket', function () {
    let ws = {
      _peerAddr: null,
      _remoteIp: '7.7.7.7'
    };
    rootSuitePm.ipConnectionCounts.set('7.7.7.7', 2);
    rootSuitePm.removeInboundPeer(ws);
    rootSuitePm.removeInboundPeer(ws);
    expect(rootSuitePm.ipConnectionCounts.get('7.7.7.7')).to.equal(1);
  });
  it('repeated pre-auth connect/close cycles never reach the per-IP cap', function () {
    let ip = '203.0.113.77';
    for (let i = 0; i < rootSuitePm.maxConnectionsPerIp + 5; i++) {
      let count = rootSuitePm.ipConnectionCounts.get(ip) || 0;
      expect(count).to.be.below(rootSuitePm.maxConnectionsPerIp);
      rootSuitePm.ipConnectionCounts.set(ip, count + 1);
      rootSuitePm.removeInboundPeer({
        _peerAddr: null,
        _remoteIp: ip
      });
    }
    expect(rootSuitePm.ipConnectionCounts.has(ip)).to.be.false;
  });
}
function registerFeature13registerInboundPeerRemoveInboundPeer() {
  describe('registerInboundPeer() / removeInboundPeer()', function () {
    registerFeature13registerInboundPeerRemoveInboundPeerPart1();
    registerFeature13registerInboundPeerRemoveInboundPeerPart2();
  });
}
function registerFeature14connectToPeerScheduleReconnectPart1() {
  it('connectToPeer rejects an invalid address format', function () {
    rootSuitePm.connectToPeer('not-an-addr');
    expect(rootSuitePm.peers.has('not-an-addr')).to.be.false;
  });
  it('connectToPeer is a no-op when already connected/connecting', function () {
    rootSuitePm.peers.set('ws://p:1', {
      state: 'open'
    });
    rootSuitePm.connectToPeer('ws://p:1');
    expect(rootSuitePm.peers.get('ws://p:1').state).to.equal('open'); // untouched
  });
  it('scheduleReconnect does nothing when not running', function () {
    rootSuitePm.running = false;
    rootSuitePm.peers.set('ws://p:1', {
      inbound: false,
      reconnectDelay: 2000
    });
    rootSuitePm.scheduleReconnect('ws://p:1');
    expect(rootSuitePm.peers.get('ws://p:1').reconnectTimer).to.be.undefined;
  });
  it('scheduleReconnect skips inbound peers', function () {
    rootSuitePm.running = true;
    rootSuitePm.peers.set('ws://p:1', {
      inbound: true
    });
    rootSuitePm.scheduleReconnect('ws://p:1');
    expect(rootSuitePm.peers.get('ws://p:1').reconnectTimer).to.be.undefined;
  });
  it('scheduleReconnect arms a timer, doubles the backoff, and reconnects', function () {
    let clock = sinon.useFakeTimers();
    rootSuitePm.running = true;
    let connect = sinon.stub(rootSuitePm, 'connectToPeer');
    rootSuitePm.peers.set('ws://p:1', {
      inbound: false,
      reconnectDelay: 2000
    });
    rootSuitePm.scheduleReconnect('ws://p:1');
    expect(rootSuitePm.peers.get('ws://p:1').reconnectDelay).to.equal(4000); // doubled
    clock.tick(3000); // delay+jitter ∈ [2000,2500) → fires
    expect(connect.calledWith('ws://p:1')).to.be.true;
    clock.restore();
  });
}
function registerFeature14connectToPeerScheduleReconnect() {
  describe('connectToPeer() / scheduleReconnect()', function () {
    registerFeature14connectToPeerScheduleReconnectPart1();
  });
}
const feature15unreachablePeerBackoffAndLoggingTEN_MINUTES = 10 * 60 * 1000;
function registerFeature15unreachablePeerBackoffAndLoggingPart1() {
  it('holds the fast ceiling while a peer has only just started failing', function () {
    let clock = sinon.useFakeTimers();
    sinon.stub(console, 'warn');
    rootSuitePm.running = true;
    sinon.stub(rootSuitePm, 'connectToPeer');
    // At the fast ceiling already, but only one failure deep.
    rootSuitePm.peers.set('ws://p:1', {
      inbound: false,
      reconnectDelay: 60000,
      failures: 0
    });
    rootSuitePm.scheduleReconnect('ws://p:1');
    expect(rootSuitePm.peers.get('ws://p:1').reconnectDelay).to.equal(60000);
    clearTimeout(rootSuitePm.peers.get('ws://p:1').reconnectTimer);
    clock.restore();
  });
  it('lifts the ceiling past a minute once a peer has refused every dial in a row', function () {
    let clock = sinon.useFakeTimers();
    sinon.stub(console, 'warn');
    rootSuitePm.running = true;
    sinon.stub(rootSuitePm, 'connectToPeer');
    // One short of the escalation threshold; this call crosses it.
    rootSuitePm.peers.set('ws://p:1', {
      inbound: false,
      reconnectDelay: 60000,
      failures: 4
    });
    rootSuitePm.scheduleReconnect('ws://p:1');
    expect(rootSuitePm.peers.get('ws://p:1').reconnectDelay).to.be.above(60000);
    clearTimeout(rootSuitePm.peers.get('ws://p:1').reconnectTimer);
    clock.restore();
  });
}
function registerFeature15unreachablePeerBackoffAndLoggingPart2() {
  it('costs a handful of log lines over ten minutes of refusal, not one a minute', function () {
    let clock = sinon.useFakeTimers();
    let warn = sinon.stub(console, 'warn');
    let err = sinon.stub(console, 'error');
    rootSuitePm.running = true;

    // Every dial is refused: the socket errors, then closes, and close is
    // where scheduleReconnect is called from.
    sinon.stub(rootSuitePm, 'connectToPeer').callsFake(function (addr) {
      rootSuitePm.peers.get(addr).lastError = 'connect ECONNREFUSED 10.0.0.1:10001';
      rootSuitePm.scheduleReconnect(addr);
    });

    // A hub that has been up for hours: this peer is already sitting at the
    // one-minute ceiling, which is exactly the state that produced 45 error
    // lines per ten minutes across five validators.
    rootSuitePm.peers.set('ws://v1:10001', {
      inbound: false,
      reconnectDelay: 60000,
      failures: 30,
      lastError: 'connect ECONNREFUSED 10.0.0.1:10001'
    });
    rootSuitePm.scheduleReconnect('ws://v1:10001');
    clock.tick(feature15unreachablePeerBackoffAndLoggingTEN_MINUTES);

    // Ten one-minute retries would be ten lines; escalating backoff keeps it
    // to a few. Five such peers must stay well under the 45 that were measured.
    expect(warn.callCount).to.be.at.most(5);
    expect(err.called).to.be.false;
    let peer = rootSuitePm.peers.get('ws://v1:10001');
    if (peer.reconnectTimer) clearTimeout(peer.reconnectTimer);
    rootSuitePm.running = false;
    clock.restore();
  });
}
function registerFeature15unreachablePeerBackoffAndLoggingPart3() {
  it('a refused dial is stashed and reported once at warn, never at error', async function () {
    let warn = sinon.stub(console, 'warn');
    let err = sinon.stub(console, 'error');
    rootSuitePm.running = true;

    // Loopback discard port: nothing listens, so the connect is refused.
    let addr = '127.0.0.1:9';
    rootSuitePm.connectToPeer(addr);
    // The refusal arrives on the socket's error event, so poll for the stashed
    // error rather than sleeping a fixed span long enough to cover a loaded box.
    await waitUntil(() => (rootSuitePm.peers.get(addr) || {}).lastError, {
      timeoutMs: 5000,
      label: 'the refused dial to be stashed on the peer'
    });
    let peer = rootSuitePm.peers.get(addr);
    if (peer && peer.reconnectTimer) clearTimeout(peer.reconnectTimer);
    rootSuitePm.running = false;
    expect(err.called).to.be.false;
    expect(peer.lastError || '').to.contain('ECONNREFUSED');
    expect(warn.callCount).to.equal(1);
    expect(warn.firstCall.args[0]).to.contain('ECONNREFUSED');
    expect(warn.firstCall.args[0]).to.contain(addr);
  });
  it('a peer that comes back resets the failure count', async function () {
    const WS = require('ws');
    let srv = new WS.Server({
      host: '127.0.0.1',
      port: 0
    });
    await new Promise(res => srv.on('listening', res));
    let addr = '127.0.0.1:' + srv.address().port;
    rootSuitePm.running = true;
    rootSuitePm.peers.set(addr, {
      ws: null,
      state: 'closed',
      lastSeen: null,
      reconnectDelay: 60000,
      reconnectTimer: null,
      inbound: false,
      failures: 9,
      lastError: 'connect ECONNREFUSED'
    });
    rootSuitePm.connectToPeer(addr);
    await new Promise(res => rootSuitePm.once('peer:connect', res));
    let peer = rootSuitePm.peers.get(addr);
    expect(peer.failures).to.equal(0);
    expect(peer.lastError).to.be.null;
    expect(peer.reconnectDelay).to.equal(rootSuiteConfig.P2P_RECONNECT_BASE);
    rootSuitePm.running = false;
    if (peer.ws) peer.ws.terminate();
    await new Promise(res => srv.close(res));
  });
}
function registerFeature15unreachablePeerBackoffAndLogging() {
  describe('unreachable-peer backoff and logging', function () {
    registerFeature15unreachablePeerBackoffAndLoggingPart1();
    registerFeature15unreachablePeerBackoffAndLoggingPart2();
    registerFeature15unreachablePeerBackoffAndLoggingPart3();
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
  registerFeature13registerInboundPeerRemoveInboundPeer();
  registerFeature14connectToPeerScheduleReconnect();
  registerFeature15unreachablePeerBackoffAndLogging();
});
