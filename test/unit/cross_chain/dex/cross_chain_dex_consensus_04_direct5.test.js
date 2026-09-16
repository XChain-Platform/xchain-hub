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
function registerDirect5Part1() {
  it('A-F3: NEW_VIEW does not advance the view without a local view-change quorum', async function () {
    let bus = rootSuiteBuildMesh(4);
    await rootSuiteStartAll(bus);
    let mid = 'ac'.repeat(32),
      row = sampleRow(mid);
    let victim = bus.nodes[0];
    await victim.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 4
      }
    });
    let p = victim.consensus.pending.get(mid);
    let nextView = p.view + 1;
    let ldPk = rootSuiteLeaderPubkey(bus, mid, nextView);
    let ldNode = bus.nodes.find(nd => nd.pubkey === ldPk);
    let nv = {
      type: 'XDEX_MATCH_NEW_VIEW',
      sender: ldPk,
      data: {
        matchId: mid,
        view: nextView,
        sig_pubkey: ldPk,
        sig: ldNode.identity.sign('XDEXNV|' + mid + '|' + nextView)
      }
    };

    // Valid leader signature but NO view-change votes collected locally: must
    // not drag the view forward (this is the A-F3 griefing vector).
    victim.consensus.handleMessage(nv);
    expect(victim.consensus.pending.get(mid).view).to.equal(p.view);

    // With a real 2f+1 view-change quorum present locally, the same NEW_VIEW
    // legitimately advances.
    let voters = new Set(bus.nodes.slice(0, 3).map(nd => nd.pubkey));
    victim.consensus.pending.get(mid).viewChanges.set(nextView, voters);
    victim.consensus.handleMessage(nv);
    expect(victim.consensus.pending.get(mid).view).to.equal(nextView);
  });

  // Adopting the leader's row moved pending.row and pending.canonical but left
  // pending.validators / quorum / weighted bound to the snapshot the round OPENED
  // over. snapshot_block is a leader-choice field, so the adopted row can declare a
  // different one, and the indexer consumers re-derive the set at the row's DECLARED
  // block: a four-signature finalize under the old set is a row the seven-member set
  // at the declared block needed five for, and every consumer retires it.
}
function registerDirect5Part2() {
  it('rebinds membership and quorum to the snapshot the adopted row declares', async function () {
    let bus = rootSuiteReboundMesh(3);
    await rootSuiteStartAll(bus);
    let mid = '1a'.repeat(32),
      row = sampleRow(mid);
    let victim = bus.nodes[0];
    await victim.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 4
      }
    });
    let pending = victim.consensus.pending.get(mid);
    expect(pending.validators.length, 'round opens over the four-member set').to.equal(4);
    expect(pending.quorum).to.equal(3);
    await rootSuiteDrivePropose(bus, victim, mid, Object.assign({}, row, {
      snapshot_block: 101
    }));
    pending = victim.consensus.pending.get(mid);
    expect(pending.row.snapshot_block, 'the leader row was adopted').to.equal(101);
    expect(pending.validators.length, 'membership follows the declared snapshot').to.equal(7);
    expect(pending.quorum, 'and so does the threshold').to.equal(5);
  });

  // The negative half of the pair, and the one that makes the case above evidence
  // rather than an assertion about a code path nothing enters: with the round still
  // bound to the four-member set, three signatures cleared the bar. Against the
  // seven-member set the row declares, the same three do not.
  // The negative half of the pair, and the one that makes the case above evidence
  // rather than an assertion about a code path nothing enters: with the round still
  // bound to the four-member set, three signatures cleared the bar. Against the
  // seven-member set the row declares, the same three do not.
  it('the pre-adoption set would have cleared a bar the declared snapshot does not', async function () {
    let bus = rootSuiteReboundMesh(3);
    await rootSuiteStartAll(bus);
    let mid = '2b'.repeat(32),
      row = sampleRow(mid);
    let victim = bus.nodes[0];
    await victim.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 4
      }
    });
    let pending = victim.consensus.pending.get(mid);
    let threeOfFour = new Set(bus.nodes.slice(0, 3).map(nd => nd.pubkey));
    expect(victim.consensus.meetsQuorum(pending, threeOfFour), 'three of the four-member set is a quorum there').to.be.true;
    await rootSuiteDrivePropose(bus, victim, mid, Object.assign({}, row, {
      snapshot_block: 101
    }));
    pending = victim.consensus.pending.get(mid);
    expect(victim.consensus.meetsQuorum(pending, threeOfFour), 'the same three do not carry the seven-member set the row declares').to.be.false;
  });
}
function registerDirect5Part3() {
  it('refuses a row whose declared snapshot cannot be resolved, rather than voting under the old set', async function () {
    let bus = rootSuiteBuildMesh(4);
    bus.nodes.forEach(nd => {
      nd.consensus.engine.resolveCapabilityValidators = async () => [];
    });
    await rootSuiteStartAll(bus);
    let mid = '3c'.repeat(32),
      row = sampleRow(mid);
    let victim = bus.nodes[0];
    await victim.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 4
      }
    });
    let before = victim.consensus.pending.get(mid).signatures.size;
    await rootSuiteDrivePropose(bus, victim, mid, Object.assign({}, row, {
      snapshot_block: 101
    }));
    let pending = victim.consensus.pending.get(mid);
    expect(pending.row.snapshot_block, 'the unresolvable row is not adopted').to.equal(100);
    expect(pending.signatures.size, 'and no signature was added for it').to.equal(before);
    expect(pending.validators.length).to.equal(4);
  });
}
function registerDirect5Part4() {
  it('refuses a row from a leader outside the set its own declared snapshot names', async function () {
    let bus = rootSuiteBuildMesh(4);
    let mid = '4d'.repeat(32),
      row = sampleRow(mid);
    let leaderPk = rootSuiteLeaderPubkey(bus, mid, 0);
    // The declared snapshot drops the proposing leader. Its signature is one an
    // indexer discards, so the round must not count it either.
    bus.nodes.forEach(nd => {
      nd.consensus.engine.resolveCapabilityValidators = async () => bus.nodes.filter(x => x.pubkey !== leaderPk).map(x => ({
        pubkey: x.pubkey,
        source: 'src:' + x.pubkey,
        weight: '1',
        amount: '1'
      }));
    });
    await rootSuiteStartAll(bus);
    let victim = bus.nodes.find(nd => nd.pubkey !== leaderPk);
    await victim.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 4
      }
    });
    let before = victim.consensus.pending.get(mid).signatures.size;
    await rootSuiteDrivePropose(bus, victim, mid, Object.assign({}, row, {
      snapshot_block: 101
    }));
    let pending = victim.consensus.pending.get(mid);
    expect(pending.row.snapshot_block).to.equal(100);
    expect(pending.signatures.size).to.equal(before);
  });

  // FINAL_SYNC took the same shortcut: it measured a straggler-rescue proof against
  // the stuck round's set instead of the one the offered row declares.
}
function registerDirect5() {
  registerDirect5Part1();
  registerDirect5Part2();
  registerDirect5Part3();
  registerDirect5Part4();
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
  registerDirect5();
});
