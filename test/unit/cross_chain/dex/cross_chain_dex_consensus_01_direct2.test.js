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
function registerDirect2Part1() {
  it('tolerates 1 of 4 refusing to validate (honest majority still finalizes)', async function () {
    let bus = rootSuiteBuildMesh(4, {
      validate: self => self.i !== 2
    }); // node 2 refuses
    await rootSuiteStartAll(bus);
    let mid = 'cc'.repeat(32),
      row = sampleRow(mid);
    await rootSuiteProposeAll(bus, mid, row);
    await waitUntil(() => [0, 1, 3].every(i => bus.nodes[i].finalized.length === 1), {
      label: 'the honest majority to finalize'
    });
    expect([0, 1, 3].every(i => bus.nodes[i].finalized.length === 1)).to.be.true;
  });
  it('does NOT finalize when 2 of 4 refuse (quorum unreachable, safety)', async function () {
    let bus = rootSuiteBuildMesh(4, {
      validate: self => !(self.i === 2 || self.i === 3)
    });
    await rootSuiteStartAll(bus);
    let mid = 'dd'.repeat(32),
      row = sampleRow(mid);
    await rootSuiteProposeAll(bus, mid, row);
    // Quorum is unreachable, so wait on the stall point instead: both validating
    // nodes have collected each other's signature and can collect no more.
    await waitUntil(() => [0, 1].every(i => {
      let p = bus.nodes[i].consensus.pending.get(mid);
      return p && p.signatures.size >= 2;
    }), {
      label: 'both honest nodes to collect the 2 available signatures'
    });
    expect(bus.nodes.some(nd => nd.finalized.length > 0)).to.be.false;
  });
  it('leader failover: a crashed leader is rotated out via view-change and the round finalizes', async function () {
    this.timeout(5000);
    let mid = 'ee'.repeat(32);
    let bus = rootSuiteBuildMesh(4, {
      roundTimeoutMs: 80
    });
    let crashed = bus.nodes.find(nd => nd.pubkey === rootSuiteLeaderPubkey(bus, mid, 0));
    crashed.crashed = true; // never participates
    await rootSuiteStartAll(bus);
    await rootSuiteProposeAll(bus, mid, sampleRow(mid));
    await waitUntil(() => bus.nodes.filter(nd => !nd.crashed && nd.finalized.length === 1).length === 3, {
      timeoutMs: 4000,
      label: 'the view-change rotation to finalize on every live node'
    });
    expect(bus.nodes.filter(nd => !nd.crashed && nd.finalized.length === 1).length).to.equal(3);
  });
}
function registerDirect2Part2() {
  it('leader failover finalizes when the canonical folds the view (EQUIV header active; H-8 regression)', async function () {
    // With the EQUIV header active, canonicalMatch(row, view) moves with the
    // view, so a new-view leader that re-signs the view-0 canonical produces a
    // PROPOSE no follower verifies (they recompute at d.view) and failover is
    // dead. This pins the fix: the rotated leader rebuilds + re-signs the
    // canonical for the current view, followers (including any that already
    // sent COMMIT in the old view) re-adopt the value-identical new-view
    // canonical, and the round finalizes with signatures that verify under
    // the FINAL view's canonical, not view 0's.
    this.timeout(5000);
    const equivCanonical = (r, view) => canonicalMatch(r) + '|EQ|' + Number(view || 0);
    let mid = 'ee'.repeat(32);
    let bus = rootSuiteBuildMesh(4, {
      roundTimeoutMs: 80,
      canonical: equivCanonical
    });
    let crashed = bus.nodes.find(nd => nd.pubkey === rootSuiteLeaderPubkey(bus, mid, 0));
    crashed.crashed = true; // never participates
    await rootSuiteStartAll(bus);
    await rootSuiteProposeAll(bus, mid, sampleRow(mid));
    await waitUntil(() => bus.nodes.filter(nd => !nd.crashed && nd.finalized.length === 1).length === 3, {
      timeoutMs: 4000,
      label: 'the view-folding rotation to finalize on every live node'
    });
    let live = bus.nodes.filter(nd => !nd.crashed);
    expect(live.filter(nd => nd.finalized.length === 1).length, 'all live nodes finalize').to.equal(3);
    let ev = live[0].finalized[0];
    expect(ev.view, 'the round finalized under a post-failover view').to.be.at.least(1);
    let finalCanon = equivCanonical(ev.row, ev.view);
    expect(ev.signatures.length).to.be.at.least(3);
    expect(ev.signatures.every(s => ValidatorIdentity.verify(finalCanon, s.sig, s.pubkey)), 'every quorum signature verifies under the final view canonical').to.be.true;
    expect(ev.signatures.some(s => ValidatorIdentity.verify(equivCanonical(ev.row, 0), s.sig, s.pubkey)), 'no stale view-0 signature survives into the quorum set').to.be.false;
  });
}
function registerDirect2Part3() {
  it('abandons a stale round past its max lifetime and emits match:abandoned (so the engine re-proposes)', async function () {
    // Sustained message loss (e.g. P2P rate-limit drops during a burst) keeps a
    // round view-changing without ever reaching quorum. Model it by dropping ALL
    // gossip: the proposer never collects PREPAREs/COMMITs, so the round can only
    // time out. Past roundMaxLifetimeMs it must be ABANDONED (pending released +
    // event) rather than leaking forever, which is what once wedged calls
    // until a process restart.
    this.timeout(5000);
    let bus = rootSuiteBuildMesh(4, {
      roundTimeoutMs: 40,
      drop: () => true
    }); // drop every gossip message
    let victim = bus.nodes[0];
    victim.consensus.roundMaxLifetimeMs = 150; // abandon after ~150ms of churn
    let abandoned = [];
    victim.consensus.on('match:abandoned', ev => abandoned.push(ev.matchId));
    await rootSuiteStartAll(bus);
    let mid = 'ab'.repeat(32);
    await victim.consensus.propose(mid, {
      row: sampleRow(mid),
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 4
      }
    });
    expect(victim.consensus.pending.has(mid), 'round is live before abandon').to.be.true;
    await waitUntil(() => abandoned.length > 0, {
      timeoutMs: 4000,
      label: 'the round to exceed its max lifetime and abandon'
    });
    expect(abandoned, 'emitted match:abandoned for exactly this round').to.deep.equal([mid]);
    expect(victim.consensus.pending.has(mid), 'pending released so propose() can re-run').to.be.false;
    expect(victim.finalized.length, 'never finalized').to.equal(0);
  });
  it('does not abandon a round that finalizes within its max lifetime', async function () {
    // Healthy mesh: the round finalizes normally and must NOT emit match:abandoned
    // even though the lifetime budget is short.
    this.timeout(5000);
    let bus = rootSuiteBuildMesh(4, {
      roundTimeoutMs: 40
    });
    bus.nodes.forEach(nd => {
      nd.consensus.roundMaxLifetimeMs = 150;
      nd._abandoned = [];
      nd.consensus.on('match:abandoned', ev => nd._abandoned.push(ev.matchId));
    });
    await rootSuiteStartAll(bus);
    let mid = 'cd'.repeat(32);
    await rootSuiteProposeAll(bus, mid, sampleRow(mid));
    await waitUntil(() => bus.nodes.filter(nd => nd.finalized.length === 1).length === 4, {
      timeoutMs: 4000,
      label: 'every node to finalize inside the lifetime budget'
    });
    expect(bus.nodes.filter(nd => nd.finalized.length === 1).length, 'all finalized').to.equal(4);
    expect(bus.nodes.every(nd => nd._abandoned.length === 0), 'none abandoned').to.be.true;
  });
}
function registerDirect2Part4() {
  it('guard: a tampered-row PROPOSE (fails independent validation) is not signed', async function () {
    // Followers no longer require byte-equality with their locally pre-built
    // canonical (leader-choice fields legitimately differ); independent
    // validation is the gate. Model an engine that, like the real ones,
    // verifies business fields against its own data.
    let bus = rootSuiteBuildMesh(4, {
      validate: () => true
    });
    bus.nodes.forEach(nd => {
      nd.consensus.engine.validateProposedMatch = async row => String(row.a_amount) === '1000';
    });
    await rootSuiteStartAll(bus);
    let mid = 'ff'.repeat(32),
      row = sampleRow(mid);
    let victim = bus.nodes[0];
    await victim.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 4
      }
    });
    let leaderPk = rootSuiteLeaderPubkey(bus, mid, 0);
    let leaderNode = bus.nodes.find(nd => nd.pubkey === leaderPk);
    let badRow = Object.assign({}, row, {
      a_amount: '999999'
    });
    let badSig = leaderNode.identity.sign(canonicalMatch(badRow));
    let before = victim.consensus.pending.get(mid).signatures.size;
    // handleMessage fires the PROPOSE branch and forgets it, so drive the async
    // handler directly: its completion IS the verdict, with nothing left to settle.
    await victim.consensus.handlePropose({
      type: 'XDEX_MATCH_PROPOSE',
      sender: leaderPk,
      data: {
        matchId: mid,
        view: 0,
        row: badRow,
        sig_pubkey: leaderPk,
        sig: badSig
      }
    });
    expect(victim.consensus.pending.get(mid).signatures.size).to.equal(before);
    expect(victim.consensus.pending.get(mid).canonical).to.equal(canonicalMatch(row)); // no adoption either
  });
}
function registerDirect2() {
  registerDirect2Part1();
  registerDirect2Part2();
  registerDirect2Part3();
  registerDirect2Part4();
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
  registerDirect2();
});
