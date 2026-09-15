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
function registerDirect3Part1() {
  it('followers ADOPT a validated leader canonical whose leader-choice fields differ (regression: per-hub effective_time deadlock)', async function () {
    // Every hub pre-builds its row at discovery with its OWN clock second and
    // chain-tip view. Byte-equality once silently dropped the leader's
    // PROPOSE, deadlocking the round (live finding: 3-hub XCALL relay,
    // 2026-06-11). Each node here proposes a row with a different
    // effective_time; the round must still finalize on the LEADER's
    // canonical with quorum verifying sigs on every node.
    let bus = rootSuiteBuildMesh(4);
    await rootSuiteStartAll(bus);
    let mid = 'a1'.repeat(32);
    let snap = {
      validators: rootSuiteValidatorsOf(bus),
      count: 4
    };
    for (let k = 0; k < bus.nodes.length; k++) {
      let row = Object.assign(sampleRow(mid), {
        effective_time: 1700000000 + k
      });
      await bus.nodes[k].consensus.propose(mid, {
        row,
        snapshot: snap
      });
    }
    await waitUntil(() => bus.nodes.every(nd => nd.finalized.length === 1), {
      label: 'every node to finalize on the leader canonical'
    });
    expect(bus.nodes.every(nd => nd.finalized.length === 1), 'every node finalizes').to.be.true;
    // All nodes converged on ONE canonical (the leader's), and every
    // emitted signature verifies against it (no empty-signature rows).
    let leaderPk = rootSuiteLeaderPubkey(bus, mid, 0);
    let leaderIdx = bus.nodes.findIndex(nd => nd.pubkey === leaderPk);
    let leaderCanon = canonicalMatch(Object.assign(sampleRow(mid), {
      effective_time: 1700000000 + leaderIdx
    }));
    for (let nd of bus.nodes) {
      let ev = nd.finalized[0];
      expect(canonicalMatch(ev.row)).to.equal(leaderCanon);
      expect(ev.signatures.length, 'collected sigs on node ' + nd.i).to.be.at.least(3);
      expect(ev.signatures.every(s => ValidatorIdentity.verify(leaderCanon, s.sig, s.pubkey))).to.be.true;
    }
  });
}
function registerDirect3Part2() {
  it('FINAL_SYNC: a straggler that missed a finalized round catches up via state transfer (regression: lost callback)', async function () {
    // Live finding: one hub missed a result round (validation raced the
    // confirmation depth); the others finalized and thereafter ignored the
    // round, so the straggler's mirror NEVER got the row. Its VIEW_CHANGE
    // heartbeat must now elicit a FINAL_SYNC carrying the row + quorum
    // signatures, which it verifies and finalizes from.
    this.timeout(5000);
    let partitioned = true;
    let bus = rootSuiteBuildMesh(4, {
      roundTimeoutMs: 150,
      drop: (self, other) => partitioned && (self.i === 0 || other.i === 0)
    });
    await rootSuiteStartAll(bus);
    let mid = 'c3'.repeat(32),
      row = sampleRow(mid);
    await rootSuiteProposeAll(bus, mid, row);
    await waitUntil(() => [1, 2, 3].every(i => bus.nodes[i].finalized.length === 1), {
      timeoutMs: 4000,
      label: 'the three connected nodes to finalize without the straggler'
    });

    // nodes 1-3 finalized without node 0
    expect([1, 2, 3].every(i => bus.nodes[i].finalized.length === 1)).to.be.true;
    expect(bus.nodes[0].finalized.length).to.equal(0);

    // heal the partition; node 0's view-change timer fires and a finalized
    // peer answers with FINAL_SYNC
    partitioned = false;
    await waitUntil(() => bus.nodes[0].finalized.length === 1, {
      timeoutMs: 4000,
      label: 'the healed straggler to catch up via FINAL_SYNC'
    });
    expect(bus.nodes[0].finalized.length, 'straggler caught up').to.equal(1);
    let ev = bus.nodes[0].finalized[0];
    expect(ev.signatures.length).to.be.at.least(3); // the round's quorum proof
    let canon = canonicalMatch(ev.row);
    expect(ev.signatures.every(s => ValidatorIdentity.verify(canon, s.sig, s.pubkey))).to.be.true;
  });
}
function registerDirect3Part3() {
  it('guard: a FINAL_SYNC without a quorum of verifying signatures is ignored', async function () {
    let bus = rootSuiteBuildMesh(4, {
      drop: () => true
    }); // isolated victim
    await rootSuiteStartAll(bus);
    let mid = 'd4'.repeat(32),
      row = sampleRow(mid);
    let victim = bus.nodes[0];
    await victim.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 4
      }
    });

    // one real signature (below quorum 3) + one garbage signature
    let signer = bus.nodes[1];
    victim.consensus.handleMessage({
      type: 'XDEX_MATCH_FINAL_SYNC',
      sender: signer.pubkey,
      data: {
        matchId: mid,
        row,
        signatures: [{
          pubkey: signer.pubkey,
          sig: signer.identity.sign(canonicalMatch(row))
        }, {
          pubkey: bus.nodes[2].pubkey,
          sig: 'ab'.repeat(64)
        }]
      }
    });
    // FINAL_SYNC is handled synchronously, so the verdict is already in.
    expect(victim.finalized.length).to.equal(0);
    expect(victim.consensus.pending.get(mid).finalized).to.equal(false);
  });
}
function registerDirect3Part4() {
  it('FINAL_SYNC: a straggler finalizes under the PROOF view, not its own rotated view', async function () {
    // The catch-up path verifies the offered proof against the canonical rebuilt at
    // the PROOF's view, so it adopts that view and not only row/canonical/signatures.
    // A pending.view left at whatever the straggler rotated to is what finalize
    // emits and markFinalized caches, so with the EQUIV header active the node
    // publishes a quorum proof under a view none of its signatures cover and re-serves
    // the same wrong view to the NEXT straggler. Every other FINAL_SYNC test runs at
    // view 0, where the two views coincide and nothing can diverge.
    const equivCanonical = (r, view) => canonicalMatch(r) + '|EQ|' + Number(view || 0);
    let bus = rootSuiteBuildMesh(4, {
      drop: () => true,
      canonical: equivCanonical
    }); // isolated victim
    await rootSuiteStartAll(bus);
    let mid = 'd5'.repeat(32),
      row = sampleRow(mid);
    let victim = bus.nodes[0];
    await victim.consensus.propose(mid, {
      row,
      snapshot: {
        validators: rootSuiteValidatorsOf(bus),
        count: 4
      }
    });

    // Drive the isolated straggler ahead of the proof: it view-changed twice while
    // the rest of the federation finalized at view 0.
    victim.consensus.pending.get(mid).view = 2;

    // A real quorum proof (3 of 4) taken at view 0.
    let signers = [bus.nodes[1], bus.nodes[2], bus.nodes[3]];
    let proofCanon = equivCanonical(row, 0);
    // handleMessage fires the FINAL_SYNC branch and forgets it (the handler is
    // async: an offered row can declare a different snapshot, which has to be
    // re-resolved before its proof is measured), so drive the handler directly and
    // let its completion be the verdict.
    await victim.consensus.handleFinalSync({
      type: 'XDEX_MATCH_FINAL_SYNC',
      sender: signers[0].pubkey,
      data: {
        matchId: mid,
        row,
        view: 0,
        signatures: signers.map(nd => ({
          pubkey: nd.pubkey,
          sig: nd.identity.sign(proofCanon)
        }))
      }
    });
    expect(victim.finalized.length, 'the straggler caught up').to.equal(1);
    let ev = victim.finalized[0];
    expect(ev.view, 'finalized under the proof view, not the local rotated view').to.equal(0);
    expect(ev.signatures.length).to.be.at.least(3);
    expect(ev.signatures.every(s => ValidatorIdentity.verify(equivCanonical(ev.row, ev.view), s.sig, s.pubkey)), 'every published signature verifies under the view it was published at').to.be.true;
    expect(victim.consensus.finalizedRows.get(mid).view, 'the cached state-transfer payload re-serves the proof view to the next straggler').to.equal(0);
  });
}
function registerDirect3() {
  registerDirect3Part1();
  registerDirect3Part2();
  registerDirect3Part3();
  registerDirect3Part4();
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
  registerDirect3();
});
