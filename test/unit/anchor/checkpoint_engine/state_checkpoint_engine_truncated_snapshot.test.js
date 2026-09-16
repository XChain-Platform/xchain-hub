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

// ── XCHK-TRUNC-1: an over-cap (truncated) weighted oracle_publish snapshot must carry
// its .truncated flag through resolveCapabilityValidators so meetsStakeThreshold fails
// closed; otherwise the under-counted stake S lets a minority clear the 2/3 bar and
// finalize a checkpoint a full snapshot would reject (the XHUB-TRUNC-1 root, missed here). ──
function registerSplitSuitePart1() {
  afterEach(async function () {
    for (let bus of buses) {
      for (let nd of bus.nodes) await nd.engine.stop();
    }
    buses = [];
  });
}
function registerSplitSuitePart2() {
  describe('truncated-snapshot fail-closed (XCHK-TRUNC-1)', function () {
    const swq = require('../../../../src/consensus/stake_weighted_quorum');
    function makeEngine(snapshotResult) {
      let eng = new StateCheckpointEngine({
        db: {
          ...DB_METHODS,
          doQuery: async () => []
        },
        network: 'regtest'
      });
      eng.capSnapshot = {
        getWeightSnapshot: async () => snapshotResult
      };
      return eng;
    }
    it('carries truncated=true through the weighted resolver, so meetsStakeThreshold fails closed', async function () {
      let eng = makeEngine({
        validators: [{
          pubkey: 'aa',
          source: 's1',
          weight: '100'
        }],
        truncated: true
      });
      let validators = await eng.resolveCapabilityValidators('oracle_publish', 100);
      expect(validators.truncated).to.be.true;
      // The exact computation handleFinalized runs (weighted path) now refuses.
      expect(swq.meetsStakeThreshold(validators, ['aa'])).to.be.false;
    });
    it('leaves the flag unset for a non-truncated snapshot (quorum proceeds normally)', async function () {
      let eng = makeEngine({
        validators: [{
          pubkey: 'aa',
          source: 's1',
          weight: '100'
        }],
        truncated: false
      });
      let validators = await eng.resolveCapabilityValidators('oracle_publish', 100);
      expect(validators.truncated).to.be.undefined;
      expect(swq.meetsStakeThreshold(validators, ['aa'])).to.be.true;
    });
  });
}
describe('StateCheckpointEngine', function () {
  registerSplitSuitePart1();
  registerSplitSuitePart2();
});
