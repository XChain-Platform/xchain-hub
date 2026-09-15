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
function registerDirect6Part1() {
  // FINAL_SYNC took the same shortcut: it measured a straggler-rescue proof against
  // the stuck round's set instead of the one the offered row declares.
  it('FINAL_SYNC measures the offered proof against the snapshot the offered row declares', async function () {
    let bus = rootSuiteReboundMesh(3);
    await rootSuiteStartAll(bus);
    let mid = '5e'.repeat(32),
      row = sampleRow(mid);
    let victim = bus.nodes[0];
    await victim.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 4
      }
    });
    let syncRow = Object.assign({}, row, {
      snapshot_block: 101
    });
    let canon = canonicalMatch(syncRow);
    // Three real signatures: a quorum of the four-member set the round holds, and
    // short of the seven-member set the offered row declares.
    let signatures = bus.nodes.slice(0, 3).map(nd => ({
      pubkey: nd.pubkey,
      sig: nd.identity.sign(canon)
    }));
    await victim.consensus.handleFinalSync({
      type: 'XDEX_MATCH_FINAL_SYNC',
      sender: bus.nodes[1].pubkey,
      data: {
        matchId: mid,
        view: 0,
        row: syncRow,
        signatures
      }
    });
    expect(victim.finalized.length, 'an under-quorum proof must not finalize the round').to.equal(0);
    expect(victim.consensus.pending.get(mid).row.snapshot_block).to.equal(100);
  });
}
function registerDirect6Part2() {
  it('FINAL_SYNC still finalizes on a proof that carries the declared snapshot', async function () {
    let bus = rootSuiteReboundMesh(3);
    await rootSuiteStartAll(bus);
    let mid = '6f'.repeat(32),
      row = sampleRow(mid);
    let victim = bus.nodes[0];
    await victim.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 4
      }
    });
    let syncRow = Object.assign({}, row, {
      snapshot_block: 101
    });
    let canon = canonicalMatch(syncRow);
    // The three extra members of the declared set sign too, so the proof carries
    // five of seven distinct sources and clears the declared bar.
    let extraIds = [];
    for (let i = 0; i < 3; i++) extraIds.push(new ValidatorIdentity(String(50 + i).repeat(32).slice(0, 64)));
    let signatures = bus.nodes.slice(0, 2).map(nd => ({
      pubkey: nd.pubkey,
      sig: nd.identity.sign(canon)
    })).concat(extraIds.map(id => ({
      pubkey: id.getPubkeyHex().toLowerCase(),
      sig: id.sign(canon)
    })));
    await victim.consensus.handleFinalSync({
      type: 'XDEX_MATCH_FINAL_SYNC',
      sender: bus.nodes[1].pubkey,
      data: {
        matchId: mid,
        view: 0,
        row: syncRow,
        signatures
      }
    });
    expect(victim.finalized.length, 'a real quorum of the declared set still rescues the round').to.equal(1);
  });
}
function registerDirect6Part3() {
  it('A-F5: bufferEarlyMessage caps distinct ids (FIFO) and drops oversized envelopes', function () {
    let bus = rootSuiteBuildMesh(1);
    let c = bus.nodes[0].consensus;
    c.earlyMessageMaxDistinctIds = 4;
    for (let i = 0; i < 10; i++) c.bufferEarlyMessage('id' + i, {
      type: 'X',
      data: {
        n: i
      }
    });
    expect(c.earlyMessages.size).to.equal(4);
    expect(c.earlyMessages.has('id0')).to.be.false; // oldest distinct id evicted
    expect(c.earlyMessages.has('id9')).to.be.true; // newest retained

    c.earlyMessageMaxBytes = 50;
    c.bufferEarlyMessage('big', {
      type: 'X',
      data: {
        row: 'x'.repeat(500)
      }
    });
    expect(c.earlyMessages.has('big')).to.be.false; // oversized -> not buffered
  });
}
function registerDirect6() {
  registerDirect6Part1();
  registerDirect6Part2();
  registerDirect6Part3();
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
  registerDirect6();
});
