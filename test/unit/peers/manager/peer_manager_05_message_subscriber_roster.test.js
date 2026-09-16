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
const feature19messageSubscriberRosterRca = require('../../../../src/consensus/gates/rollcall_gate.js');
const feature19messageSubscriberRosterRollcallRound = require('../../../../src/rollcall/round.js');
const feature19messageSubscriberRosterAttestationRelay = require('../../../../src/attestation/relay.js');
const feature19messageSubscriberRosterCrossChainCallEngine = require('../../../../src/cross_chain/call_engine.js');
const {
  spawnSync: feature19messageSubscriberRosterSpawnSync
} = require('child_process');
const feature19messageSubscriberRosterROLLCALL = 'RollcallRound';
const feature19messageSubscriberRosterRELAY = 'CrossChainDexConsensus:ATTEST_RELAY';

// A hub config as PeerManager sees it: XChainHub hands it p2pConfig, so the
// network and the engine opt-ins it carries are readable from here.
// A hub config as PeerManager sees it: XChainHub hands it p2pConfig, so the
// network and the engine opt-ins it carries are readable from here.
const feature19messageSubscriberRosterHubConfig = extra => Object.assign({
  P2P_VALIDATOR_ADDR: 'ws://self:10001'
}, extra || {});

// A duck-typed hub, enough for the engines whose gates are compared with the
// roster below. Their constructors read config and nothing else.
// A duck-typed hub, enough for the engines whose gates are compared with the
// roster below. Their constructors read config and nothing else.
const feature19messageSubscriberRosterStubHub = (cfg, peerManager) => ({
  db: rootSuiteDbStub,
  p2pConfig: cfg,
  network: cfg.HUB_NETWORK || '',
  getPeerManager: () => peerManager || null,
  getIdentity: () => null
});

// Collect the warnings Node defers past the synchronous .on() that raises them.
// Collect the warnings Node defers past the synchronous .on() that raises them.
async function feature19messageSubscriberRosterWarningsDuring(fn) {
  const seen = [];
  const onWarning = w => seen.push(w);
  process.on('warning', onWarning);
  try {
    await fn();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    process.removeListener('warning', onWarning);
  }
  return seen;
}

// Attach `count` distinct listeners; return the ceiling warnings they raised.
// Attach `count` distinct listeners; return the ceiling warnings they raised.
async function feature19messageSubscriberRosterAttachListeners(target, count) {
  const warnings = await feature19messageSubscriberRosterWarningsDuring(async () => {
    for (let i = 0; i < count; i++) target.on('message', function () {
      return i;
    });
  });
  return warnings.filter(w => w.name === 'MaxListenersExceededWarning').map(w => w.message);
}

// The roster for a regtest hub, computed in a child process so the arming
// environment is the real one: rollcall_gate.js reads
// XC_ROLLCALL_REGTEST_ACTIVATION once, at require time, on purpose.
// The roster for a regtest hub, computed in a child process so the arming
// environment is the real one: rollcall_gate.js reads
// XC_ROLLCALL_REGTEST_ACTIVATION once, at require time, on purpose.
function feature19messageSubscriberRosterRegtestRosterWith(armingValue) {
  const env = Object.assign({}, process.env);
  if (armingValue === null) delete env[feature19messageSubscriberRosterRca.ROLLCALL_REGTEST_ENV];else env[feature19messageSubscriberRosterRca.ROLLCALL_REGTEST_ENV] = armingValue;
  const pmPath = require.resolve('../../../../src/peers/manager.js');
  const out = feature19messageSubscriberRosterSpawnSync(process.execPath, ['-e', 'const PM = require(' + JSON.stringify(pmPath) + ');' + 'const r = PM.messageSubscribers({ HUB_NETWORK: "regtest" }, process.env);' + 'process.stdout.write(JSON.stringify({ n: r.length, rollcall: r.indexOf("RollcallRound") >= 0 }));'], {
    env,
    encoding: 'utf8'
  });
  expect(out.status, out.stderr).to.equal(0);
  return JSON.parse(out.stdout);
}
// Each configuration branch, driven the way a leak would be seen: a full set
// of legitimate subscribers is silent, and the next one warns.
const feature19messageSubscriberRosterBranches = [['regtest with nothing armed', {
  HUB_NETWORK: 'regtest'
}], ['a network with roll call armed', {
  HUB_NETWORK: 'testnet'
}], ['regtest with the relay opted in', {
  HUB_NETWORK: 'regtest',
  ATTEST_RELAY_ENABLED: '1'
}]];
function registerFeature19messageSubscriberRosterPart1() {
  it('a regtest venue with no activation height credits no roll-call listener', function () {
    this.timeout(10000);
    // 18 is what lane L6e counted attaching at a real regtest boot: the 14
    // singleton subscribers plus the four CrossChainDexConsensus channels.
    expect(feature19messageSubscriberRosterRegtestRosterWith(null)).to.deep.equal({
      n: 18,
      rollcall: false
    });
  });
  it('arming the regtest venue adds exactly one, and it is the roll-call listener', function () {
    this.timeout(10000);
    expect(feature19messageSubscriberRosterRegtestRosterWith('armed')).to.deep.equal({
      n: 19,
      rollcall: true
    });
  });
  it('a network whose activation height is set credits RollcallRound', function () {
    // mainnet and testnet carry literal heights, so this branch needs no env.
    for (const network of ['mainnet', 'testnet']) {
      const cfg = feature19messageSubscriberRosterHubConfig({
        HUB_NETWORK: network
      });
      const engine = new feature19messageSubscriberRosterRollcallRound(feature19messageSubscriberRosterStubHub(cfg));
      // The three inputs the engine's start() gates on, read off the engine.
      expect(engine.enabled, network).to.be.true;
      expect(engine.interval, network).to.be.a('number').and.to.be.above(0);
      expect(Number.isFinite(feature19messageSubscriberRosterRca.ROLLCALL_ACTIVATION[network]), network).to.be.true;
      expect(PeerManager.messageSubscribers(cfg, process.env), network).to.include(feature19messageSubscriberRosterROLLCALL);
    }
  });
  it('an armed network with roll call switched off credits no roll-call listener', function () {
    const cfg = feature19messageSubscriberRosterHubConfig({
      HUB_NETWORK: 'testnet',
      ROLLCALL_ENABLED: 'false'
    });
    const engine = new feature19messageSubscriberRosterRollcallRound(feature19messageSubscriberRosterStubHub(cfg));
    expect(engine.enabled).to.be.false;
    expect(PeerManager.messageSubscribers(cfg, process.env)).to.not.include(feature19messageSubscriberRosterROLLCALL);
  });
  it('the relay channel is credited exactly when AttestationRelay is opted in', function () {
    for (const optIn of ['0', '1']) {
      const cfg = feature19messageSubscriberRosterHubConfig({
        HUB_NETWORK: 'regtest',
        ATTEST_RELAY_ENABLED: optIn
      });
      const engine = new feature19messageSubscriberRosterAttestationRelay(feature19messageSubscriberRosterStubHub(cfg));
      const roster = PeerManager.messageSubscribers(cfg, process.env);
      expect(engine.enabled, optIn).to.equal(optIn === '1');
      // An unstarted channel subscribes to nothing, and start() returns on
      // this flag before starting it, so the credit must follow the flag.
      expect(roster.indexOf(feature19messageSubscriberRosterRELAY) >= 0, optIn).to.equal(engine.enabled);
    }
  });
}
function registerFeature19messageSubscriberRosterPart2() {
  it('the XCALL relay channel is credited because the call engine really attaches one', async function () {
    sinon.stub(console, 'warn');
    sinon.stub(console, 'log');
    const cfg = feature19messageSubscriberRosterHubConfig({
      HUB_NETWORK: 'regtest'
    });
    const target = new PeerManager(cfg, rootSuiteDbStub);
    const engine = new feature19messageSubscriberRosterCrossChainCallEngine(feature19messageSubscriberRosterStubHub(cfg, target));
    const before = target.listenerCount('message');
    await engine.start();
    const after = target.listenerCount('message');
    await engine.stop();
    expect(after - before).to.equal(1);
    expect(target.listenerCount('message')).to.equal(before);
    // The channel name taken from the engine's own PBFT message types, so a
    // renamed channel fails here instead of drifting away from the roster.
    const channel = String(engine.consensus.types.PROPOSE).replace(/_PROPOSE$/, '');
    expect(PeerManager.messageSubscribers(cfg, process.env)).to.include('CrossChainDexConsensus:' + channel);
  });

  // Each configuration branch, driven the way a leak would be seen: a full set
  // of legitimate subscribers is silent, and the next one warns.

  for (const [label, extra] of feature19messageSubscriberRosterBranches) {
    it('the ceiling equals the attachment count on ' + label, async function () {
      const cfg = feature19messageSubscriberRosterHubConfig(extra);
      const roster = PeerManager.messageSubscribers(cfg, process.env);
      const target = new PeerManager(cfg, rootSuiteDbStub);
      expect(new Set(roster).size, 'a repeated entry is a silent +1').to.equal(roster.length);
      expect(target.getMaxListeners()).to.equal(roster.length);
      expect(await feature19messageSubscriberRosterAttachListeners(target, roster.length), 'a full boot must be silent').to.deep.equal([]);
      expect((await feature19messageSubscriberRosterAttachListeners(target, 1)).length, 'a listener leak would now be silent').to.be.at.least(1);
    });
  }
}
function registerFeature19messageSubscriberRoster() {
  describe('message subscriber roster', function () {
    registerFeature19messageSubscriberRosterPart1();
    registerFeature19messageSubscriberRosterPart2();
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
  registerFeature19messageSubscriberRoster();
});
