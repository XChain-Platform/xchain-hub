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

// An observer hub does not send into rounds it cannot sign.
//
// A hub whose signing key is outside the chain-effective signer set has every
// envelope it authors dropped at each peer's verifySignature, before any
// handler runs. The testnet service hub sat in exactly that state after it was
// re-admitted: five validators logged PEER_REJECT reason=not_in_signer_set once
// every 4 s for hours, and the hub itself recorded CHECKPOINT_STALLED every two
// blocks for a set it could never join. Nothing about that traffic could ever
// land, so the hub now holds back what it authors and keeps mirroring, relaying
// and serving.
//
// The gate has to be one-way: it may only silence a hub whose absence from the
// set is DEFINITE. An unresolved set, an empty one, a missing identity or a mesh
// that does not require signatures all fail open, because a real validator going
// quiet on a transient set read is a liveness fault far worse than the noise.
const sinon = require('sinon');
const {expect} = require('chai');
const PeerManager = require('../../src/peers/manager');
const ValidatorIdentity = require('../../src/validators/identity');
const StateCheckpointEngine = require('../../src/anchor/checkpoint_engine');
const {DB_METHODS} = require('../helpers/mockHub.js');
const TIP = {
  block_index: 500,
  block_hash: 'c0'.repeat(32),
  network: 'regtest',
  ledger_hash: 'a1'.repeat(32),
  actions_hash: 'b2'.repeat(32),
  contract_hash: 'c3'.repeat(32),
  state_root: 'd4'.repeat(32),
  state_root_version: 1,
  block_merkle_root: 'e5'.repeat(32),
  block_merkle_version: 1
};
function registerAHubOutsideTheResolvedSignerSetSuite1Part1() {
  beforeEach(function () {
    // The set exists and names someone else. This is the definite absence.
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setEffectiveSignerSet(new Set([observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.pubkeyHex.toLowerCase()]));
  });
  it('writes no frame for anything it authors', function () {
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3AttachPeer();
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('PBFT_PRE_PREPARE', {seq:1}), 'no envelope is built').to.equal(null);
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('ORACLE_PROPOSE', {round:7})).to.equal(null);
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('XCHK_SIGN_REQ', {checkpoint:{}})).to.equal(null);
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('HEARTBEAT', {version:'0.0.0'})).to.equal(null);
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.sendToPeer('ws://peer:10002', 'ATTEST_PREPARE', {}), 'the unicast path too').to.equal(false);
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Frames, 'nothing reached the wire').to.have.lengthOf(0);
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.seenIds.size, 'and no dedup slot was spent on a message nobody sees').to.equal(0);
  });
  it('still verifies and emits an inbound message from a set member', function () {
    let env = {id:'xc2418-in',type:'ORACLE_PROPOSE',sender:'ws://peer:10002',timestamp:Date.now(),data:{round:7},sig_pubkey:observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.pubkeyHex};
    env.sig = new ValidatorIdentity(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.privkeyHex).signEnvelope(env);
    let emitted = [];
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.on('message', e => emitted.push(e));
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.handleInbound({_peerAddr:'ws://peer:10002',_remoteIp:'203.0.113.7'}, JSON.stringify(env), 'ws://peer:10002');
    expect(emitted, 'receiving is untouched by the hold').to.have.lengthOf(1);
    expect(emitted[0].type).to.equal('ORACLE_PROPOSE');
  });
}
function registerAHubOutsideTheResolvedSignerSetSuite1Part2() {
  it('relays another validator\'s envelope unchanged', function () {
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3AttachPeer('ws://other:10002');
    let env = {id:'xc2418-relay',type:'ORACLE_PREPARE',sender:'ws://peer:10002',timestamp:Date.now(),data:{round:7},sig_pubkey:observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.pubkeyHex};
    env.sig = new ValidatorIdentity(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.privkeyHex).signEnvelope(env);
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.handleInbound({_peerAddr:'ws://peer:10002',_remoteIp:'203.0.113.7'}, JSON.stringify(env), 'ws://peer:10002');
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Frames, 'gossip service continues').to.have.lengthOf(1);
    expect(JSON.parse(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Frames[0]).sender, 'the original author, not this hub').to.equal('ws://peer:10002');
  });
  it('attempts no checkpoint round and meters no cadence stall', async function () {
    let held = {on(){},removeListener(){},broadcast(){},authoringHeld:()=>true};
    let {engine,indexerCalls,db} = observerHubDoesNotAuthorIntoRoundsItCannotSuite3BuildCheckpointEngine(held);
    await engine._tick();
    await engine._tick();
    expect(indexerCalls, 'not even the tip is fetched').to.have.lengthOf(0);
    expect(db.checkpoints, 'no checkpoint is cut').to.have.lengthOf(0);
    let stats = await engine.getStats();
    expect(stats.cadence_stalls, 'a set it cannot join is not a stall to meter').to.equal(0);
    expect(stats.cadence_stall_reason).to.equal(null);
    expect(stats.observer_idle, 'the idle reason is reported instead').to.equal(true);
  });
}
function registerFailsOpenWhenTheSetCannotSayAbsentSuite2Part1() {
  it('sends when the signer set has never resolved', function () {
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3AttachPeer();
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.effectiveSignerSet, 'the pre-refresh state').to.equal(null);
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.authoringHeld()).to.equal(false);
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('PBFT_PREPARE', {seq:1});
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Frames).to.have.lengthOf(1);
  });
  it('sends when the resolved set is empty (boot, or an upstream that answered nothing)', function () {
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3AttachPeer();
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setEffectiveSignerSet(new Set());
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.authoringHeld()).to.equal(false);
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('PBFT_PREPARE', {seq:1});
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Frames).to.have.lengthOf(1);
  });
  it('sends when a refresh failure leaves the last good set in place and we are in it', function () {
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3AttachPeer();
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setEffectiveSignerSet(new Set([observerHubDoesNotAuthorIntoRoundsItCannotSuite3Me.pubkeyHex.toLowerCase()]));
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('PBFT_PREPARE', {seq:1});
    // The refresh never clears to empty on failure; the stale set still names us.
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('PBFT_COMMIT', {seq:1});
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Frames).to.have.lengthOf(2);
  });
  it('sends when the hub carries no identity at all', function () {
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3AttachPeer();
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setIdentity(null);
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setEffectiveSignerSet(new Set([observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.pubkeyHex.toLowerCase()]));
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.authoringHeld()).to.equal(false);
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('PBFT_PREPARE', {seq:1});
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Frames).to.have.lengthOf(1);
  });
  it('sends on a mesh that does not require signatures, where peers admit anyone', function () {
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3AttachPeer();
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.requireSigs = false;
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setEffectiveSignerSet(new Set([observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.pubkeyHex.toLowerCase()]));
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.authoringHeld()).to.equal(false);
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('PBFT_PREPARE', {seq:1});
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Frames).to.have.lengthOf(1);
  });
}
function registerFailsOpenWhenTheSetCannotSayAbsentSuite2Part2() {
  it('sends when the identity will not render its pubkey', function () {
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3AttachPeer();
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setIdentity({getPubkeyHex(){throw new Error('key unreadable');}});
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setEffectiveSignerSet(new Set([observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.pubkeyHex.toLowerCase()]));
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.authoringHeld(), 'a key we cannot read is not a key we can call absent').to.equal(false);
  });
  it('a checkpoint engine whose peer manager predates the gate keeps its old cadence', async function () {
    let old = {on(){},removeListener(){},broadcast(){}};
    let {engine,indexerCalls} = observerHubDoesNotAuthorIntoRoundsItCannotSuite3BuildCheckpointEngine(old);
    await engine._tick();
    expect(indexerCalls.length, 'the round ran as before').to.be.greaterThan(0);
    expect((await engine.getStats()).observer_idle).to.equal(false);
  });
}
let observerHubDoesNotAuthorIntoRoundsItCannotSuite3Config, observerHubDoesNotAuthorIntoRoundsItCannotSuite3DbStub, observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm, observerHubDoesNotAuthorIntoRoundsItCannotSuite3Me, observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer, observerHubDoesNotAuthorIntoRoundsItCannotSuite3Frames, observerHubDoesNotAuthorIntoRoundsItCannotSuite3Logs;
// One OPEN peer socket, capturing every frame the manager writes to it.
function observerHubDoesNotAuthorIntoRoundsItCannotSuite3AttachPeer(addr) {
  let ws = {readyState:1,send:s=>observerHubDoesNotAuthorIntoRoundsItCannotSuite3Frames.push(s),ping(){}};
  observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.peers.set(addr || 'ws://peer:10002', {ws:ws,state:'connected',lastSeen:Date.now(),inbound:false});
  return ws;
}
function observerHubDoesNotAuthorIntoRoundsItCannotSuite3HoldLines() {
  return observerHubDoesNotAuthorIntoRoundsItCannotSuite3Logs.filter(l => l.includes('not in the') && l.includes('chain-effective'));
}
function observerHubDoesNotAuthorIntoRoundsItCannotSuite3ResumeLines() {
  return observerHubDoesNotAuthorIntoRoundsItCannotSuite3Logs.filter(l => l.includes('authoring consensus messages again'));
}

// -----------------------------------------------------------------
// (1) outside the set: sends nothing, still receives
// -----------------------------------------------------------------

// -----------------------------------------------------------------

// A checkpoint engine over an in-memory store, shaped like the cadence-stall
// suite's. `indexerCalls` records every round trip the tick would make, so a
// held tick can be shown to make none.
function observerHubDoesNotAuthorIntoRoundsItCannotSuite3BuildCheckpointEngine(peerManager) {
  const identity = new ValidatorIdentity('11'.repeat(32));
  const checkpoints = [];
  const indexerCalls = [];
  const db = {
    checkpoints,
    // The shared capability snapshot writer's one named statement, so the
    // tick's mirror write still lands in the doQuery below.
    createCapabilitySnapshots: DB_METHODS.createCapabilitySnapshots,
    async doQuery(sql, params) {
      if (sql.startsWith('SELECT MAX(checkpoint_seq)')) return [{ max_seq: null }];
      if (sql.startsWith('SELECT MAX(snapshot_block)')) return [{ last_block: null }];
      if (sql.startsWith('INSERT IGNORE INTO state_checkpoints')) {
        checkpoints.push({ chain: params[0], checkpoint_seq: params[7], snapshot_block: params[8] });
        return [];
      }
      if (sql.startsWith('SELECT * FROM state_checkpoints')) return [];
      return [];
    }
  };
  const validators = [{pubkey:identity.getPubkeyHex().toLowerCase(),amount:'1'}];
  const hub = {
    db,
    network: 'regtest',
    p2pConfig: {
      CHECKPOINT_CHAINS: 'BTC',
      CHECKPOINT_CONFIRMATIONS: '0',
      CHECKPOINT_INTERVAL_BLOCKS: '6',
      BTC_INDEXER_URL: 'http://stub'
    },
    hubDbBroadcaster: {
      broadcastRow() {}
    },
    capabilitySnapshot: {
      async getSnapshot() {
        return {
          validators
        };
      },
      async getWeightSnapshot() {
        return {
          validators: validators.map(v => ({
            pubkey: v.pubkey,
            source: 'src:' + v.pubkey,
            weight: v.amount
          }))
        };
      }
    },
    getPeerManager: () => peerManager,
    getIdentity: () => identity,
    _resolveBtcLatestBlock: async () => 100
  };
  const engine = new StateCheckpointEngine(hub);
  engine._indexerCall = async (chain, method) => {
    indexerCalls.push(chain + ':' + method);
    return Object.assign({}, TIP);
  };
  return {engine,indexerCalls,db};
}
function registerObserverHubDoesNotAuthorIntoRoundsItCannotSuite3Part1() {
  beforeEach(function () {
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Me = ValidatorIdentity.generate();
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer = ValidatorIdentity.generate();
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Config = {P2P_VALIDATOR_ADDR:'ws://self:10002',P2P_PORT:0,P2P_HOST:'127.0.0.1',SEED_NODES:[],REQUIRE_SIGNATURES:true,P2P_MSG_DEDUP_TTL:60000,P2P_HEARTBEAT_INTERVAL:15000};
    // The named db methods run against the stubbed doQuery, so a peer
    // upsert such as setP2pPeer resolves instead of throwing.
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3DbStub = {...DB_METHODS,doQuery:sinon.stub().resolves([])};
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm = new PeerManager(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Config, observerHubDoesNotAuthorIntoRoundsItCannotSuite3DbStub);
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setIdentity(new ValidatorIdentity(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Me.privkeyHex));
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Frames = [];
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Logs = [];
    sinon.stub(console, 'log').callsFake(m => observerHubDoesNotAuthorIntoRoundsItCannotSuite3Logs.push(String(m)));
  });
  afterEach(function () {
    sinon.restore();
  });
  describe('a hub outside the resolved signer set', function () {
    registerAHubOutsideTheResolvedSignerSetSuite1Part1.call(this);
    registerAHubOutsideTheResolvedSignerSetSuite1Part2.call(this);
  });

  // -----------------------------------------------------------------
  // (2) inside the set: byte-for-byte unchanged
  // -----------------------------------------------------------------
}
function registerObserverHubDoesNotAuthorIntoRoundsItCannotSuite3Part2() {
  it('a hub inside the set sends the same bytes it always did', function () {
    let ws = observerHubDoesNotAuthorIntoRoundsItCannotSuite3AttachPeer();
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setEffectiveSignerSet(new Set([observerHubDoesNotAuthorIntoRoundsItCannotSuite3Me.pubkeyHex.toLowerCase(), observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.pubkeyHex.toLowerCase()]));

    // Freeze the two fields that are fresh per envelope, so the comparison is
    // over the whole frame rather than a field-by-field paraphrase of it.
    sinon.stub(Date, 'now').returns(1757700000000);
    sinon.stub(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm, 'makeId').returns('xc2418-fixed-id');
    let expected = JSON.stringify(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.buildEnvelope('ORACLE_PROPOSE', {round:7,price:'1.25'}));
    let envelope = observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('ORACLE_PROPOSE', {round:7,price:'1.25'});
    expect(envelope, 'the return contract is unchanged for a member').to.be.an('object');
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Frames, 'one frame per open peer').to.have.lengthOf(1);
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Frames[0], 'byte-for-byte the pre-gate frame').to.equal(expected);
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.seenIds.has('xc2418-fixed-id'), 'own message still marked seen').to.equal(true);
    expect(ws.readyState).to.equal(1);
  });
  it('a member hub is announced nowhere: the gate is silent on the normal path', function () {
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3AttachPeer();
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setEffectiveSignerSet(new Set([observerHubDoesNotAuthorIntoRoundsItCannotSuite3Me.pubkeyHex.toLowerCase()]));
    observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('HEARTBEAT', {version:'0.0.0'});
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3HoldLines(), 'no hold line').to.have.lengthOf(0);
    expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3ResumeLines(), 'and no resume line at boot').to.have.lengthOf(0);
  });

  // -----------------------------------------------------------------
  // (3) fail open: every state that is not a definite absence
  // -----------------------------------------------------------------

  describe('fails open when the set cannot say "absent"', function () {
    registerFailsOpenWhenTheSetCannotSayAbsentSuite2Part1.call(this);
    registerFailsOpenWhenTheSetCannotSayAbsentSuite2Part2.call(this);
  });

  // -----------------------------------------------------------------
  // (4) one line per SET CHANGE, never per round
  // -----------------------------------------------------------------
}
function registerObserverHubDoesNotAuthorIntoRoundsItCannotSuite3Part3() {
  describe('the hold is announced once per signer-set change', function () {
    it('says it once no matter how many rounds try to send', function () {
      observerHubDoesNotAuthorIntoRoundsItCannotSuite3AttachPeer();
      observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setEffectiveSignerSet(new Set([observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.pubkeyHex.toLowerCase()]));
      for (let i = 0; i < 200; i++) observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('PBFT_PREPARE', {seq:i});
      expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3HoldLines(), 'one line, not one per round').to.have.lengthOf(1);
      expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3HoldLines()[0]).to.include('1-member');
      expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3HoldLines()[0], 'the operator can match the key').to.include(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Me.pubkeyHex.toLowerCase());
    });
    it('stays silent when the refresh reinstalls the same members in a new Set', function () {
      observerHubDoesNotAuthorIntoRoundsItCannotSuite3AttachPeer();
      for (let i = 0; i < 20; i++) {
        // What refreshTransportSignerSet does every 30s: a new object, same members.
        observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setEffectiveSignerSet(new Set([observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.pubkeyHex.toLowerCase()]));
        observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('PBFT_PREPARE', {seq:i});
      }
      expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3HoldLines(), 'the members did not change, so there is no news').to.have.lengthOf(1);
    });
    it('speaks again when the membership actually changes', function () {
      observerHubDoesNotAuthorIntoRoundsItCannotSuite3AttachPeer();
      let third = ValidatorIdentity.generate();
      observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setEffectiveSignerSet(new Set([observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.pubkeyHex.toLowerCase()]));
      observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('PBFT_PREPARE', {seq:1});
      observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setEffectiveSignerSet(new Set([observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.pubkeyHex.toLowerCase(), third.pubkeyHex.toLowerCase()]));
      observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('PBFT_PREPARE', {seq:2});
      expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3HoldLines(), 'a set of a different size is worth one more line').to.have.lengthOf(2);
      expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3HoldLines()[1]).to.include('2-member');
      expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Frames, 'still nothing on the wire').to.have.lengthOf(0);
    });
    it('says so once when the hub is admitted, and then goes quiet', function () {
      observerHubDoesNotAuthorIntoRoundsItCannotSuite3AttachPeer();
      observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setEffectiveSignerSet(new Set([observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.pubkeyHex.toLowerCase()]));
      observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('PBFT_PREPARE', {seq:1});
      observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setEffectiveSignerSet(new Set([observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.pubkeyHex.toLowerCase(), observerHubDoesNotAuthorIntoRoundsItCannotSuite3Me.pubkeyHex.toLowerCase()]));
      observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('PBFT_PREPARE', {seq:2});
      observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.setEffectiveSignerSet(new Set([observerHubDoesNotAuthorIntoRoundsItCannotSuite3Peer.pubkeyHex.toLowerCase(), observerHubDoesNotAuthorIntoRoundsItCannotSuite3Me.pubkeyHex.toLowerCase()]));
      observerHubDoesNotAuthorIntoRoundsItCannotSuite3Pm.broadcast('PBFT_PREPARE', {seq:3});
      expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3ResumeLines(), 'one admission line').to.have.lengthOf(1);
      expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3HoldLines(), 'and no second hold line').to.have.lengthOf(1);
      expect(observerHubDoesNotAuthorIntoRoundsItCannotSuite3Frames, 'the admitted hub sends both later rounds').to.have.lengthOf(2);
    });
  });
}
describe('observer hub does not author into rounds it cannot sign', function () {
  registerObserverHubDoesNotAuthorIntoRoundsItCannotSuite3Part1.call(this);
  registerObserverHubDoesNotAuthorIntoRoundsItCannotSuite3Part2.call(this);
  registerObserverHubDoesNotAuthorIntoRoundsItCannotSuite3Part3.call(this);
});
