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
function registerFeature12quorumLockingPart1() {
  it('locks quorum into the pending object on the leader (PROPOSE) path', async function () {
    rootSuiteEngine.setValidatorSet(VALIDATORS_4); // N=4 → quorum=3
    // seq increments to 1 → leader = VALIDATORS_4[1 % 4]
    rootSuitePm.validatorAddr = VALIDATORS_4[1].addr;
    rootSuiteEngine.requestAttestation('BTC', 1, 'LTC'); // fire-and-forget; resolves on quorum
    await new Promise(r => setImmediate(r)); // let the async block-boundary snapshot/quorum resolve
    let pending = rootSuiteEngine.pendingAttestations.get('BTC:1:LTC');
    expect(pending).to.exist;
    expect(pending.quorum).to.equal(3);
  });
  it('locks quorum into the pending object on the follower (handlePropose) path', async function () {
    rootSuiteEngine.setValidatorSet(VALIDATORS_4); // N=4 → quorum=3
    rootSuitePm.validatorAddr = VALIDATORS_4[0].addr;
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
        btcBlockHeight: 900000
      }
    });
    expect(rootSuiteEngine.pendingAttestations.get(attestationId).quorum).to.equal(3);
  });
}
function registerFeature12quorumLockingPart2() {
  it('commits at the round-start quorum even after validatorSet GROWS mid-round', async function () {
    // Round starts with N=4 (quorum=3). A larger set synced mid-round
    // would yield quorum=5 live - which would wrongly stall this node.
    rootSuiteEngine.setValidatorSet(VALIDATORS_4);
    rootSuitePm.validatorAddr = VALIDATORS_4[0].addr;
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
        btcBlockHeight: 900000
      }
    });
    // After PROPOSE: prepares = {self, sender} = 2; one PREPARE broadcast.
    rootSuitePm.broadcast.resetHistory();

    // Validator set GROWS mid-round - live quorum would now be 5.
    rootSuiteEngine.setValidatorSet(VALIDATORS_7);

    // Third prepare arrives → 3 prepares. Locked quorum=3 → COMMIT must fire.
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
function registerFeature12quorumLockingPart3() {
  it('does NOT commit early if validatorSet SHRINKS mid-round', async function () {
    // Round starts with N=7 (quorum=5). A shrunk set synced mid-round
    // would yield quorum=1 live - which would wrongly commit too early.
    rootSuiteEngine.setValidatorSet(VALIDATORS_7);
    rootSuitePm.validatorAddr = VALIDATORS_7[0].addr;
    let attestationId = 'BTC:1:LTC';
    let digest = rootSuiteEngine._digest(attestationId, 3);
    await rootSuiteEngine._handlePropose({
      sender: VALIDATORS_7[1].addr,
      sig_pubkey: VALIDATORS_7[1].pubkey,
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
    rootSuitePm.broadcast.resetHistory();

    // Validator set SHRINKS mid-round - live quorum would now be 1.
    rootSuiteEngine.setValidatorSet([makeValidator(0)]);

    // Third prepare → 3 prepares. Locked quorum=5 → still NOT met, no COMMIT.
    rootSuiteEngine.handlePrepare({
      sender: VALIDATORS_7[2].addr,
      sig_pubkey: VALIDATORS_7[2].pubkey,
      data: {
        attestationId,
        digest
      }
    });
    let commitBroadcast = rootSuitePm.broadcast.getCalls().some(c => c.args[0] === 'XCHAIN_ATTEST_COMMIT');
    expect(commitBroadcast).to.be.false;
  });
}
function registerFeature12quorumLocking() {
  describe('quorum locking', function () {
    beforeEach(function () {
      wireLiveMirrorSnapshot(rootSuiteEngine, rootSuiteHub);
      rootSuiteHub.getIdentity = sinon.stub().returns({
        getPubkeyHex: () => VALIDATORS_4[0].pubkey
      });
    });
    registerFeature12quorumLockingPart1();
    registerFeature12quorumLockingPart2();
    registerFeature12quorumLockingPart3();
  });
}
function feature13sourceActionVerificationPropose(overrides = {}) {
  let attestationId = overrides.attestationId || 'BTC:1:LTC';
  let confirmations = overrides.confirmations || 3;
  let digest = rootSuiteEngine._digest(attestationId, confirmations);
  return rootSuiteEngine._handlePropose({
    sender: VALIDATORS_4[1].addr,
    sig_pubkey: VALIDATORS_4[1].pubkey,
    data: Object.assign({
      attestationId,
      sourceChain: 'BTC',
      sourceActionIndex: 1,
      destChain: 'LTC',
      confirmations,
      digest,
      btcBlockHeight: 900000
    }, overrides.data)
  });
}
function registerFeature13sourceActionVerificationPart1() {
  it('refuses to PREPARE when no indexer endpoint is configured (fail closed)', async function () {
    await feature13sourceActionVerificationPropose();
    expect(rootSuiteEngine.pendingAttestations.size).to.equal(0);
    expect(rootSuitePm.broadcast.called).to.be.false;
  });
  it('refuses when the discrete fields do not match the attestationId', async function () {
    // Digest matches the id, but the proposer claims a different source
    // action than the one the id (and digest) commit to.
    sinon.stub(rootSuiteEngine, '_indexerCall').resolves({
      exists: true,
      confirmations: 100
    });
    rootSuiteEngine.indexers.BTC.url = 'http://stub:3004/';
    await feature13sourceActionVerificationPropose({
      data: {
        sourceActionIndex: 2
      }
    });
    expect(rootSuiteEngine.pendingAttestations.size).to.equal(0);
  });
  it('refuses when the action does not exist on the source chain', async function () {
    rootSuiteEngine.indexers.BTC.url = 'http://stub:3004/';
    sinon.stub(rootSuiteEngine, '_indexerCall').resolves({
      exists: false,
      confirmations: 0
    });
    await feature13sourceActionVerificationPropose();
    expect(rootSuiteEngine.pendingAttestations.size).to.equal(0);
  });
  it('refuses when the action is below the per-chain confirmation threshold', async function () {
    rootSuiteEngine.indexers.BTC.url = 'http://stub:3004/';
    sinon.stub(rootSuiteEngine, '_indexerCall').resolves({
      exists: true,
      confirmations: 5
    }); // BTC needs 6
    await feature13sourceActionVerificationPropose();
    expect(rootSuiteEngine.pendingAttestations.size).to.equal(0);
  });
  it('refuses when the indexer lookup fails (fail closed, not fail open)', async function () {
    rootSuiteEngine.indexers.BTC.url = 'http://stub:3004/';
    sinon.stub(rootSuiteEngine, '_indexerCall').rejects(new Error('ECONNREFUSED'));
    await feature13sourceActionVerificationPropose();
    expect(rootSuiteEngine.pendingAttestations.size).to.equal(0);
  });
}
function registerFeature13sourceActionVerificationPart2() {
  it('co-signs when the action exists at sufficient depth', async function () {
    rootSuiteEngine.indexers.BTC.url = 'http://stub:3004/';
    let call = sinon.stub(rootSuiteEngine, '_indexerCall').resolves({
      exists: true,
      confirmations: 6
    });
    await feature13sourceActionVerificationPropose();
    expect(rootSuiteEngine.pendingAttestations.has('BTC:1:LTC')).to.be.true;
    expect(call.calledOnceWith('BTC', 'getactionconfirmations', {
      action_index: 1
    })).to.be.true;
    let pending = rootSuiteEngine.pendingAttestations.get('BTC:1:LTC');
    if (pending.timer) clearTimeout(pending.timer);
  });
}
function registerFeature13sourceActionVerification() {
  describe('source-action verification', function () {
    beforeEach(function () {
      rootSuiteEngine.verifySourceAction.restore(); // exercise the real guard
      rootSuiteEngine.setValidatorSet(VALIDATORS_4);
      wireLiveMirrorSnapshot(rootSuiteEngine, rootSuiteHub);
      rootSuitePm.validatorAddr = VALIDATORS_4[0].addr;
      // Vote sets hold signing keys, so this hub's identity has to BE the
      // validator its addr names or its own vote is an unknown key.
      rootSuiteHub.getIdentity = sinon.stub().returns({
        getPubkeyHex: () => VALIDATORS_4[0].pubkey
      });
    });
    registerFeature13sourceActionVerificationPart1();
    registerFeature13sourceActionVerificationPart2();
  });
}
function registerFeature14markFinalizedBoundedFinalizedSetPart1() {
  it('caps the finalized set at finalizedMax, evicting oldest first', function () {
    rootSuiteEngine.finalizedMax = 5;
    for (let i = 0; i < 20; i++) rootSuiteEngine.markFinalized('att:' + i);
    expect(rootSuiteEngine.finalized.size).to.equal(5);
    expect(rootSuiteEngine._finalizedOrder.length).to.equal(5);
    // Oldest evicted, newest 5 (att:15..att:19) retained.
    expect(rootSuiteEngine.finalized.has('att:0')).to.be.false;
    expect(rootSuiteEngine.finalized.has('att:14')).to.be.false;
    expect(rootSuiteEngine.finalized.has('att:15')).to.be.true;
    expect(rootSuiteEngine.finalized.has('att:19')).to.be.true;
  });
  it('is idempotent for a repeated id (no double-count, no double-evict)', function () {
    rootSuiteEngine.finalizedMax = 3;
    rootSuiteEngine.markFinalized('a');
    rootSuiteEngine.markFinalized('a');
    rootSuiteEngine.markFinalized('a');
    expect(rootSuiteEngine.finalized.size).to.equal(1);
    expect(rootSuiteEngine._finalizedOrder).to.deep.equal(['a']);
  });
}
function registerFeature14markFinalizedBoundedFinalizedSet() {
  describe('markFinalized (bounded finalized set)', function () {
    registerFeature14markFinalizedBoundedFinalizedSetPart1();
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
  registerFeature12quorumLocking();
  registerFeature13sourceActionVerification();
  registerFeature14markFinalizedBoundedFinalizedSet();
});
