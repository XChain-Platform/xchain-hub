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

// ── Follower co-sign freshness bound (finding 1781) ─────────────────────
// The follower must decline to co-sign a SIGN_REQ whose leader-supplied
// snapshot_block deviates from its OWN resolved BTC tip beyond
// cosignToleranceBlocks. snapshot_block selects the validator set and every
// flag-day gate, so an unbounded stale value enables leader-grinding and
// flag-day regression. Fail-closed when we cannot resolve our own tip.

// Build a valid SIGN_REQ for `snapshotBlock`, signed by the cadence
// leader for that block, using the shared TIP block data.
function makeSignReq(bus, snapshotBlock) {
  let leader = leaderNode(bus, snapshotBlock);
  let cp = {
    chain: 'BTC',
    network: TIP.network,
    block_index: TIP.block_index,
    block_hash: TIP.block_hash,
    ledger_hash: TIP.ledger_hash,
    actions_hash: TIP.actions_hash,
    contract_hash: TIP.contract_hash,
    // seq is derived from snapshot_block; use the derived value so
    // these freshness-bound cases exercise the freshness guard, not the seq guard.
    checkpoint_seq: snapshotBlock,
    snapshot_block: snapshotBlock,
    state_root: TIP.state_root,
    state_root_version: TIP.state_root_version,
    block_merkle_root: TIP.block_merkle_root,
    block_merkle_version: TIP.block_merkle_version
  };
  let canonical = StateCheckpointEngine.canonicalCheckpoint(cp);
  let sig = leader.identity.sign(canonical);
  let env = {
    type: 'XCHK_SIGN_REQ',
    sender: leader.pubkey,
    data: {
      checkpoint: cp,
      sig_pubkey: leader.pubkey,
      sig
    }
  };
  let follower = bus.nodes.find(nd => nd.pubkey !== leader.pubkey);
  return {
    env,
    follower
  };
}

// Record XCHK_SIGN co-sign broadcasts from a follower.
function watchCosign(follower) {
  let signs = [];
  let pm = follower.engine.peerManager;
  let orig = pm.broadcast.bind(pm);
  pm.broadcast = (type, data) => {
    if (type === 'XCHK_SIGN') signs.push(data);
    return orig(type, data);
  };
  return signs;
}
function registerSplitSuitePart1() {
  it('co-signs a SIGN_REQ whose snapshot_block matches our own BTC tip (fresh)', async function () {
    let SNAP = 500;
    let bus = buildMesh(2, {
      btcBlock: SNAP,
      confirmations: 0
    });
    let {
      env,
      follower
    } = makeSignReq(bus, SNAP);
    follower.hub.resolveBtcLatestBlock = async () => SNAP; // exactly fresh
    let signs = watchCosign(follower);
    await follower.engine.handleSignReq(env);
    expect(signs.length, 'follower co-signed a fresh snapshot_block').to.equal(1);
  });
  it('declines to co-sign when snapshot_block is staler than the tolerance', async function () {
    let SNAP = 500;
    let bus = buildMesh(2, {
      btcBlock: SNAP,
      confirmations: 0
    });
    let {
      env,
      follower
    } = makeSignReq(bus, SNAP);
    // Our tip has moved well past the proposed snapshot_block (> default 144).
    follower.hub.resolveBtcLatestBlock = async () => SNAP + 200;
    expect(200).to.be.greaterThan(follower.engine.cosignToleranceBlocks);
    let signs = watchCosign(follower);
    await follower.engine.handleSignReq(env);
    expect(signs.length, 'stale snapshot_block declined').to.equal(0);
  });
}
function registerSplitSuitePart2() {
  it('fails closed (declines) when it cannot resolve its own BTC tip', async function () {
    let SNAP = 500;
    let bus = buildMesh(2, {
      btcBlock: SNAP,
      confirmations: 0
    });
    let {
      env,
      follower
    } = makeSignReq(bus, SNAP);
    follower.hub.resolveBtcLatestBlock = async () => null; // no own tip
    let signs = watchCosign(follower);
    await follower.engine.handleSignReq(env);
    expect(signs.length, 'missing own tip fails closed').to.equal(0);
  });

  // Review board #7582: a MALFORMED tolerance must not disable this whole guard.
  // parseInt('invalid') is NaN and `Math.abs(delta) > NaN` is always false, so an
  // unclamped typo in CHECKPOINT_COSIGN_TOLERANCE_BLOCKS silently removes the
  // freshness bound on a wire field that selects the validator set, the leader
  // ladder and every flag-day gate. The constructor clamps to the default on any
  // non-negative failure, which is the idiom `confirmations` two lines above uses.
  it('a MALFORMED tolerance falls back to the default and still declines a stale request', async function () {
    let SNAP = 500;
    let bus = buildMesh(2, {
      btcBlock: SNAP,
      confirmations: 0,
      cosignTolerance: 'invalid'
    });
    let {
      env,
      follower
    } = makeSignReq(bus, SNAP);
    expect(follower.engine.cosignToleranceBlocks, 'a nonnumeric value must not become NaN').to.equal(144);
    follower.hub.resolveBtcLatestBlock = async () => SNAP + 9900;
    let signs = watchCosign(follower);
    await follower.engine.handleSignReq(env);
    expect(signs.length, 'a 9,900-block-stale snapshot_block must be declined').to.equal(0);
  });
}
function registerSplitSuitePart3() {
  it('honours a VALID operator tolerance in both directions', async function () {
    let SNAP = 500;
    let bus = buildMesh(2, {
      btcBlock: SNAP,
      confirmations: 0,
      cosignTolerance: '10'
    });
    let {
      env,
      follower
    } = makeSignReq(bus, SNAP);
    expect(follower.engine.cosignToleranceBlocks).to.equal(10);
    follower.hub.resolveBtcLatestBlock = async () => SNAP + 5; // inside the window
    let signs = watchCosign(follower);
    await follower.engine.handleSignReq(env);
    expect(signs.length, 'a value the default would also accept is co-signed').to.equal(1);
    let bus2 = buildMesh(2, {
      btcBlock: SNAP,
      confirmations: 0,
      cosignTolerance: '10'
    });
    let second = makeSignReq(bus2, SNAP);
    second.follower.hub.resolveBtcLatestBlock = async () => SNAP + 50; // outside 10, inside 144
    let signs2 = watchCosign(second.follower);
    await second.follower.engine.handleSignReq(second.env);
    expect(signs2.length, 'a tightened window is actually enforced').to.equal(0);
  });
}
function registerSplitSuitePart4() {
  afterEach(async function () {
    for (let bus of buses) {
      for (let nd of bus.nodes) await nd.engine.stop();
    }
    buses = [];
  });
  describe('co-sign freshness bound (finding 1781)', function () {
    registerSplitSuitePart1();
    registerSplitSuitePart2();
    registerSplitSuitePart3();
  });
}
describe('StateCheckpointEngine', function () {
  registerSplitSuitePart4();
});
