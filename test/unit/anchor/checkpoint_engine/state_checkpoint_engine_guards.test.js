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

// In-process checkpoint mesh: K StateCheckpointEngine instances share a mock
// gossip bus (mirror of CrossChainDexConsensus.test.js), each with a real
// ValidatorIdentity, an in-memory state_checkpoints "DB", and a stubbed
// per-node indexer (getblockhashes). Exercises the leader-elected
// SIGN_REQ → SIGN → FINALIZED round, single-node collapse, the
// diverged-replica refusal, quorum failure, the seq replay guard, and the
// non-leader SIGN_REQ guard.
const {
  expect
} = require('chai');
const StateCheckpointEngine = require('../../../../src/anchor/checkpoint_engine');
const ValidatorIdentity = require('../../../../src/validators/identity');
const {
  waitUntil
} = require('../../../helpers/waitUntil');
const {
  DB_METHODS
} = require('../../../helpers/mockHub.js');

// The mock bus hands SIGN_REQ to an async handler that handleMessage fires and
// forgets, so "nobody co-signed" is only settled once every peer has finished
// judging the request. Wrapping the handler makes that countable, which is the
// observable the refusal cases once stood a fixed sleep in for.
function countHandled(nodes, method) {
  let done = 0;
  for (let nd of nodes) {
    let engine = nd.engine;
    let orig = engine[method].bind(engine);
    engine[method] = async (...args) => {
      try {
        return await orig(...args);
      } finally {
        done++;
      }
    };
  }
  return () => done;
}
const TIP = {
  block_index: 500,
  block_hash: 'c0'.repeat(32),
  network: 'regtest',
  ledger_hash: 'a1'.repeat(32),
  actions_hash: 'b2'.repeat(32),
  contract_hash: 'c3'.repeat(32),
  // SPV Phase 2: regtest CHECKPOINT_COMMITMENT flag-day is 0, so getblockhashes returns the
  // light-client roots and the engine signs + persists them (it refuses to sign without them).
  state_root: 'd4'.repeat(32),
  state_root_version: 1,
  block_merkle_root: 'e5'.repeat(32),
  block_merkle_version: 1
};
let buses = [];
// Minimal in-memory hub DB: state_checkpoints + capability_snapshots.
// Minimal in-memory hub DB: state_checkpoints + capability_snapshots.
function memDb() { let checkpoints = []; // rows keyed by (chain, network, block_index)
let snapshots = []; return { ...DB_METHODS, checkpoints, snapshots, async doQuery(sql, params) { if (sql.startsWith('SELECT COALESCE(MAX(checkpoint_seq)')) { let max = -1; for (let r of checkpoints) if (r.chain === params[0] && r.network === params[1] && r.checkpoint_seq > max) max = r.checkpoint_seq; return [{ next_seq: max + 1 }]; } if (sql.startsWith('SELECT MAX(checkpoint_seq)')) { let max = null; for (let r of checkpoints) if (r.chain === params[0] && r.network === params[1] && (max == null || r.checkpoint_seq > max)) max = r.checkpoint_seq; return [{ max_seq: max }]; } if (sql.startsWith('SELECT MAX(snapshot_block)')) { let max = null; for (let r of checkpoints) if (max == null || r.snapshot_block > max) max = r.snapshot_block; return [{ last_block: max }]; } if (sql.startsWith('INSERT IGNORE INTO state_checkpoints')) { let [chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root, block_merkle_version, validator_signatures] = params; // append-only INSERT IGNORE keyed by the TIGHTENED unique index
// (chain, network, checkpoint_seq). A second row at an already-seated seq
// (even a different block_index) is dropped, exactly as the real DB's
// uq_chain_seq collapses a same-seq split-brain to one admitted row.
if (!checkpoints.some(r => r.chain === chain && r.network === network && r.checkpoint_seq === checkpoint_seq)) checkpoints.push({ id: checkpoints.length + 1, chain, network, block_index, block_hash, ledger_hash, actions_hash, contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version, block_merkle_root, block_merkle_version, validator_signatures }); return []; } // The same-seq conflict fence reads on the UNIQUE key (chain, network,
// seq) and NOT on block_index, precisely so it can see the row a rival
// block_index seated. Answering it with the four-column form below would
// return nothing and leave the fence inert in every test here.
if (sql.startsWith('SELECT * FROM state_checkpoints WHERE chain = ? AND network = ? AND checkpoint_seq = ?')) { return checkpoints.filter(r => r.chain === params[0] && r.network === params[1] && r.checkpoint_seq === params[2]).slice(0, 1); } if (sql.startsWith('SELECT * FROM state_checkpoints')) { return checkpoints.filter(r => r.chain === params[0] && r.network === params[1] && r.block_index === params[2] && r.checkpoint_seq === params[3]).slice(0, 1); } if (sql.startsWith('INSERT IGNORE INTO capability_snapshots')) { // One multi-row statement carries the whole set, so walk the flattened
// params in groups of five rather than destructuring a single row.
for (let i = 0; i + 5 < params.length; i += 6) { let [snapshot_block, capability, signing_pubkey, amount] = params.slice(i, i + 6); if (!snapshots.some(r => r.snapshot_block === snapshot_block && r.capability === capability && r.signing_pubkey === signing_pubkey)) snapshots.push({ id: snapshots.length + 1, snapshot_block, capability, signing_pubkey, amount }); } return []; } if (sql.startsWith('SELECT * FROM capability_snapshots')) { return snapshots.filter(r => r.snapshot_block === params[0] && r.capability === params[1] && r.signing_pubkey === params[2]).slice(0, 1); } return []; } }; } // Build n engines over a shared in-memory gossip bus.
// opts.btcBlock  : resolved BTC tip (drives cadence-leader election);
// opts.hashesFor(self) : per-node getblockhashes result (default TIP).

// Build n engines over a shared in-memory gossip bus.
// opts.btcBlock  : resolved BTC tip (drives cadence-leader election);
// opts.hashesFor(self) : per-node getblockhashes result (default TIP).
// Build n engines over a shared in-memory gossip bus.
// opts.btcBlock  : resolved BTC tip (drives cadence-leader election);
// opts.hashesFor(self) : per-node getblockhashes result (default TIP).
function buildMesh(n, opts) { opts = opts || {}; let bus = { nodes: [] }; let identities = []; for (let i = 0; i < n; i++) identities.push(new ValidatorIdentity(String(10 + i).repeat(32).slice(0, 64))); let validators = identities.map(id => ({ pubkey: id.getPubkeyHex().toLowerCase(), amount: '1' })); for (let i = 0; i < n; i++) { let identity = identities[i]; let self = { i, identity, pubkey: identity.getPubkeyHex().toLowerCase(), handler: null }; let peerManager = { on(evt, h) { if (evt === 'message') self.handler = h; }, removeListener(evt) { if (evt === 'message') self.handler = null; }, broadcast(type, data) { let env = { type, sender: self.pubkey, data }; for (let other of bus.nodes) { if (other === self) continue; if (opts.drop && opts.drop(self, other, type, data)) continue; if (other.handler) other.handler(env); } } }; let db = memDb(); let hub = { db, p2pConfig: { CHECKPOINT_CHAINS: (opts.chains || ['BTC']).join(','), CHECKPOINT_CONFIRMATIONS: String(opts.confirmations != null ? opts.confirmations : 0), // Left undefined unless a case sets it, so every other mesh keeps
// resolving the built-in default.
CHECKPOINT_COSIGN_TOLERANCE_BLOCKS: opts.cosignTolerance, BTC_INDEXER_URL: 'http://stub', LTC_INDEXER_URL: 'http://stub', DOGE_INDEXER_URL: 'http://stub' }, hubDbBroadcaster: { rows: [], broadcastRow(ev) { this.rows.push(ev); } }, capabilitySnapshot: { async getSnapshot() { return { validators: validators.slice(0, n) }; } }, getPeerManager: () => peerManager, getIdentity: () => identity, resolveBtcLatestBlock: async () => opts.btcBlock != null ? opts.btcBlock : 100 }; self.db = db; self.hub = hub; self.engine = new StateCheckpointEngine(hub); self.engine.indexerCall = async (coin, method, params) => { let h = opts.hashesFor ? opts.hashesFor(self, params, coin) : TIP; return h ? Object.assign({}, h) : null; }; self.finalized = []; self.engine.on('checkpoint:finalized', ev => self.finalized.push(ev)); bus.nodes.push(self); } buses.push(bus); return bus; }
function sortedPubkeys(bus) {
  return bus.nodes.map(nd => nd.pubkey).sort();
}
function leaderNode(bus, btcBlock) {
  let leaderPk = sortedPubkeys(bus)[btcBlock % bus.nodes.length];
  return bus.nodes.find(nd => nd.pubkey === leaderPk);
}
async function startAll(bus) {
  for (let nd of bus.nodes) await nd.engine.start();
}
async function tickAll(bus) {
  for (let nd of bus.nodes) await nd.engine.tick();
}
function registerSplitSuitePart1() {
  afterEach(async function () {
    for (let bus of buses) {
      for (let nd of bus.nodes) await nd.engine.stop();
    }
    buses = [];
  });
  it('two diverged replicas of 4 → no quorum, nothing written anywhere', async function () {
    let bus = buildMesh(4, {
      btcBlock: 101,
      hashesFor: self => {
        let leader = leaderNode(buses[0], 101);
        let followers = buses[0].nodes.filter(nd => nd !== leader);
        if (self === followers[0] || self === followers[1]) return Object.assign({}, TIP, {
          ledger_hash: 'ff'.repeat(32)
        });
        return TIP;
      }
    });
    await startAll(bus);
    await tickAll(bus);
    // Quorum (3) is unreachable, so wait on the stall point: the leader holds its
    // own signature plus the one honest follower's and can collect no more.
    await waitUntil(() => {
      let round = [...leaderNode(bus, 101).engine.pending.values()][0];
      return round && round.signatures.size >= 2;
    }, {
      label: 'the single honest co-sign to reach the leader'
    });
    for (let nd of bus.nodes) expect(nd.db.checkpoints.length, 'node ' + nd.i).to.equal(0);
  });
}
function registerSplitSuitePart2() {
  it('followers never co-sign a stale checkpoint_seq (replay guard)', async function () {
    let bus = buildMesh(4, {
      btcBlock: 101
    });
    await startAll(bus);
    // seq is derived from snapshot_block, so the leader proposes seq 101
    // (btcBlock 101). Pre-record that same seq on every follower so the proposal
    // is a genuine replay (cp.checkpoint_seq 101 <= recorded maxSeq 101).
    let leader = leaderNode(bus, 101);
    for (let nd of bus.nodes) {
      if (nd === leader) continue;
      nd.db.checkpoints.push({
        id: 1,
        chain: 'BTC',
        network: 'regtest',
        block_index: 1,
        block_hash: '',
        ledger_hash: '',
        actions_hash: '',
        contract_hash: '',
        checkpoint_seq: 101,
        snapshot_block: 101,
        validator_signatures: '[]'
      });
    }
    let reqsHandled = countHandled(bus.nodes.filter(nd => nd !== leader), 'handleSignReq');
    await tickAll(bus);
    await waitUntil(() => reqsHandled() === bus.nodes.length - 1, {
      label: 'every follower to finish judging the replayed SIGN_REQ'
    });
    // No follower signed → leader stuck below quorum → no new row on the leader.
    expect(leader.db.checkpoints.length).to.equal(0);
  });
}
function registerSplitSuitePart3() {
  it('SIGN_REQ from a non-leader validator is ignored', async function () {
    let bus = buildMesh(4, {
      btcBlock: 101
    });
    await startAll(bus);
    let leader = leaderNode(bus, 101);
    let impostor = bus.nodes.find(nd => nd !== leader);
    let cp = {
      chain: 'BTC',
      network: TIP.network,
      block_index: TIP.block_index,
      block_hash: TIP.block_hash,
      ledger_hash: TIP.ledger_hash,
      actions_hash: TIP.actions_hash,
      contract_hash: TIP.contract_hash,
      // seq must match the value derived from snapshot_block, so the REQ
      // clears the deterministic-seq guard and is rejected specifically by the
      // non-leader (cadence) check we are exercising here.
      checkpoint_seq: 101,
      snapshot_block: 101
    };
    let canon = StateCheckpointEngine.canonicalCheckpoint(cp);
    let reqsHandled = countHandled(bus.nodes.filter(nd => nd !== impostor), 'handleSignReq');
    // Impostor broadcasts a well-formed, correctly signed REQ, but isn't the cadence leader.
    impostor.engine.peerManager.broadcast(StateCheckpointEngine.XCHK_SIGN_REQ, {
      checkpoint: cp,
      sig_pubkey: impostor.pubkey,
      sig: impostor.identity.sign(canon)
    });
    await waitUntil(() => reqsHandled() === bus.nodes.length - 1, {
      label: 'every peer to finish judging the non-leader SIGN_REQ'
    });
    for (let nd of bus.nodes) expect(nd.db.checkpoints.length, 'node ' + nd.i).to.equal(0);
  });
}
function registerSplitSuitePart4() {
  it('multi-chain: one cadence tick checkpoints EVERY configured chain (BTC,LTC,DOGE)', async function () {
    // The per-chain loop in tick (one round per chain under a single cadence leader)
    // is otherwise only exercised single-chain. A single-validator set self-signs each
    // chain's round immediately, so one tick must land one row per configured chain.
    let bus = buildMesh(1, {
      btcBlock: 100,
      chains: ['BTC', 'LTC', 'DOGE']
    });
    await startAll(bus);
    await tickAll(bus);
    await waitUntil(() => bus.nodes[0].db.checkpoints.length === 3, {
      label: 'one tick to checkpoint all three configured chains'
    });
    let nd = bus.nodes[0];
    expect(nd.db.checkpoints.map(r => r.chain).sort()).to.deep.equal(['BTC', 'DOGE', 'LTC']);
    // Each chain's row carries its own valid self-signature over its own canonical
    // (the chain name is part of the preimage, so the three sigs are distinct).
    for (let row of nd.db.checkpoints) {
      let sigs = JSON.parse(row.validator_signatures);
      expect(sigs.length, row.chain + ' sigs').to.equal(1);
      let canon = StateCheckpointEngine.canonicalCheckpoint(row);
      expect(ValidatorIdentity.verify(canon, sigs[0].sig, sigs[0].pubkey), row.chain + ' verifies').to.be.true;
    }
  });
  it('confirmations offset: checkpoints the tip MINUS CHECKPOINT_CONFIRMATIONS (snapshot_block unchanged)', async function () {
    // tip.block_index = 500; runRound re-fetches getblockhashes at (tip - confirmations),
    // so the persisted block_index is 497 while snapshot_block tracks the BTC cadence block.
    let bus = buildMesh(1, {
      btcBlock: 100,
      confirmations: 3,
      hashesFor: (self, params) => Object.assign({}, TIP, params && params.block_index != null ? {
        block_index: params.block_index
      } : {})
    });
    await startAll(bus);
    await tickAll(bus);
    await waitUntil(() => bus.nodes[0].db.checkpoints.length === 1, {
      label: 'the offset round to write its checkpoint'
    });
    let nd = bus.nodes[0];
    expect(nd.db.checkpoints.length).to.equal(1);
    expect(nd.db.checkpoints[0].block_index, 'tip minus confirmations').to.equal(TIP.block_index - 3); // 497
    expect(nd.db.checkpoints[0].snapshot_block, 'cadence block, not offset').to.equal(100);
  });
}
describe('StateCheckpointEngine', function () {
  registerSplitSuitePart1();
  registerSplitSuitePart2();
  registerSplitSuitePart3();
  registerSplitSuitePart4();
});
