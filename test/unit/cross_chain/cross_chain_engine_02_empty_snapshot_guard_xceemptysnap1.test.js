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

const sinon              = require('sinon');
const { expect }         = require('chai');
const CrossChainEngine   = require('../../../src/cross_chain/engine');
const { createMockHub }  = require('../../helpers/mockHub');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, makeValidator } = require('../../helpers/fixtures');
const { waitUntil }      = require('../../helpers/waitUntil');

// #1223: _resolveQuorum now fails closed when federated with no deterministic
// capability snapshot (the live-validator-set fallback forked N/quorum across
// hubs). Federated flow tests must therefore wire a snapshot resolver. This one
// mirrors the live set at call time (quorum is still frozen into pending at round
// start, so the "locked quorum survives set changes" invariant is unaffected).
function wireLiveMirrorSnapshot(engine, hub) {
    hub._resolveBtcLatestBlock = async () => 900000;
    hub.capabilitySnapshot = {
        getSnapshot: async () => ({ validators: engine.validatorSet.slice() }),
        getQuorum: (snap) => {
            let N = snap.validators.length;
            if (N <= 1) return 0;
            let f = Math.floor((N - 1) / 3);
            return Math.max(2 * f + 1, Math.ceil((N + 1) / 2));
        }
    };
}

let rootSuiteHub, rootSuitePm, rootSuiteEngine;
function registerFeature10emptySnapshotGuardXCEEMPTYSNAP1Part1() {
  it('refuses to PREPARE when the cross_chain snapshot resolves a 0 quorum', async function () {
    rootSuiteEngine.setValidatorSet(VALIDATORS_4);
    rootSuitePm.validatorAddr = VALIDATORS_4[0].addr;
    // A snapshot resolves at the round's block but carries NO qualifying validators,
    // so getQuorum → 0 (bootstrap / misconfigured indexer). The follower must refuse.
    rootSuiteHub.capabilitySnapshot = {
      getSnapshot: sinon.stub().resolves({
        validators: [],
        count: 0
      }),
      getQuorum: sinon.stub().returns(0)
    };
    let attestationId = 'BTC:1:LTC';
    let digest = rootSuiteEngine._digest(attestationId, 3);
    await rootSuiteEngine._handlePropose({
      sender: VALIDATORS_4[1].addr,
      sig_pubkey: VALIDATORS_4[1].pubkey,
      data: {
        attestationId,
        sourceChain: 'BTC',
        sourceActionIndex: 1,
        destChain: 'LTC',
        confirmations: 3,
        digest,
        btcBlockHeight: 500
      }
    });

    // No pending, no PREPARE/COMMIT: the un-quorum'd round is dropped up front.
    expect(rootSuiteEngine.pendingAttestations.has(attestationId)).to.be.false;
    expect(rootSuitePm.broadcast.called).to.be.false;
  });
}
function registerFeature10emptySnapshotGuardXCEEMPTYSNAP1Part2() {
  it('still opens the round when the snapshot resolves a real quorum', async function () {
    rootSuiteEngine.setValidatorSet(VALIDATORS_4);
    rootSuitePm.validatorAddr = VALIDATORS_4[0].addr;
    rootSuiteHub.capabilitySnapshot = {
      getSnapshot: sinon.stub().resolves({
        validators: [{}],
        count: 4
      }),
      getQuorum: sinon.stub().returns(3)
    };
    let attestationId = 'BTC:2:LTC';
    let digest = rootSuiteEngine._digest(attestationId, 3);
    await rootSuiteEngine._handlePropose({
      sender: VALIDATORS_4[1].addr,
      sig_pubkey: VALIDATORS_4[1].pubkey,
      data: {
        attestationId,
        sourceChain: 'BTC',
        sourceActionIndex: 2,
        destChain: 'LTC',
        confirmations: 3,
        digest,
        btcBlockHeight: 500
      }
    });
    expect(rootSuiteEngine.pendingAttestations.has(attestationId)).to.be.true;
    let pending = rootSuiteEngine.pendingAttestations.get(attestationId);
    expect(pending.quorum).to.equal(3);
    if (pending.timer) clearTimeout(pending.timer);
  });
}
function registerFeature10emptySnapshotGuardXCEEMPTYSNAP1() {
  describe('empty-snapshot guard (XCE-EMPTYSNAP-1)', function () {
    registerFeature10emptySnapshotGuardXCEEMPTYSNAP1Part1();
    registerFeature10emptySnapshotGuardXCEEMPTYSNAP1Part2();
  });
}
const feature11snapshotGatedPBFTTallyMEMBERS = VALIDATORS_4; // snapshot population, quorum 3
// snapshot population, quorum 3
const feature11snapshotGatedPBFTTallyOUTSIDER = makeValidator(9); // registered, NOT in the snapshot
// registered, NOT in the snapshot
const feature11snapshotGatedPBFTTallyAttestationId = 'BTC:1:LTC';

// Snapshot = MEMBERS; registry additionally carries the outsider and a SECOND addr
// bound to MEMBERS[1]'s key (the multi-addr shape the registry genuinely allows).
// Snapshot = MEMBERS; registry additionally carries the outsider and a SECOND addr
// bound to MEMBERS[1]'s key (the multi-addr shape the registry genuinely allows).
const feature11snapshotGatedPBFTTallyALT_ADDR = 'ws://validator-2-alt:10001';
function feature11snapshotGatedPBFTTallyWire() {
  rootSuiteEngine.setValidatorSet(feature11snapshotGatedPBFTTallyMEMBERS);
  rootSuitePm.validatorAddr = feature11snapshotGatedPBFTTallyMEMBERS[0].addr;
  rootSuitePm.validatorPubkeys = new Map([...feature11snapshotGatedPBFTTallyMEMBERS.map(v => [v.addr, v.pubkey]), [feature11snapshotGatedPBFTTallyOUTSIDER.addr, feature11snapshotGatedPBFTTallyOUTSIDER.pubkey], [feature11snapshotGatedPBFTTallyALT_ADDR, feature11snapshotGatedPBFTTallyMEMBERS[1].pubkey]]);
  rootSuiteHub._resolveBtcLatestBlock = async () => 900000;
  rootSuiteHub.capabilitySnapshot = {
    getSnapshot: sinon.stub().resolves({
      validators: feature11snapshotGatedPBFTTallyMEMBERS.slice(),
      count: feature11snapshotGatedPBFTTallyMEMBERS.length
    }),
    getQuorum: sinon.stub().returns(3)
  };
  rootSuiteHub.getIdentity = sinon.stub().returns({
    getPubkeyHex: () => feature11snapshotGatedPBFTTallyMEMBERS[0].pubkey
  });
}
async function feature11snapshotGatedPBFTTallyOpenRound() {
  let digest = rootSuiteEngine._digest(feature11snapshotGatedPBFTTallyAttestationId, 3);
  await rootSuiteEngine._handlePropose({
    sender: feature11snapshotGatedPBFTTallyMEMBERS[1].addr,
    sig_pubkey: feature11snapshotGatedPBFTTallyMEMBERS[1].pubkey,
    data: {
      attestationId: feature11snapshotGatedPBFTTallyAttestationId,
      sourceChain: 'BTC',
      sourceActionIndex: 1,
      destChain: 'LTC',
      confirmations: 3,
      digest,
      btcBlockHeight: 900000
    }
  });
  return digest;
}
function registerFeature11snapshotGatedPBFTTallyPart1() {
  it('locks the snapshot member set onto the pending round', async function () {
    await feature11snapshotGatedPBFTTallyOpenRound();
    let pending = rootSuiteEngine.pendingAttestations.get(feature11snapshotGatedPBFTTallyAttestationId);
    expect(pending.memberPubkeys).to.be.instanceOf(Set);
    expect([...pending.memberPubkeys].sort()).to.deep.equal(feature11snapshotGatedPBFTTallyMEMBERS.map(v => v.pubkey).sort());
  });
  it('does not count a registered NON-MEMBER toward the snapshot-sized quorum', async function () {
    let digest = await feature11snapshotGatedPBFTTallyOpenRound(); // prepares = {self, MEMBERS[1]} = 2 members
    rootSuitePm.broadcast.resetHistory();
    rootSuiteEngine.handlePrepare({
      sender: feature11snapshotGatedPBFTTallyOUTSIDER.addr,
      sig_pubkey: feature11snapshotGatedPBFTTallyOUTSIDER.pubkey,
      data: {
        attestationId: feature11snapshotGatedPBFTTallyAttestationId,
        digest
      }
    });

    // The outsider's key is attributed (it is in the registry), so it lands in the
    // vote set, but it is not in the snapshot the quorum of 3 was sized from, so it
    // must not tip the round.
    let pending = rootSuiteEngine.pendingAttestations.get(feature11snapshotGatedPBFTTallyAttestationId);
    expect(pending.prepares.has(feature11snapshotGatedPBFTTallyOUTSIDER.pubkey)).to.be.true;
    expect(rootSuitePm.broadcast.called).to.be.false;
  });
}
function registerFeature11snapshotGatedPBFTTallyPart2() {
  it('counts one signing key exactly once even when it votes under two addrs', async function () {
    let digest = await feature11snapshotGatedPBFTTallyOpenRound();
    rootSuitePm.broadcast.resetHistory();

    // MEMBERS[1] (already counted from the PROPOSE) votes a second time under a
    // second addr bound to the SAME key. Addr-keyed that read as a third vote and
    // would tip the quorum of 3 on its own; keyed on the proven signing key it
    // collapses onto the vote MEMBERS[1] already cast.
    rootSuiteEngine.handlePrepare({
      sender: feature11snapshotGatedPBFTTallyALT_ADDR,
      sig_pubkey: feature11snapshotGatedPBFTTallyMEMBERS[1].pubkey,
      data: {
        attestationId: feature11snapshotGatedPBFTTallyAttestationId,
        digest
      }
    });
    let pending = rootSuiteEngine.pendingAttestations.get(feature11snapshotGatedPBFTTallyAttestationId);
    expect(pending.prepares.size).to.equal(2, 'one key is one vote, whatever addr it names');
    expect(rootSuitePm.broadcast.called).to.be.false;

    // A genuinely distinct third member does tip it.
    rootSuiteEngine.handlePrepare({
      sender: feature11snapshotGatedPBFTTallyMEMBERS[3].addr,
      sig_pubkey: feature11snapshotGatedPBFTTallyMEMBERS[3].pubkey,
      data: {
        attestationId: feature11snapshotGatedPBFTTallyAttestationId,
        digest
      }
    });
    expect(rootSuitePm.broadcast.called).to.be.true;
    expect(rootSuitePm.broadcast.getCall(0).args[0]).to.equal('XCHAIN_ATTEST_COMMIT');
  });
  it('finalizes on three distinct snapshot members', async function () {
    let digest = await feature11snapshotGatedPBFTTallyOpenRound();
    rootSuitePm.broadcast.resetHistory();
    rootSuiteEngine.handlePrepare({
      sender: feature11snapshotGatedPBFTTallyMEMBERS[2].addr,
      sig_pubkey: feature11snapshotGatedPBFTTallyMEMBERS[2].pubkey,
      data: {
        attestationId: feature11snapshotGatedPBFTTallyAttestationId,
        digest
      }
    });
    expect(rootSuitePm.broadcast.called).to.be.true;
    expect(rootSuitePm.broadcast.getCall(0).args[0]).to.equal('XCHAIN_ATTEST_COMMIT');
  });
}
function registerFeature11snapshotGatedPBFTTallyPart3() {
  it('gates the COMMIT tally on membership too, not just PREPARE', async function () {
    let digest = await feature11snapshotGatedPBFTTallyOpenRound();
    let pending = rootSuiteEngine.pendingAttestations.get(feature11snapshotGatedPBFTTallyAttestationId);
    let stored = sinon.stub(rootSuiteEngine, 'storeWithRetry').resolves();

    // Four COMMIT envelopes, but one is the outsider and one is an alt addr of a key
    // that already committed: two distinct MEMBERS, below the quorum of 3.
    pending.commits.add(feature11snapshotGatedPBFTTallyMEMBERS[0].pubkey);
    rootSuiteEngine._handleCommit({
      sender: feature11snapshotGatedPBFTTallyMEMBERS[1].addr,
      sig_pubkey: feature11snapshotGatedPBFTTallyMEMBERS[1].pubkey,
      data: {
        attestationId: feature11snapshotGatedPBFTTallyAttestationId,
        digest
      }
    });
    rootSuiteEngine._handleCommit({
      sender: feature11snapshotGatedPBFTTallyALT_ADDR,
      sig_pubkey: feature11snapshotGatedPBFTTallyMEMBERS[1].pubkey,
      data: {
        attestationId: feature11snapshotGatedPBFTTallyAttestationId,
        digest
      }
    });
    rootSuiteEngine._handleCommit({
      sender: feature11snapshotGatedPBFTTallyOUTSIDER.addr,
      sig_pubkey: feature11snapshotGatedPBFTTallyOUTSIDER.pubkey,
      data: {
        attestationId: feature11snapshotGatedPBFTTallyAttestationId,
        digest
      }
    });
    expect(pending.commits.size).to.equal(3, 'the alt addr collapsed onto its key');
    expect(stored.called).to.be.false;
    rootSuiteEngine._handleCommit({
      sender: feature11snapshotGatedPBFTTallyMEMBERS[2].addr,
      sig_pubkey: feature11snapshotGatedPBFTTallyMEMBERS[2].pubkey,
      data: {
        attestationId: feature11snapshotGatedPBFTTallyAttestationId,
        digest
      }
    });
    expect(stored.called).to.be.true;
  });
  it('degrades to the legacy raw tally when no snapshot population resolved', async function () {
    // Single-node / bootstrap: _resolveQuorum falls back to the live set, so there
    // is no snapshot population to gate against and the filter must stay off.
    rootSuiteHub.capabilitySnapshot = null;
    rootSuiteEngine.setValidatorSet(feature11snapshotGatedPBFTTallyMEMBERS);
    let pending = {
      quorum: 2,
      memberPubkeys: null,
      prepares: new Set(['a', 'b'])
    };
    expect(rootSuiteEngine.countedVotes(pending, pending.prepares)).to.equal(2);
  });
}
function registerFeature11snapshotGatedPBFTTallyPart4() {
  it('an empty registry no longer buys a non-member a vote', async function () {
    // The old raw-tally escape here existed only because senders were resolved
    // to keys THROUGH the registry, so an empty registry made every vote
    // unresolvable and the tally fell back to counting addrs. Votes ARE keys
    // now, so registry state cannot affect membership: a key outside the locked
    // snapshot is not counted whatever the registry looks like.
    rootSuitePm.validatorPubkeys = new Map();
    let pending = {
      quorum: 2,
      memberPubkeys: new Set([feature11snapshotGatedPBFTTallyMEMBERS[0].pubkey]),
      prepares: new Set([feature11snapshotGatedPBFTTallyMEMBERS[0].pubkey, 'ff'.repeat(32)])
    };
    expect(rootSuiteEngine.countedVotes(pending, pending.prepares)).to.equal(1);
  });
}
function registerFeature11snapshotGatedPBFTTally() {
  describe('snapshot-gated PBFT tally', function () {
    beforeEach(function () {
      feature11snapshotGatedPBFTTallyWire();
    });
    registerFeature11snapshotGatedPBFTTallyPart1();
    registerFeature11snapshotGatedPBFTTallyPart2();
    registerFeature11snapshotGatedPBFTTallyPart3();
    registerFeature11snapshotGatedPBFTTallyPart4();
  });
}
describe('CrossChainEngine', function () {
  beforeEach(function () {
    rootSuiteHub = createMockHub();
    rootSuitePm = rootSuiteHub._peerManager;
    rootSuiteEngine = new CrossChainEngine(rootSuiteHub);
    // Followers verify the proposed source action against their own indexer
    // before co-signing (fail-closed). The PBFT-flow tests exercise the
    // consensus machinery, not that guard, so verification passes by
    // default; the dedicated 'source-action verification' suite restores
    // the real method.
    sinon.stub(rootSuiteEngine, 'verifySourceAction').resolves(true);
  });
  afterEach(function () {
    for (let [, pending] of rootSuiteEngine.pendingAttestations) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    sinon.restore();
  });

  // -----------------------------------------------------------------
  // getChainPairSet()
  // -----------------------------------------------------------------
  registerFeature10emptySnapshotGuardXCEEMPTYSNAP1();
  registerFeature11snapshotGatedPBFTTally();
});
