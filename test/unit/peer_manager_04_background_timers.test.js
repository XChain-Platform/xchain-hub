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
const ValidatorIdentity  = require('../../src/validators/identity');
const PeerManager        = require('../../src/peers/manager');
const observability      = require('../../src/observability');
const { waitUntil }      = require('../helpers/waitUntil');
const { DB_METHODS }     = require('../helpers/mockHub');

let rootSuiteConfig, rootSuiteDbStub, rootSuitePm, rootSuiteKeypair;
function registerFeature16backgroundTimersPart1() {
  it('startHeartbeat broadcasts HEARTBEAT on its interval', function () {
    let clock = sinon.useFakeTimers();
    rootSuiteConfig.P2P_HEARTBEAT_INTERVAL = 1000;
    let bcast = sinon.stub(rootSuitePm, 'broadcast');
    rootSuitePm.startHeartbeat();
    clock.tick(1001);
    expect(bcast.calledWith('HEARTBEAT')).to.be.true;
    clearInterval(rootSuitePm.heartbeatTimer);
    clock.restore();
  });
  it('startDedupPruner removes expired ids and keeps live ones', function () {
    let clock = sinon.useFakeTimers();
    rootSuiteConfig.P2P_DEDUP_PRUNE_INTERVAL = 1000;
    rootSuitePm.seenIds.set('old', Date.now() - 1); // expired
    rootSuitePm.seenIds.set('fresh', Date.now() + 100000); // live
    rootSuitePm.startDedupPruner();
    clock.tick(1001);
    expect(rootSuitePm.seenIds.has('old')).to.be.false;
    expect(rootSuitePm.seenIds.has('fresh')).to.be.true;
    clearInterval(rootSuitePm.dedupTimer);
    clock.restore();
  });
}
function registerFeature16backgroundTimersPart2() {
  it('startPingInterval pings live peers/clients and terminates unresponsive ones', function () {
    let clock = sinon.useFakeTimers();
    rootSuiteConfig.P2P_WS_PING_INTERVAL = 1000;
    let liveOut = {
      readyState: 1,
      _isAlive: true,
      ping: sinon.stub(),
      terminate: sinon.stub()
    };
    let liveIn = {
      _isAlive: true,
      ping: sinon.stub(),
      terminate: sinon.stub()
    };
    let deadIn = {
      _isAlive: false,
      ping: sinon.stub(),
      terminate: sinon.stub()
    };
    rootSuitePm.peers.set('ws://live:1', {
      ws: liveOut,
      inbound: false,
      state: 'open'
    });
    rootSuitePm.wss = {
      clients: new Set([liveIn, deadIn])
    };
    rootSuitePm.startPingInterval();
    clock.tick(1001);
    expect(liveOut.ping.called).to.be.true;
    expect(liveOut._isAlive).to.be.false;
    expect(liveIn.ping.called).to.be.true;
    expect(deadIn.terminate.called).to.be.true;
    clearInterval(rootSuitePm.pingTimer);
    clock.restore();
  });
  it('startPingInterval terminates an unresponsive outbound peer', function () {
    let clock = sinon.useFakeTimers();
    rootSuiteConfig.P2P_WS_PING_INTERVAL = 1000;
    let deadOut = {
      readyState: 1,
      _isAlive: false,
      ping: sinon.stub(),
      terminate: sinon.stub()
    };
    rootSuitePm.peers.set('ws://dead:1', {
      ws: deadOut,
      inbound: false,
      state: 'open'
    });
    rootSuitePm.startPingInterval();
    clock.tick(1001);
    expect(deadOut.terminate.called).to.be.true;
    clearInterval(rootSuitePm.pingTimer);
    clock.restore();
  });
}
function registerFeature16backgroundTimers() {
  describe('background timers', function () {
    registerFeature16backgroundTimersPart1();
    registerFeature16backgroundTimersPart2();
  });
}
function registerFeature17addToDedupCheckMsgRateRecordPeerPart1() {
  it('addToDedup evicts the oldest id at the cache cap', function () {
    rootSuitePm.dedupCacheMax = 2;
    rootSuitePm.addToDedup('a');
    rootSuitePm.addToDedup('b');
    rootSuitePm.addToDedup('c');
    expect(rootSuitePm.seenIds.has('a')).to.be.false;
    expect(rootSuitePm.seenIds.size).to.equal(2);
  });
  it('checkMsgRate allows up to the limit, blocks past it, and resets after the window', function () {
    let clock = sinon.useFakeTimers();
    rootSuitePm.msgRateLimit = 2;
    expect(rootSuitePm.checkMsgRate('a')).to.be.true; // 1
    expect(rootSuitePm.checkMsgRate('a')).to.be.true; // 2
    expect(rootSuitePm.checkMsgRate('a')).to.be.false; // 3 > 2
    clock.tick(60001);
    expect(rootSuitePm.checkMsgRate('a')).to.be.true; // window reset
    clock.restore();
  });
  it('checkMsgRate honors an explicit per-call limit (the known-peer ceiling)', function () {
    let clock = sinon.useFakeTimers();
    rootSuitePm.msgRateLimit = 1; // default would block at 2
    expect(rootSuitePm.checkMsgRate('kp', 3)).to.be.true; // 1
    expect(rootSuitePm.checkMsgRate('kp', 3)).to.be.true; // 2
    expect(rootSuitePm.checkMsgRate('kp', 3)).to.be.true; // 3
    expect(rootSuitePm.checkMsgRate('kp', 3)).to.be.false; // 4 > 3
    clock.restore();
  });
  it('recordPeer is a no-op without a db', function () {
    let pm2 = new PeerManager(rootSuiteConfig, null);
    expect(() => pm2.recordPeer('a', 'a', true)).to.not.throw();
  });
  it('recordPeer issues an upsert into p2p_peers', function () {
    rootSuitePm.recordPeer('ws://p:1', 'ws://p:1', true);
    expect(rootSuiteDbStub.doQuery.calledOnce).to.be.true;
    expect(rootSuiteDbStub.doQuery.getCall(0).args[0]).to.include('p2p_peers');
    expect(rootSuiteDbStub.doQuery.getCall(0).args[1]).to.deep.equal(['ws://p:1', 'ws://p:1', 1, 'ws://p:1']);
  });
}
function registerFeature17addToDedupCheckMsgRateRecordPeer() {
  describe('addToDedup() / checkMsgRate() / recordPeer()', function () {
    registerFeature17addToDedupCheckMsgRateRecordPeerPart1();
  });
}
let feature18p2PLifecycleRealLocalhostSocketsNodes;
const feature18p2PLifecycleRealLocalhostSocketsNet = require('net');

// Allocate an OS-assigned free port. PeerManager treats P2P_PORT:0 as
// falsy and falls back to 10001, so we must pass a concrete free port.
// Allocate an OS-assigned free port. PeerManager treats P2P_PORT:0 as
// falsy and falls back to 10001, so we must pass a concrete free port.
function feature18p2PLifecycleRealLocalhostSocketsFreePort() {
  return new Promise((resolve, reject) => {
    let s = feature18p2PLifecycleRealLocalhostSocketsNet.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      let p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
function feature18p2PLifecycleRealLocalhostSocketsMkNode(port, seeds, addr) {
  let cfg = {
    P2P_VALIDATOR_ADDR: addr,
    P2P_PORT: port,
    P2P_HOST: '127.0.0.1',
    SEED_NODES: seeds || [],
    REQUIRE_SIGNATURES: false,
    P2P_HEARTBEAT_INTERVAL: 100000,
    P2P_DEDUP_PRUNE_INTERVAL: 100000,
    P2P_WS_PING_INTERVAL: 100000,
    P2P_RECONNECT_BASE: 200,
    P2P_RECONNECT_MAX: 2000,
    P2P_MAX_PAYLOAD: 1048576
  };
  let n = new PeerManager(cfg, {
    ...DB_METHODS,
    doQuery: sinon.stub().resolves([])
  });
  feature18p2PLifecycleRealLocalhostSocketsNodes.push(n);
  return n;
}
function registerFeature18p2PLifecycleRealLocalhostSocketsPart1() {
  it('two nodes connect, exchange a message, register peers, and shut down cleanly', async function () {
    this.timeout(10000);
    let portA = await feature18p2PLifecycleRealLocalhostSocketsFreePort();
    let portB = await feature18p2PLifecycleRealLocalhostSocketsFreePort();
    let a = feature18p2PLifecycleRealLocalhostSocketsMkNode(portA, [], 'ws://nodeA:1');
    await a.start();
    let b = feature18p2PLifecycleRealLocalhostSocketsMkNode(portB, ['ws://127.0.0.1:' + portA], 'ws://nodeB:1');
    let bConnected = new Promise(r => b.once('peer:connect', r));
    await b.start();
    await bConnected; // B's outbound to A is open

    let aMsg = new Promise(r => a.once('message', r));
    let aPeer = new Promise(r => a.once('peer:connect', r));
    b.broadcast('TEST', {
      hello: 'world'
    });
    let env = await aMsg;
    await aPeer;
    expect(env.type).to.equal('TEST');
    expect(env.data.hello).to.equal('world');
    expect(a.getPeerStatus().some(p => p.inbound && p.state === 'open')).to.be.true;
    expect(b.getPeerStatus().some(p => !p.inbound && p.state === 'open')).to.be.true;
    await b.stop();
    await a.stop();
    expect(a.running).to.be.false;
    expect(a.httpServer).to.be.null;
  });
  it('rejects inbound connections beyond the per-IP limit', async function () {
    this.timeout(10000);
    const WebSocket = require('ws');
    let portA = await feature18p2PLifecycleRealLocalhostSocketsFreePort();
    let a = feature18p2PLifecycleRealLocalhostSocketsMkNode(portA, [], 'ws://limited:1');
    a.maxConnectionsPerIp = 1;
    await a.start();

    // First client connects and stays open.
    let c1 = new WebSocket('ws://127.0.0.1:' + portA);
    await new Promise((res, rej) => {
      c1.once('open', res);
      c1.once('error', rej);
    });

    // Second client from the same IP should be closed by the server.
    let c2 = new WebSocket('ws://127.0.0.1:' + portA);
    let c2Closed = await new Promise(res => {
      c2.once('close', code => res(code));
      c2.once('open', () => {/* may briefly open before close frame */});
    });
    expect(c2Closed).to.equal(1008);
    c1.close();
    await a.stop();
  });
}
function registerFeature18p2PLifecycleRealLocalhostSockets() {
  describe('P2P lifecycle (real localhost sockets)', function () {
    beforeEach(function () {
      feature18p2PLifecycleRealLocalhostSocketsNodes = [];
    });
    afterEach(async function () {
      for (let n of feature18p2PLifecycleRealLocalhostSocketsNodes) {
        try {
          await n.stop();
        } catch (e) {/* already stopped */}
      }
    });
    registerFeature18p2PLifecycleRealLocalhostSocketsPart1();
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
  registerFeature16backgroundTimers();
  registerFeature17addToDedupCheckMsgRateRecordPeer();
  registerFeature18p2PLifecycleRealLocalhostSockets();
});
