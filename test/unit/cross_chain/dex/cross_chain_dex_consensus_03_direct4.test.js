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
function registerDirect4Part1() {
  it('guard: COMMIT votes without a verifying signature never count toward quorum', async function () {
    // Counting unverified commits let a node whose canonical diverged
    // "finalize" with zero collected signatures (live finding: hub1 wrote a
    // 0-sig mirror row). Feed a victim commits with garbage sigs; the round
    // must NOT finalize.
    let bus = rootSuiteBuildMesh(4, {
      drop: () => true
    }); // isolate: no real gossip
    await rootSuiteStartAll(bus);
    let mid = 'b2'.repeat(32),
      row = sampleRow(mid);
    let victim = bus.nodes[0];
    await victim.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 4
      }
    });
    for (let nd of bus.nodes) {
      if (nd === victim) continue;
      victim.consensus.handleMessage({
        type: 'XDEX_MATCH_COMMIT',
        sender: nd.pubkey,
        data: {
          matchId: mid,
          view: 0,
          sig_pubkey: nd.pubkey,
          sig: 'de'.repeat(64)
        }
      });
      victim.consensus.handleMessage({
        type: 'XDEX_MATCH_COMMIT',
        sender: nd.pubkey,
        data: {
          matchId: mid,
          view: 0,
          sig_pubkey: nd.pubkey,
          sig: null
        }
      });
    }
    // COMMIT is handled synchronously, so every fed vote is already tallied (or not).
    expect(victim.finalized.length).to.equal(0);
    expect(victim.consensus.pending.get(mid).commits.size).to.equal(0);
  });
}
function registerDirect4Part2() {
  it('guard: a replayed PREPARE (valid canonical sig, no commit_sig) never counts as a COMMIT vote', async function () {
    // A-F6: PREPARE and COMMIT signatures were interchangeable (a COMMIT
    // re-sends the prepare sig verbatim), so one Byzantine member could
    // replay everyone's PREPAREs as COMMITs and finalize a round no honest
    // peer had committed. The phase-bound commit_sig closes that: genuine
    // canonical sigs without it collect as artifact signatures but must not
    // tally as commit votes.
    let bus = rootSuiteBuildMesh(4, {
      drop: () => true
    }); // isolate: no real gossip
    await rootSuiteStartAll(bus);
    let mid = 'c3'.repeat(32),
      row = sampleRow(mid);
    let victim = bus.nodes[0];
    await victim.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 4
      }
    });
    let canon = canonicalMatch(row);
    for (let nd of bus.nodes) {
      if (nd === victim) continue;
      let prepareSig = nd.identity.sign(canon); // exactly what a PREPARE carries
      victim.consensus.handleMessage({
        type: 'XDEX_MATCH_COMMIT',
        sender: nd.pubkey,
        data: {
          matchId: mid,
          view: 0,
          sig_pubkey: nd.pubkey,
          sig: prepareSig
        }
      });
      // A commit_sig phase-tagged for a DIFFERENT engine (the XCALL relay
      // twin) must not verify against this engine's COMMIT payload either.
      victim.consensus.handleMessage({
        type: 'XDEX_MATCH_COMMIT',
        sender: nd.pubkey,
        data: {
          matchId: mid,
          view: 0,
          sig_pubkey: nd.pubkey,
          sig: prepareSig,
          commit_sig: nd.identity.sign('XCALL_RELAY_COMMIT|PHASEV1|' + canon)
        }
      });
    }
    // COMMIT is handled synchronously, so every replayed PREPARE is already judged.
    expect(victim.finalized.length).to.equal(0);
    let p = victim.consensus.pending.get(mid);
    expect(p.commits.size).to.equal(0); // no replayed vote tallied
    expect(p.signatures.size).to.be.at.least(3); // artifact sigs still collected
  });
}
function registerDirect4Part3() {
  it('phase-bound COMMIT votes with a verifying commit_sig finalize the round', async function () {
    let bus = rootSuiteBuildMesh(4, {
      drop: () => true
    }); // isolate: no real gossip
    await rootSuiteStartAll(bus);
    let mid = 'c4'.repeat(32),
      row = sampleRow(mid);
    let victim = bus.nodes[0];
    await victim.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 4
      }
    });
    let canon = canonicalMatch(row);
    for (let nd of bus.nodes) {
      if (nd === victim) continue;
      victim.consensus.handleMessage({
        type: 'XDEX_MATCH_COMMIT',
        sender: nd.pubkey,
        data: {
          matchId: mid,
          view: 0,
          sig_pubkey: nd.pubkey,
          sig: nd.identity.sign(canon),
          commit_sig: nd.identity.sign('XDEX_MATCH_COMMIT|PHASEV1|' + canon)
        }
      });
    }
    await waitUntil(() => victim.finalized.length === 1, {
      label: 'the phase-bound commit quorum to finalize the round'
    });
    expect(victim.finalized.length).to.equal(1);
    expect(victim.finalized[0].signatures.length).to.be.at.least(3);
  });
}
function registerDirect4Part4() {
  it('guard: NEW_VIEW from a non-leader, and view-rewind, are ignored', async function () {
    let bus = rootSuiteBuildMesh(4);
    await rootSuiteStartAll(bus);
    let mid = 'ab'.repeat(32),
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
    let startView = p.view;

    // NEW_VIEW for the next view from a node that is NOT its designated leader → ignored.
    let nextView = startView + 1;
    let nonLeader = bus.nodes.find(nd => nd.pubkey !== rootSuiteLeaderPubkey(bus, mid, nextView));
    victim.consensus.handleMessage({
      type: 'XDEX_MATCH_NEW_VIEW',
      sender: nonLeader.pubkey,
      data: {
        matchId: mid,
        view: nextView,
        sig_pubkey: nonLeader.pubkey,
        sig: nonLeader.identity.sign('XDEXNV|' + mid + '|' + nextView)
      }
    });
    expect(victim.consensus.pending.get(mid).view).to.equal(startView);

    // A NEW_VIEW that would rewind the view (even from the right leader) is ignored.
    victim.consensus.pending.get(mid).view = 3;
    let ldPk = rootSuiteLeaderPubkey(bus, mid, 2);
    let ldNode = bus.nodes.find(nd => nd.pubkey === ldPk);
    victim.consensus.handleMessage({
      type: 'XDEX_MATCH_NEW_VIEW',
      sender: ldPk,
      data: {
        matchId: mid,
        view: 2,
        sig_pubkey: ldPk,
        sig: ldNode.identity.sign('XDEXNV|' + mid + '|2')
      }
    });
    expect(victim.consensus.pending.get(mid).view).to.equal(3);
  });
}
function registerDirect4() {
  registerDirect4Part1();
  registerDirect4Part2();
  registerDirect4Part3();
  registerDirect4Part4();
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
  registerDirect4();
});
