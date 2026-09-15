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

// In-process PBFT mesh: K CrossChainDexConsensus instances share a mock gossip
// bus (broadcast fans out to every other instance's handleMessage), each with a
// real ValidatorIdentity. Exercises the full round (PROPOSE/PREPARE/COMMIT),
// single-node fallback, Byzantine-value tolerance, leader-failover via
// view-change, and the tamper / NEW_VIEW guards. The same properties validated
// for AttestationConsensus/Consensus can only be checked in a mesh.

const { expect }             = require('chai');
const CrossChainDexConsensus = require('../../../../src/cross_chain/dex_consensus');
const ValidatorIdentity      = require('../../../../src/validators/identity');
const { waitUntil }          = require('../../../helpers/waitUntil');

// Canonical format byte-identical to the indexer verifier (cross_settle.canonical).
function canonicalMatch(r) {
    return ['XMATCH', r.match_id, String(r.snapshot_block),
        r.a_chain, String(r.a_action_index), r.a_tick || '', String(r.a_amount), String(r.a_ownership), r.a_payout_addr,
        r.b_chain, String(r.b_action_index), r.b_tick || '', String(r.b_amount), String(r.b_ownership), r.b_payout_addr,
        String(r.effective_time), r.network || ''].join('|');
}
function sampleRow(matchId) {
    return { match_id: matchId, snapshot_block: 100, network: 'regtest',
        a_chain: 'LTC', a_action_index: 5, a_tick: 'TOKA', a_amount: '1000', a_ownership: 0, a_payout_addr: 'Lpay',
        b_chain: 'DOGE', b_action_index: 8, b_tick: 'TOKB', b_amount: '2000', b_ownership: 0, b_payout_addr: 'Dpay',
        effective_time: 1700000000 };
}

let rootSuiteBuses = [];
// Build n consensus instances over a shared in-memory gossip bus.
// opts.validate(self) → bool (default true); opts.drop(self,other,type,data) → bool;
// opts.roundTimeoutMs → view-change timeout.
function rootSuiteBuildMesh(n, opts) {
  opts = opts || {};
  let bus = {
    nodes: []
  };
  for (let i = 0; i < n; i++) {
    let identity = new ValidatorIdentity(String(10 + i).repeat(32).slice(0, 64));
    let self = {
      i,
      identity,
      pubkey: identity.getPubkeyHex().toLowerCase(),
      handler: null,
      crashed: false
    };
    let peerManager = {
      validatorAddr: self.pubkey,
      on(evt, h) {
        if (evt === 'message') self.handler = h;
      },
      removeListener(evt) {
        if (evt === 'message') self.handler = null;
      },
      broadcast(type, data) {
        let env = {
          type,
          sender: self.pubkey,
          data
        };
        for (let other of bus.nodes) {
          if (other === self || other.crashed) continue;
          if (opts.drop && opts.drop(self, other, type, data)) continue;
          if (other.handler) other.handler(env);
        }
      }
    };
    let engine = {
      hub: {
        p2pConfig: {
          XDEX_ROUND_TIMEOUT_MS: opts.roundTimeoutMs || 120000
        }
      },
      peerManager,
      identity,
      capSnapshot: null,
      // opts.canonical simulates the EQUIV-header-active engine, whose
      // canonical folds the view (H-8 regression); default ignores view.
      canonicalMatch: opts.canonical || canonicalMatch,
      persistCapabilitySnapshot: async () => {},
      validateProposedMatch: async () => opts.validate ? opts.validate(self) : true
    };
    self.consensus = new CrossChainDexConsensus(engine);
    self.finalized = [];
    self.consensus.on('match:finalized', ev => self.finalized.push(ev));
    bus.nodes.push(self);
  }
  rootSuiteBuses.push(bus);
  return bus;
}
// STAKE_WEIGHTED_QUORUM (WI-1) is active at regtest snapshot_block 0+, so the
// round finalizes on summed signer STAKE (source-deduped, 3·Σweight > 2·S) rather
// than signer count. Each node is its OWN distinct staking source with weight 1,
// so the equal-stake mesh reduces to the same 2f+1 threshold the count rule gave:
// a blank/missing source fails closed in meetsStakeThreshold (never finalizes).
// STAKE_WEIGHTED_QUORUM (WI-1) is active at regtest snapshot_block 0+, so the
// round finalizes on summed signer STAKE (source-deduped, 3·Σweight > 2·S) rather
// than signer count. Each node is its OWN distinct staking source with weight 1,
// so the equal-stake mesh reduces to the same 2f+1 threshold the count rule gave:
// a blank/missing source fails closed in meetsStakeThreshold (never finalizes).
function rootSuiteValidatorsOf(bus) {
  return bus.nodes.map(nd => ({
    pubkey: nd.pubkey,
    source: 'src:' + nd.pubkey,
    weight: '1',
    amount: '1'
  }));
}
async function rootSuiteStartAll(bus) {
  for (let nd of bus.nodes) await nd.consensus.start();
}
function rootSuiteLeaderPubkey(bus, matchId, view) {
  let sorted = bus.nodes.map(nd => nd.pubkey).sort();
  return sorted[(parseInt(matchId.slice(0, 8), 16) + (view || 0)) % sorted.length];
}
async function rootSuiteProposeAll(bus, mid, row) {
  let snap = {
    validators: rootSuiteValidatorsOf(bus),
    count: bus.nodes.length
  };
  for (let nd of bus.nodes) if (!nd.crashed) await nd.consensus.propose(mid, {
    row,
    snapshot: snap
  });
}
// Adopting the leader's row moved pending.row and pending.canonical but left
// pending.validators / quorum / weighted bound to the snapshot the round OPENED
// over. snapshot_block is a leader-choice field, so the adopted row can declare a
// different one, and the indexer consumers re-derive the set at the row's DECLARED
// block: a four-signature finalize under the old set is a row the seven-member set
// at the declared block needed five for, and every consumer retires it.
function rootSuiteReboundMesh(extraCount) {
  let bus = rootSuiteBuildMesh(4);
  let extra = [];
  for (let i = 0; i < extraCount; i++) {
    let id = new ValidatorIdentity(String(50 + i).repeat(32).slice(0, 64));
    extra.push(id.getPubkeyHex().toLowerCase());
  }
  // The set at the DECLARED block: the four mesh members plus `extraCount` more,
  // each its own staking source so the weighted tally does not dedupe them away.
  let declared = bus.nodes.map(nd => nd.pubkey).concat(extra).map(pk => ({
    pubkey: pk,
    source: 'src:' + pk,
    weight: '1',
    amount: '1'
  }));
  bus.nodes.forEach(nd => {
    nd.consensus.engine.resolveCapabilityValidators = async () => declared.slice();
  });
  return bus;
}
async function rootSuiteDrivePropose(bus, victim, mid, proposedRow) {
  let leaderPk = rootSuiteLeaderPubkey(bus, mid, 0);
  let leaderNode = bus.nodes.find(nd => nd.pubkey === leaderPk);
  let sig = leaderNode.identity.sign(canonicalMatch(proposedRow));
  await victim.consensus.handlePropose({
    type: 'XDEX_MATCH_PROPOSE',
    sender: leaderPk,
    data: {
      matchId: mid,
      view: 0,
      row: proposedRow,
      sig_pubkey: leaderPk,
      sig
    }
  });
}
function registerDirect1Part1() {
  it('N=4: reaches 2f+1 and every node finalizes the same match with verifying sigs', async function () {
    let bus = rootSuiteBuildMesh(4);
    await rootSuiteStartAll(bus);
    let mid = 'aa'.repeat(32),
      row = sampleRow(mid);
    await rootSuiteProposeAll(bus, mid, row);
    await waitUntil(() => bus.nodes.every(nd => nd.finalized.length === 1), {
      label: 'every node to finalize the match'
    });
    expect(bus.nodes.every(nd => nd.finalized.length === 1)).to.be.true;
    let ev = bus.nodes[0].finalized[0];
    expect(ev.signatures.length).to.be.at.least(3); // quorum 2f+1 = 3
    let canon = canonicalMatch(row);
    expect(ev.signatures.every(s => ValidatorIdentity.verify(canon, s.sig, s.pubkey))).to.be.true;
    expect(bus.nodes.every(nd => nd.finalized[0].matchId === mid)).to.be.true;
  });
  it('N=1: quorum 0 collapses to immediate self-sign + finalize', async function () {
    let bus = rootSuiteBuildMesh(1);
    await rootSuiteStartAll(bus);
    let mid = 'bb'.repeat(32),
      row = sampleRow(mid);
    await rootSuiteProposeAll(bus, mid, row);
    await waitUntil(() => bus.nodes[0].finalized.length === 1, {
      label: 'the single-node round to self-finalize'
    });
    let ev = bus.nodes[0].finalized[0];
    expect(ev).to.exist;
    expect(ev.signatures.length).to.equal(1);
    expect(ValidatorIdentity.verify(canonicalMatch(row), ev.signatures[0].sig, ev.signatures[0].pubkey)).to.be.true;
  });

  // M-13: after a round finalizes, its id sits in the finalized ring and propose()
  // is a no-op (steady-state dedup). A reorg that RETRACTS the row then re-confirms
  // the action must be able to re-run the round; forgetFinalized drops the ring
  // entry so the next propose() finalizes a FRESH round instead of stranding the
  // call/match in 'retracted' forever.
}
function registerDirect1Part2() {
  // M-13: after a round finalizes, its id sits in the finalized ring and propose()
  // is a no-op (steady-state dedup). A reorg that RETRACTS the row then re-confirms
  // the action must be able to re-run the round; forgetFinalized drops the ring
  // entry so the next propose() finalizes a FRESH round instead of stranding the
  // call/match in 'retracted' forever.
  it('forgetFinalized lets a retracted-then-reconfirmed round re-finalize (M-13)', async function () {
    let bus = rootSuiteBuildMesh(1);
    await rootSuiteStartAll(bus);
    let nd = bus.nodes[0];
    let mid = 'cc'.repeat(32),
      row = sampleRow(mid);
    await nd.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 1
      }
    });
    await waitUntil(() => nd.finalized.length === 1, {
      label: 'the first round to finalize'
    });
    expect(nd.finalized.length).to.equal(1);
    expect(nd.consensus.finalized.has(mid)).to.equal(true);

    // Without forgetting, a re-propose is suppressed by the finalized ring.
    await nd.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 1
      }
    });
    // The finalized ring is consulted inside propose(), so the duplicate is already
    // suppressed here; a settle would only add dead time to a decided outcome.
    expect(nd.finalized.length).to.equal(1, 'ring must suppress a duplicate finalize');

    // Retraction clears the ring; the next propose runs a fresh round.
    expect(nd.consensus.forgetFinalized(mid)).to.equal(true);
    expect(nd.consensus.finalized.has(mid)).to.equal(false);
    await nd.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 1
      }
    });
    await waitUntil(() => nd.finalized.length === 2, {
      label: 'the re-proposed round to finalize a second time'
    });
    expect(nd.finalized.length).to.equal(2, 're-confirmed action must re-finalize after retraction');
  });
}
function registerDirect1Part3() {
  it('does NOT self-finalize over an EMPTY snapshot (bootstrap/mirror-lag wedge guard)', async function () {
    // quorum 0 from an empty snapshot must NOT collapse to the single-operator
    // fast path: a 1-sig match no populated-snapshot peer will ratify wedges the
    // order and forks this hub's ledger. The round must abort and stay retryable.
    let bus = rootSuiteBuildMesh(1);
    await rootSuiteStartAll(bus);
    let mid = 'ab'.repeat(32),
      row = sampleRow(mid);
    let abandoned = [];
    bus.nodes[0].consensus.on('match:abandoned', ev => abandoned.push(String(ev.matchId)));
    await bus.nodes[0].consensus.propose(mid, {
      row,
      snapshot: {
        validators: [],
        count: 0
      }
    });
    // The refusal announces itself: match:abandoned is what releases the engine slot.
    await waitUntil(() => abandoned.includes(mid.toLowerCase()), {
      label: 'the empty-snapshot round to abandon'
    });
    expect(bus.nodes[0].finalized.length).to.equal(0);
    // Aborted, not left half-open: a later propose with a real snapshot can retry.
    expect(bus.nodes[0].consensus.pending.has(mid.toLowerCase())).to.be.false;
    // The refuse must emit match:abandoned so the engine releases its _inflight slot;
    // without it the engine (which added round_id to _inflight before propose) never
    // re-attempts the call/match on this hub even once the snapshot populates.
    expect(abandoned).to.include(mid.toLowerCase());
  });
  it('fails CLOSED over a TRUNCATED weighted snapshot and releases the round (SWQ-TRUNC)', async function () {
    // At/above STAKE_WEIGHTED_QUORUM (regtest = genesis) a snapshot that overflowed
    // VALIDATOR_QUERY_LIMIT under-counts summed stake S; every indexer consumer fails
    // closed on it, so the hub must refuse rather than mirror a row all indexers reject.
    let bus = rootSuiteBuildMesh(4);
    await rootSuiteStartAll(bus);
    let mid = 'ad'.repeat(32),
      row = sampleRow(mid); // regtest snapshot_block 100 -> weighted
    let abandoned = [];
    for (let nd of bus.nodes) nd.consensus.on('match:abandoned', ev => abandoned.push(String(ev.matchId)));
    let snap = {
      validators: rootSuiteValidatorsOf(bus),
      count: bus.nodes.length
    };
    snap.validators.truncated = true; // indexer hit VALIDATOR_QUERY_LIMIT
    for (let nd of bus.nodes) await nd.consensus.propose(mid, {
      row,
      snapshot: snap
    });
    await waitUntil(() => abandoned.filter(m => m === mid.toLowerCase()).length === bus.nodes.length, {
      label: 'every node to abandon the truncated weighted round'
    });
    expect(bus.nodes.every(nd => nd.finalized.length === 0), 'no node finalizes a truncated weighted round').to.be.true;
    expect(bus.nodes.every(nd => nd.consensus.pending.has(mid.toLowerCase()) === false), 'round released, retryable').to.be.true;
    expect(abandoned.filter(m => m === mid.toLowerCase()).length).to.equal(bus.nodes.length, 'each node releases its inflight slot');
  });
}
function registerDirect1Part4() {
  it('a TRUNCATED count snapshot (below STAKE_WEIGHTED_QUORUM) still finalizes (deterministic cap)', async function () {
    // The count path is proceed-on-truncation: the cap is cross-hub deterministic, so
    // quorum stays consistent fleet-wide (CapabilitySnapshot.getQuorum). Only the
    // weighted path fails closed.
    let bus = rootSuiteBuildMesh(4);
    await rootSuiteStartAll(bus);
    let mid = 'ae'.repeat(32),
      row = sampleRow(mid);
    row.network = 'mainnet';
    row.snapshot_block = 100; // below 961000 -> count path
    let snap = {
      validators: rootSuiteValidatorsOf(bus),
      count: bus.nodes.length
    };
    snap.validators.truncated = true;
    for (let nd of bus.nodes) await nd.consensus.propose(mid, {
      row,
      snapshot: snap
    });
    await waitUntil(() => bus.nodes.every(nd => nd.finalized.length === 1), {
      label: 'the count path to finalize on every node'
    });
    expect(bus.nodes.every(nd => nd.finalized.length === 1), 'count path proceeds on a deterministic truncation cap').to.be.true;
  });
  it('does NOT self-finalize when the sole snapshot validator is someone else', async function () {
    let bus = rootSuiteBuildMesh(1);
    await rootSuiteStartAll(bus);
    let mid = 'ac'.repeat(32),
      row = sampleRow(mid);
    let stranger = ValidatorIdentity.generate().pubkeyHex.toLowerCase();
    await bus.nodes[0].consensus.propose(mid, {
      row,
      snapshot: {
        validators: [{
          pubkey: stranger,
          source: 'src:' + stranger,
          weight: '1',
          amount: '1'
        }],
        count: 1
      }
    });
    // propose() resolves the elected-signer check inline, so the refusal is decided
    // by the time it returns.
    expect(bus.nodes[0].finalized.length).to.equal(0);
  });
}
function registerDirect1() {
  registerDirect1Part1();
  registerDirect1Part2();
  registerDirect1Part3();
  registerDirect1Part4();
}
describe('CrossChainDexConsensus (PBFT mesh)', function () {
  afterEach(async function () {
    for (let bus of rootSuiteBuses) {
      for (let nd of bus.nodes) await nd.consensus.stop();
    }
    rootSuiteBuses = [];
  });

  // Build n consensus instances over a shared in-memory gossip bus.
  // opts.validate(self) → bool (default true); opts.drop(self,other,type,data) → bool;
  // opts.roundTimeoutMs → view-change timeout.
  registerDirect1();
});
