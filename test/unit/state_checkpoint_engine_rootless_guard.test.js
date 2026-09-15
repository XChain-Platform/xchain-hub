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
const StateCheckpointEngine = require('../../src/anchor/checkpoint_engine');
const ValidatorIdentity = require('../../src/validators/identity');
const {
  waitUntil
} = require('../helpers/waitUntil');
const {
  DB_METHODS
} = require('../helpers/mockHub.js');

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
CHECKPOINT_COSIGN_TOLERANCE_BLOCKS: opts.cosignTolerance, BTC_INDEXER_URL: 'http://stub', LTC_INDEXER_URL: 'http://stub', DOGE_INDEXER_URL: 'http://stub' }, hubDbBroadcaster: { rows: [], broadcastRow(ev) { this.rows.push(ev); } }, capabilitySnapshot: { async getSnapshot() { return { validators: validators.slice(0, n) }; } }, getPeerManager: () => peerManager, getIdentity: () => identity, _resolveBtcLatestBlock: async () => opts.btcBlock != null ? opts.btcBlock : 100 }; self.db = db; self.hub = hub; self.engine = new StateCheckpointEngine(hub); self.engine._indexerCall = async (coin, method, params) => { let h = opts.hashesFor ? opts.hashesFor(self, params, coin) : TIP; return h ? Object.assign({}, h) : null; }; self.finalized = []; self.engine.on('checkpoint:finalized', ev => self.finalized.push(ev)); bus.nodes.push(self); } buses.push(bus); return bus; }
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

// ── The rootless-checkpoint guard runs on EVERY path ──────────
//
// The propose path always refused to sign a post-flag-day checkpoint with no
// light-client roots. That was the only place the rule lived, and it is the one
// path an attacker does not control. The canonical hides the gap: the root suffix
// is the EMPTY STRING when roots are null, so a rootless proposal and a rootless
// self-derivation produce byte-identical canonicals, the follower's "matches my
// indexer?" check passes, and it co-signs. Quorum then forms and every hub
// persists a checkpoint carrying none of the commitment its flag-day requires.

const ROOTED = {
  state_root: 'a'.repeat(64),
  state_root_version: 1,
  block_merkle_root: 'b'.repeat(64),
  block_merkle_version: 1
};
const ROOTLESS = {
  state_root: null,
  state_root_version: null,
  block_merkle_root: null,
  block_merkle_version: null
};
function cp(extra) {
  return Object.assign({
    chain: 'BTC',
    network: 'regtest',
    block_index: 10,
    block_hash: TIP.block_hash,
    ledger_hash: TIP.ledger_hash,
    actions_hash: TIP.actions_hash,
    contract_hash: TIP.contract_hash,
    checkpoint_seq: 200,
    snapshot_block: 200
  }, extra);
}
function registerSplitSuitePart1() {
  it('isRootless is true only when commitment is active AND a root is missing', function () {
    expect(StateCheckpointEngine.isRootless(cp(ROOTLESS)), 'active + no roots').to.equal(true);
    expect(StateCheckpointEngine.isRootless(cp(ROOTED)), 'active + roots').to.equal(false);
    // A partially-populated checkpoint is just as unusable as an empty one.
    expect(StateCheckpointEngine.isRootless(cp(Object.assign({}, ROOTED, {
      block_merkle_root: null
    }))), 'one missing root still counts').to.equal(true);
    expect(StateCheckpointEngine.isRootless(cp(Object.assign({}, ROOTED, {
      state_root_version: null
    }))), 'a missing VERSION still counts').to.equal(true);
    expect(StateCheckpointEngine.isRootless(null), 'null input').to.equal(false);
  });
  it('the canonical does NOT distinguish rootless from rooted, which is why the guard is needed', function () {
    // This is the property that made the co-sign check useless on its own: the
    // suffix collapses to '' so two rootless hubs agree byte-for-byte.
    const a = StateCheckpointEngine.canonicalCheckpoint(cp(ROOTLESS));
    const b = StateCheckpointEngine.canonicalCheckpoint(cp(ROOTLESS));
    expect(a).to.equal(b);
    expect(a).to.not.equal(StateCheckpointEngine.canonicalCheckpoint(cp(ROOTED)));
  });
  it('persist REFUSES a rootless checkpoint, writing neither snapshot nor row', async function () {
    let bus = buildMesh(1, {
      btcBlock: 200
    });
    let nd = bus.nodes[0];
    let before = nd.db.checkpoints.length;
    let threw = null;
    try {
      await nd.engine.acceptFinalized(cp(ROOTLESS), [{
        pubkey: nd.pubkey,
        sig: 'a'
      }], 1, true);
    } catch (e) {
      threw = e;
    }
    expect(threw, 'must fail closed rather than persist').to.not.equal(null);
    expect(String(threw.message)).to.match(/rootless checkpoint/);
    expect(nd.db.checkpoints.length, 'no row written').to.equal(before);
  });

  // ── SWQ gate plane, asserted rather than silently switched ──
  //
  // This engine resolves the stake-weighted-quorum gate on the DEPLOYMENT network
  // while StateAnchorPublisher resolves the same gate on the RECORD's network
  // (resolveQuorumNetwork). Two files, one gate, two planes. The v1 call is
  // kept on purpose: switching to cp.network would let a PEER choose this hub's
  // quorum rule by asserting a network in a gossiped checkpoint, which is worse
  // than the drift being fixed. So a genuine disagreement is refused loudly.
}
function registerSplitSuitePart2() {
  it('refuses a checkpoint whose network disagrees with the deployment network', async function () {
    let bus = buildMesh(1, {
      btcBlock: 200
    });
    let nd = bus.nodes[0];
    nd.engine.network = 'mainnet'; // deployment plane
    let threw = null;
    try {
      await nd.engine.acceptFinalized(cp(Object.assign({}, ROOTED, {
        network: 'regtest'
      })), [{
        pubkey: nd.pubkey,
        sig: 'a'
      }], 1, true);
    } catch (e) {
      threw = e;
    }
    expect(threw, 'a cross-network checkpoint must be refused').to.not.equal(null);
    expect(String(threw.message)).to.match(/network mismatch/);
    expect(String(threw.message), 'names BOTH values so it is diagnosable').to.match(/regtest[\s\S]*mainnet/);
    expect(nd.db.checkpoints.length, 'nothing persisted').to.equal(0);
  });

  // Third call site of the same predicate. The indexer byte-match further down
  // handleSignReq rebuilds the canonical with the network OUR OWN indexer reports,
  // so it sees record-vs-indexer drift and is blind to record-vs-DEPLOYMENT drift:
  // co-sign membership resolves the SWQ gate on this.network, so without this the
  // follower contributes a signature under one plane and then refuses the finalized
  // checkpoint under the other.
}
function registerSplitSuitePart3() {
  it('co-sign REFUSES a checkpoint whose network disagrees with the deployment network', async function () {
    let bus = buildMesh(2, {
      btcBlock: 200
    });
    let nd = bus.nodes[0];
    let other = bus.nodes[1];
    nd.engine.network = 'mainnet'; // deployment plane
    let types = [];
    let pm = nd.engine.peerManager;
    let orig = pm.broadcast.bind(pm);
    pm.broadcast = (type, data) => {
      types.push(type);
      return orig(type, data);
    };
    let threw = null;
    try {
      await nd.engine.handleSignReq({
        type: 'XCHK_SIGN_REQ',
        sender: other.pubkey,
        data: {
          checkpoint: cp(Object.assign({}, ROOTED, {
            network: 'regtest'
          })),
          sig_pubkey: other.pubkey,
          sig: 'a'
        }
      });
    } catch (e) {
      threw = e;
    }
    expect(threw, 'a cross-network SIGN_REQ must be refused, not silently co-signed').to.not.equal(null);
    expect(String(threw.message)).to.match(/network mismatch in co-sign/);
    expect(String(threw.message), 'names BOTH values so it is diagnosable').to.match(/regtest[\s\S]*mainnet/);
    expect(types.includes('XCHK_SIGN'), 'no co-signature left the hub').to.equal(false);
  });
}
function registerSplitSuitePart4() {
  it('accepts when the two agree', async function () {
    let bus = buildMesh(1, {
      btcBlock: 200
    });
    let nd = bus.nodes[0];
    // Both planes set to mainnet, where snapshot_block 200 is far below the
    // 961000 SWQ anchor, so the gate stays OFF and the mesh's count-based
    // capabilitySnapshot mock is the right shape. (Using regtest here would flip
    // SWQ on from genesis and need a weight snapshot the mock does not implement,
    // which tests the harness rather than the assert.)
    nd.engine.network = 'mainnet';
    await nd.engine.acceptFinalized(cp(Object.assign({}, ROOTED, {
      network: 'mainnet'
    })), [{
      pubkey: nd.pubkey,
      sig: 'a'
    }], 1, true);
    expect(nd.db.checkpoints.length).to.equal(1);
  });

  // An UNSCOPED hub is a different, already-documented problem (#2236): it
  // resolves every flag-day gate to OFF. It is warned about, not refused, because
  // refusing would take every unscoped deployment offline at once.
}
function registerSplitSuitePart5() {
  it('an unscoped hub warns once but keeps working (legacy path preserved)', async function () {
    let bus = buildMesh(1, {
      btcBlock: 200
    });
    let nd = bus.nodes[0];
    nd.engine.network = '';
    let warnings = [];
    let orig = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      await nd.engine.acceptFinalized(cp(ROOTED), [{
        pubkey: nd.pubkey,
        sig: 'a'
      }], 1, true);
      await nd.engine.acceptFinalized(cp(Object.assign({}, ROOTED, {
        checkpoint_seq: 201,
        snapshot_block: 201
      })), [{
        pubkey: nd.pubkey,
        sig: 'b'
      }], 1, true);
    } finally {
      console.warn = orig;
    }
    expect(nd.db.checkpoints.length, 'still persists').to.equal(2);
    let unscoped = warnings.filter(w => /NO deployment network/.test(w));
    expect(unscoped.length, 'warned exactly once, not per checkpoint').to.equal(1);
  });
  it('persist ACCEPTS the same checkpoint once the roots are present', async function () {
    let bus = buildMesh(1, {
      btcBlock: 200
    });
    let nd = bus.nodes[0];
    await nd.engine.acceptFinalized(cp(ROOTED), [{
      pubkey: nd.pubkey,
      sig: 'a'
    }], 1, true);
    expect(nd.db.checkpoints.length, 'a rooted checkpoint still persists normally').to.equal(1);
  });
}
function registerSplitSuitePart6() {
  afterEach(async function () {
    for (let bus of buses) {
      for (let nd of bus.nodes) await nd.engine.stop();
    }
    buses = [];
  });
  describe('rootless-checkpoint guard on co-sign and persist (#3092)', function () {
    registerSplitSuitePart1();
    registerSplitSuitePart2();
    registerSplitSuitePart3();
    registerSplitSuitePart4();
    registerSplitSuitePart5();
  });
}
describe('StateCheckpointEngine', function () {
  registerSplitSuitePart6();
});
