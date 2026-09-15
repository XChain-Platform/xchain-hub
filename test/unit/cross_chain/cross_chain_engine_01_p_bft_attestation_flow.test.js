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

// #1223: resolveQuorum now fails closed when federated with no deterministic
// capability snapshot (the live-validator-set fallback forked N/quorum across
// hubs). Federated flow tests must therefore wire a snapshot resolver. This one
// mirrors the live set at call time (quorum is still frozen into pending at round
// start, so the "locked quorum survives set changes" invariant is unaffected).
function wireLiveMirrorSnapshot(engine, hub) {
    hub.resolveBtcLatestBlock = async () => 900000;
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
function registerFeature7pBFTAttestationFlowPart1() {
  it('PROPOSE from peer creates pending and broadcasts PREPARE', async function () {
    let attestationId = 'BTC:1:LTC';
    let digest = rootSuiteEngine.digest(attestationId, 3);
    await rootSuiteEngine.handlePropose({
      sender: VALIDATORS_4[1].addr,
      sig_pubkey: VALIDATORS_4[1].pubkey,
      data: {
        attestationId,
        sourceChain: 'BTC',
        sourceActionIndex: 1,
        destChain: 'LTC',
        confirmations: 3,
        digest,
        btcBlockHeight: 900000
      }
    });
    expect(rootSuiteEngine.pendingAttestations.has(attestationId)).to.be.true;
    let pending = rootSuiteEngine.pendingAttestations.get(attestationId);
    expect(pending.prepares.has(VALIDATORS_4[1].pubkey)).to.be.true;
    expect(pending.prepares.has(VALIDATORS_4[0].pubkey)).to.be.true; // self
    // N=4, quorum=3, have 2 prepares → PREPARE broadcast but no COMMIT yet
    expect(rootSuitePm.broadcast.calledOnce).to.be.true;
    expect(rootSuitePm.broadcast.getCall(0).args[0]).to.equal('XCHAIN_ATTEST_PREPARE');
    if (pending.timer) clearTimeout(pending.timer);
  });
  it('PROPOSE with wrong digest is rejected', function () {
    rootSuiteEngine.handlePropose({
      sender: VALIDATORS_4[1].addr,
      sig_pubkey: VALIDATORS_4[1].pubkey,
      data: {
        attestationId: 'BTC:1:LTC',
        digest: 'wrong',
        confirmations: 3
      }
    });
    expect(rootSuiteEngine.pendingAttestations.size).to.equal(0);
  });
}
function registerFeature7pBFTAttestationFlowPart2() {
  it('PREPARE quorum triggers COMMIT', function () {
    let attestationId = 'BTC:1:LTC';
    let digest = rootSuiteEngine.digest(attestationId, 3);

    // N=4, quorum=3. Start with 2 prepares
    rootSuiteEngine.pendingAttestations.set(attestationId, {
      attestationId,
      sourceChain: 'BTC',
      sourceActionIndex: 1,
      destChain: 'LTC',
      confirmations: 3,
      digest,
      prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
      commits: new Set(),
      finalized: false,
      timer: null,
      resolve: null,
      reject: null
    });

    // Third prepare → quorum met
    rootSuiteEngine.handlePrepare({
      sender: VALIDATORS_4[2].addr,
      sig_pubkey: VALIDATORS_4[2].pubkey,
      data: {
        attestationId,
        digest
      }
    });
    expect(rootSuitePm.broadcast.called).to.be.true;
    expect(rootSuitePm.broadcast.getCall(0).args[0]).to.equal('XCHAIN_ATTEST_COMMIT');
  });
}
function registerFeature7pBFTAttestationFlowPart3() {
  it('COMMIT quorum stores attestation and emits event', async function () {
    let attestationId = 'BTC:1:LTC';
    let digest = rootSuiteEngine.digest(attestationId, 3);
    let emitted = null;
    rootSuiteEngine.on('attestation:finalized', a => {
      emitted = a;
    });
    let resolvedValue = null;
    // N=4, quorum=3. Start with 2 commits
    rootSuiteEngine.pendingAttestations.set(attestationId, {
      attestationId,
      sourceChain: 'BTC',
      sourceActionIndex: 1,
      destChain: 'LTC',
      confirmations: 3,
      digest,
      prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr, VALIDATORS_4[2].addr]),
      commits: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
      finalized: false,
      timer: null,
      _commitSent: true,
      resolve: v => {
        resolvedValue = v;
      },
      reject: () => {}
    });

    // Third commit → quorum met
    rootSuiteEngine.handleCommit({
      sender: VALIDATORS_4[2].addr,
      sig_pubkey: VALIDATORS_4[2].pubkey,
      data: {
        attestationId,
        digest
      }
    });
    await waitUntil(() => rootSuiteEngine.finalized.has(attestationId), {
      label: 'the third commit to finalize the attestation'
    });
    expect(rootSuiteHub.db.doQuery.called).to.be.true;
    expect(emitted).to.not.be.null;
    expect(emitted.attestationId).to.equal(attestationId);
    expect(emitted.status).to.equal('attested');
    expect(resolvedValue).to.not.be.null;
    expect(rootSuiteEngine.finalized.has(attestationId)).to.be.true;
  });

  // a transient DB failure once deleted the round outright, and
  // both handleCommit and _checkCommitQuorum return early once the round is
  // gone, so the quorum proof was unrecoverable while peer hubs advanced.
}
function feature7pBFTAttestationFlowNested5QuorateRound(attestationId, digest) {
  return {
    attestationId,
    sourceChain: 'BTC',
    sourceActionIndex: 1,
    destChain: 'LTC',
    confirmations: 3,
    digest,
    prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr, VALIDATORS_4[2].addr]),
    commits: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
    finalized: false,
    timer: null,
    _commitSent: true,
    resolve: null,
    reject: null
  };
}
function registerFeature7pBFTAttestationFlowNested5Part1() {
  it('retries a transient failure and finalizes exactly once', async function () {
    let attestationId = 'BTC:1:LTC';
    let digest = rootSuiteEngine.digest(attestationId, 3);
    let emitted = [];
    rootSuiteEngine.on('attestation:finalized', a => emitted.push(a));
    rootSuiteHub.db.doQuery.onCall(0).rejects(new Error('ER_LOCK_DEADLOCK'));
    rootSuiteHub.db.doQuery.onCall(1).rejects(new Error('ER_LOCK_DEADLOCK'));
    rootSuiteHub.db.doQuery.resolves([]);
    rootSuiteEngine.pendingAttestations.set(attestationId, feature7pBFTAttestationFlowNested5QuorateRound(attestationId, digest));
    rootSuiteEngine.handleCommit({
      sender: VALIDATORS_4[2].addr,
      sig_pubkey: VALIDATORS_4[2].pubkey,
      data: {
        attestationId,
        digest
      }
    });
    await waitUntil(() => emitted.length === 1, {
      label: 'the retried store to finalize the round'
    });
    expect(rootSuiteHub.db.doQuery.callCount).to.equal(3);
    expect(emitted).to.have.lengthOf(1);
    expect(rootSuiteEngine.pendingAttestations.has(attestationId)).to.be.false;
    expect(rootSuiteEngine.finalized.has(attestationId)).to.be.true;
  });
}
function registerFeature7pBFTAttestationFlowNested5Part2() {
  it('retains the round when every attempt fails, and a later COMMIT re-drives it', async function () {
    let attestationId = 'BTC:2:LTC';
    let digest = rootSuiteEngine.digest(attestationId, 3);
    let emitted = [];
    rootSuiteEngine.on('attestation:finalized', a => emitted.push(a));
    rootSuiteHub.db.doQuery.rejects(new Error('ER_CON_COUNT_ERROR'));
    rootSuiteEngine.pendingAttestations.set(attestationId, feature7pBFTAttestationFlowNested5QuorateRound(attestationId, digest));
    rootSuiteEngine.handleCommit({
      sender: VALIDATORS_4[2].addr,
      sig_pubkey: VALIDATORS_4[2].pubkey,
      data: {
        attestationId,
        digest
      }
    });

    // Every attempt fails, so the observable is the retry budget being spent.
    await waitUntil(() => rootSuiteHub.db.doQuery.callCount === rootSuiteEngine.storeRetryAttempts, {
      label: 'the store retries to be exhausted'
    });

    // Round retained (not deleted) with the finalize flag reset, so the
    // collected quorum proof survives the outage.
    expect(rootSuiteHub.db.doQuery.callCount).to.equal(rootSuiteEngine.storeRetryAttempts);
    expect(emitted).to.have.lengthOf(0);
    expect(rootSuiteEngine.pendingAttestations.has(attestationId)).to.be.true;
    expect(rootSuiteEngine.pendingAttestations.get(attestationId).finalized).to.be.false;
    expect(rootSuiteEngine.finalized.has(attestationId)).to.be.false;

    // DB recovers; a retransmitted COMMIT re-enters the quorum check.
    rootSuiteHub.db.doQuery.resetBehavior();
    rootSuiteHub.db.doQuery.resolves([]);
    rootSuiteEngine.handleCommit({
      sender: VALIDATORS_4[3].addr,
      sig_pubkey: VALIDATORS_4[3].pubkey,
      data: {
        attestationId,
        digest
      }
    });
    await waitUntil(() => emitted.length === 1, {
      label: 'the retransmitted COMMIT to finalize the round'
    });
    expect(emitted).to.have.lengthOf(1);
    expect(emitted[0].attestationId).to.equal(attestationId);
    expect(rootSuiteEngine.pendingAttestations.has(attestationId)).to.be.false;
    expect(rootSuiteEngine.finalized.has(attestationId)).to.be.true;
  });
}
function registerFeature7pBFTAttestationFlowNested5() {
  describe('store failure on a quorum-finalized round', function () {
    beforeEach(function () {
      rootSuiteEngine.storeRetryBaseMs = 1;
    });
    registerFeature7pBFTAttestationFlowNested5Part1();
    registerFeature7pBFTAttestationFlowNested5Part2();
  });
}
function registerFeature7pBFTAttestationFlowPart4() {
  it('already-finalized attestation is ignored', function () {
    rootSuiteEngine.finalized.add('BTC:1:LTC');
    rootSuiteEngine.handlePropose({
      sender: VALIDATORS_4[1].addr,
      sig_pubkey: VALIDATORS_4[1].pubkey,
      data: {
        attestationId: 'BTC:1:LTC',
        digest: 'x',
        confirmations: 3
      }
    });
    expect(rootSuiteEngine.pendingAttestations.size).to.equal(0);
  });
}
function registerFeature7pBFTAttestationFlow() {
  describe('PBFT attestation flow', function () {
    beforeEach(function () {
      // Use VALIDATORS_4 (quorum=3) to prevent auto-completion
      rootSuiteEngine.setValidatorSet(VALIDATORS_4);
      wireLiveMirrorSnapshot(rootSuiteEngine, rootSuiteHub);
      rootSuitePm.validatorAddr = VALIDATORS_4[0].addr;
      // Vote sets hold signing keys, so this hub's identity has to BE the
      // validator its addr names or its own vote is an unknown key.
      rootSuiteHub.getIdentity = sinon.stub().returns({
        getPubkeyHex: () => VALIDATORS_4[0].pubkey
      });
    });
    registerFeature7pBFTAttestationFlowPart1();
    registerFeature7pBFTAttestationFlowPart2();
    registerFeature7pBFTAttestationFlowPart3();
    registerFeature7pBFTAttestationFlowNested5();
    registerFeature7pBFTAttestationFlowPart4();
  });
}
function registerFeature8getAttestationsPart1() {
  it('queries with status filter', async function () {
    rootSuiteHub.db.doQuery.resolves([]);
    await rootSuiteEngine.getAttestations('attested', 10);
    let args = rootSuiteHub.db.doQuery.getCall(0).args;
    expect(args[0]).to.include("status = ?");
    expect(args[1]).to.include('attested');
  });
  it('queries without status filter', async function () {
    await rootSuiteEngine.getAttestations(null, 25);
    let args = rootSuiteHub.db.doQuery.getCall(0).args;
    expect(args[0]).to.not.include("status = ?");
  });
}
function registerFeature8getAttestations() {
  describe('getAttestations()', function () {
    registerFeature8getAttestationsPart1();
  });
}
function registerFeature9getAttestationPart1() {
  it('returns first matching row', async function () {
    rootSuiteHub.db.doQuery.resolves([{
      id: 1
    }]);
    let result = await rootSuiteEngine.getAttestation('BTC', 42);
    expect(result).to.deep.equal({
      id: 1
    });
  });
  it('returns null when not found', async function () {
    rootSuiteHub.db.doQuery.resolves([]);
    let result = await rootSuiteEngine.getAttestation('BTC', 999);
    expect(result).to.be.null;
  });
}
function registerFeature9getAttestation() {
  describe('getAttestation()', function () {
    registerFeature9getAttestationPart1();
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
  registerFeature7pBFTAttestationFlow();
  registerFeature8getAttestations();
  registerFeature9getAttestation();
});
