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

// The mock bus hands SIGN_REQ to an async handler that _handleMessage fires and
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
CHECKPOINT_COSIGN_TOLERANCE_BLOCKS: opts.cosignTolerance, BTC_INDEXER_URL: 'http://stub', LTC_INDEXER_URL: 'http://stub', DOGE_INDEXER_URL: 'http://stub' }, hubDbBroadcaster: { rows: [], broadcastRow(ev) { this.rows.push(ev); } }, capabilitySnapshot: { async getSnapshot() { return { validators: validators.slice(0, n) }; } }, getPeerManager: () => peerManager, getIdentity: () => identity, resolveBtcLatestBlock: async () => opts.btcBlock != null ? opts.btcBlock : 100 }; self.db = db; self.hub = hub; self.engine = new StateCheckpointEngine(hub); self.engine._indexerCall = async (coin, method, params) => { let h = opts.hashesFor ? opts.hashesFor(self, params, coin) : TIP; return h ? Object.assign({}, h) : null; }; self.finalized = []; self.engine.on('checkpoint:finalized', ev => self.finalized.push(ev)); bus.nodes.push(self); } buses.push(bus); return bus; }
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
  for (let nd of bus.nodes) await nd.engine._tick();
}

// ── snapshot_block-derived checkpoint_seq + split-brain fence ─────
// The old COALESCE(MAX(seq))+1 allocation let two one-block-tip-skewed leaders
// mint the SAME seq for DIFFERENT blocks (split-brain), which the anchor
// publisher then double-spent on DOGE. seq is now a deterministic function of
// snapshot_block, followers refuse a leader whose seq does not match, and the
// tightened (chain, network, checkpoint_seq) unique key collapses any residual
// same-seq race to one admitted row.
function registerSplitSuitePart1() {
  it('deriveCheckpointSeq is the identity on snapshot_block, and a produced checkpoint uses it', async function () {
    expect(StateCheckpointEngine.deriveCheckpointSeq(900120)).to.equal(900120);
    expect(StateCheckpointEngine.deriveCheckpointSeq('42')).to.equal(42);
    let bus = buildMesh(1, {
      btcBlock: 250
    });
    await startAll(bus);
    await tickAll(bus);
    await waitUntil(() => bus.nodes[0].db.checkpoints.length === 1, {
      label: 'the round to write its checkpoint'
    });
    let row = bus.nodes[0].db.checkpoints[0];
    // seq is the BTC cadence (snapshot) block, NOT a dense 0 from MAX+1.
    expect(row.checkpoint_seq, 'seq == snapshot_block').to.equal(250);
    expect(row.snapshot_block).to.equal(250);
  });
}
function registerSplitSuitePart2() {
  it('followers refuse to co-sign a SIGN_REQ whose seq does not match its snapshot_block (grinding)', async function () {
    let SNAP = 500;
    let bus = buildMesh(2, {
      btcBlock: SNAP,
      confirmations: 0
    });
    let leader = leaderNode(bus, SNAP);
    let follower = bus.nodes.find(nd => nd.pubkey !== leader.pubkey);
    follower.hub.resolveBtcLatestBlock = async () => SNAP; // fresh: passes the freshness bound

    // A leader-signed REQ that is fresh and correctly signed, but carries a
    // ground seq (SNAP+7) instead of the deterministic deriveCheckpointSeq(SNAP)=SNAP.
    let cp = {
      chain: 'BTC',
      network: TIP.network,
      block_index: TIP.block_index,
      block_hash: TIP.block_hash,
      ledger_hash: TIP.ledger_hash,
      actions_hash: TIP.actions_hash,
      contract_hash: TIP.contract_hash,
      checkpoint_seq: SNAP + 7,
      snapshot_block: SNAP,
      state_root: TIP.state_root,
      state_root_version: TIP.state_root_version,
      block_merkle_root: TIP.block_merkle_root,
      block_merkle_version: TIP.block_merkle_version
    };
    let canon = StateCheckpointEngine.canonicalCheckpoint(cp);
    let env = {
      type: 'XCHK_SIGN_REQ',
      sender: leader.pubkey,
      data: {
        checkpoint: cp,
        sig_pubkey: leader.pubkey,
        sig: leader.identity.sign(canon)
      }
    };
    let signs = [];
    let pm = follower.engine.peerManager,
      orig = pm.broadcast.bind(pm);
    pm.broadcast = (type, data) => {
      if (type === 'XCHK_SIGN') signs.push(data);
      return orig(type, data);
    };
    await follower.engine.handleSignReq(env);
    expect(signs.length, 'ground seq refused').to.equal(0);
  });
}
function registerSplitSuitePart3() {
  it('handleFinalized rejects a finalized checkpoint whose seq does not match snapshot_block', async function () {
    let bus = buildMesh(1, {
      btcBlock: 300
    });
    let nd = bus.nodes[0];
    await nd.engine.start();
    let cp = {
      chain: 'BTC',
      network: TIP.network,
      block_index: TIP.block_index,
      block_hash: TIP.block_hash,
      ledger_hash: TIP.ledger_hash,
      actions_hash: TIP.actions_hash,
      contract_hash: TIP.contract_hash,
      checkpoint_seq: 999,
      snapshot_block: 300 // 999 != deriveCheckpointSeq(300)
    };
    await nd.engine.handleFinalized({
      data: {
        checkpoint: cp,
        signatures: [{
          pubkey: nd.pubkey,
          sig: 'x'
        }]
      }
    });
    expect(nd.db.checkpoints.length, 'malformed finalized seq not persisted').to.equal(0);
  });
}
function registerSplitSuitePart4() {
  it('same-seq split-brain (different block_index) collapses to one admitted row', async function () {
    let bus = buildMesh(1, {
      btcBlock: 200
    });
    let nd = bus.nodes[0];
    let base = {
      chain: 'BTC',
      network: 'regtest',
      block_hash: TIP.block_hash,
      ledger_hash: TIP.ledger_hash,
      actions_hash: TIP.actions_hash,
      contract_hash: TIP.contract_hash,
      checkpoint_seq: 200,
      snapshot_block: 200,
      // Roots are populated: regtest has checkpoint-commitment active
      // from genesis, so a rootless checkpoint at this snapshot_block is now
      // refused on every path (propose, co-sign and persist). The propose path
      // already refused it before this change, so a rootless regtest checkpoint
      // was never reachable in practice and the old all-null fixture was
      // synthetic. This test is about the same-seq split-brain fence, not about
      // roots, so give it a checkpoint that is otherwise valid.
      state_root: 'a'.repeat(64),
      state_root_version: 1,
      block_merkle_root: 'b'.repeat(64),
      block_merkle_version: 1
    };
    // Two divergent payloads (block_index 10 vs 11) at the SAME seq 200 - exactly
    // the split-brain the old 4-column unique index admitted BOTH of.
    await nd.engine.acceptFinalized(Object.assign({}, base, {
      block_index: 10
    }), [{
      pubkey: nd.pubkey,
      sig: 'a'
    }], 1, true);
    await nd.engine.acceptFinalized(Object.assign({}, base, {
      block_index: 11
    }), [{
      pubkey: nd.pubkey,
      sig: 'b'
    }], 1, true);
    let atSeq = nd.db.checkpoints.filter(r => r.chain === 'BTC' && r.network === 'regtest' && r.checkpoint_seq === 200);
    expect(atSeq.length, 'exactly one row survives per seq').to.equal(1);
    expect(atSeq[0].block_index, 'first writer wins').to.equal(10);
    // The unique key collapsing the loser is the safety property; saying so is the
    // difference between a diagnosable equivocation and a silent permanent fork.
    expect(nd.engine._seqConflicts, 'and the loser is reported, not dropped silently').to.equal(1);
    expect((await nd.engine.getStats()).seq_conflicts).to.equal(1);
  });
}
function registerSplitSuitePart5() {
  afterEach(async function () {
    for (let bus of buses) {
      for (let nd of bus.nodes) await nd.engine.stop();
    }
    buses = [];
  });
  describe('snapshot_block-derived seq + split-brain fence', function () {
    registerSplitSuitePart1();
    registerSplitSuitePart2();
    registerSplitSuitePart3();
    registerSplitSuitePart4();
  });
}
describe('StateCheckpointEngine', function () {
  registerSplitSuitePart5();
});
