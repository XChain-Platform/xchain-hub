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
function registerFeature1getChainPairSetPart1() {
  it('returns chain-pair-specific validators when available', function () {
    let pairValidators = [makeValidator(1), makeValidator(2)];
    rootSuiteEngine.chainPairValidators = new Map([['BTC-LTC', pairValidators]]);
    rootSuiteEngine.setValidatorSet(VALIDATORS_7);
    let set = rootSuiteEngine.getChainPairSet('BTC', 'LTC');
    expect(set).to.equal(pairValidators);
  });
  it('checks reverse key ordering', function () {
    let pairValidators = [makeValidator(1)];
    rootSuiteEngine.chainPairValidators = new Map([['LTC-BTC', pairValidators]]);
    let set = rootSuiteEngine.getChainPairSet('BTC', 'LTC');
    expect(set).to.equal(pairValidators);
  });
  it('falls back to full validator set when no chain-pair set', function () {
    rootSuiteEngine.setValidatorSet(VALIDATORS_3);
    rootSuiteEngine.chainPairValidators = new Map();
    let set = rootSuiteEngine.getChainPairSet('BTC', 'DOGE');
    expect(set).to.equal(VALIDATORS_3);
  });
  it('falls back when chain-pair set is empty', function () {
    rootSuiteEngine.chainPairValidators = new Map([['BTC-DOGE', []]]);
    rootSuiteEngine.setValidatorSet(VALIDATORS_3);
    let set = rootSuiteEngine.getChainPairSet('BTC', 'DOGE');
    expect(set).to.equal(VALIDATORS_3);
  });
}
function registerFeature1getChainPairSet() {
  describe('getChainPairSet()', function () {
    registerFeature1getChainPairSetPart1();
  });
}
function registerFeature2getQuorumPart1() {
  it('uses chain-pair validator count for per-pair quorum', function () {
    rootSuiteEngine.chainPairValidators = new Map([['BTC-LTC', [makeValidator(1), makeValidator(2), makeValidator(3)]]]);
    rootSuiteEngine.setValidatorSet(VALIDATORS_7);
    // Per-pair: N=3 → 2f+1=1, floored at majority ceil((3+1)/2)=2
    expect(rootSuiteEngine.getQuorum('BTC', 'LTC')).to.equal(2);
  });
  it('falls back to full set quorum without chain params', function () {
    rootSuiteEngine.setValidatorSet(VALIDATORS_4);
    // N=4 → quorum=3
    expect(rootSuiteEngine.getQuorum()).to.equal(3);
  });
  it('single validator → quorum 0', function () {
    rootSuiteEngine.setValidatorSet([makeValidator(1)]);
    expect(rootSuiteEngine.getQuorum()).to.equal(0);
  });
}
function registerFeature2getQuorum() {
  describe('getQuorum()', function () {
    registerFeature2getQuorumPart1();
  });
}
function registerFeature3resolveQuorumFailClosed1223Part1() {
  it('throws when federated but no deterministic snapshot resolves (indexer down)', async function () {
    // Federated set (live quorum > 0), no capabilitySnapshot -> must NOT fall
    // back to the local validator set (would fork N/quorum against healthy peers).
    rootSuiteEngine.setValidatorSet(VALIDATORS_4);
    rootSuiteHub.capabilitySnapshot = null;
    let threw = false;
    try {
      await rootSuiteEngine.resolveQuorum('BTC', 'LTC', 100);
    } catch (e) {
      threw = true;
      expect(e.message).to.match(/deterministic cross_chain snapshot while federated/);
    }
    expect(threw).to.equal(true);
  });
  it('single-node hub (live quorum 0) keeps the live fallback, no throw', async function () {
    rootSuiteEngine.setValidatorSet([makeValidator(1)]); // N=1 -> getQuorum()===0
    rootSuiteHub.capabilitySnapshot = null;
    let q = await rootSuiteEngine.resolveQuorum('BTC', 'LTC', 100);
    expect(q).to.equal(0);
  });
  it('returns the snapshot quorum when a deterministic snapshot resolves', async function () {
    rootSuiteEngine.setValidatorSet(VALIDATORS_4);
    rootSuiteHub.capabilitySnapshot = {
      getSnapshot: async () => ({
        validators: [makeValidator(1), makeValidator(2), makeValidator(3)]
      }),
      getQuorum: () => 2
    };
    let q = await rootSuiteEngine.resolveQuorum('BTC', 'LTC', 100);
    expect(q).to.equal(2);
  });
  it('treats block height 0 as a real height (not absent) and resolves a snapshot', async function () {
    rootSuiteEngine.setValidatorSet(VALIDATORS_4);
    let seenBlock = 'unset';
    rootSuiteHub.capabilitySnapshot = {
      getSnapshot: async (cap, block) => {
        seenBlock = block;
        return {
          validators: [makeValidator(1)]
        };
      },
      getQuorum: () => 2
    };
    let q = await rootSuiteEngine.resolveQuorum('BTC', 'LTC', 0);
    expect(seenBlock).to.equal(0);
    expect(q).to.equal(2);
  });
}
function registerFeature3resolveQuorumFailClosed1223() {
  describe('resolveQuorum() fail-closed (#1223)', function () {
    registerFeature3resolveQuorumFailClosed1223Part1();
  });
}
function registerFeature4getLeaderPart1() {
  it('rotates through validators by seq % N', function () {
    rootSuiteEngine.setValidatorSet(VALIDATORS_3);
    expect(rootSuiteEngine._getLeader(0, null, null)).to.equal(VALIDATORS_3[0]);
    expect(rootSuiteEngine._getLeader(1, null, null)).to.equal(VALIDATORS_3[1]);
    expect(rootSuiteEngine._getLeader(3, null, null)).to.equal(VALIDATORS_3[0]);
  });
  it('uses chain-pair set for leader selection', function () {
    let pairSet = [makeValidator(5), makeValidator(6)];
    rootSuiteEngine.chainPairValidators = new Map([['BTC-LTC', pairSet]]);
    rootSuiteEngine.setValidatorSet(VALIDATORS_7);
    expect(rootSuiteEngine._getLeader(0, 'BTC', 'LTC')).to.equal(pairSet[0]);
    expect(rootSuiteEngine._getLeader(1, 'BTC', 'LTC')).to.equal(pairSet[1]);
  });
  it('returns null for empty set', function () {
    rootSuiteEngine.setValidatorSet([]);
    expect(rootSuiteEngine._getLeader(0, null, null)).to.be.null;
  });
}
function registerFeature4getLeader() {
  describe('_getLeader()', function () {
    registerFeature4getLeaderPart1();
  });
}
function registerFeature5digestPart1() {
  it('returns 64-char hex hash', function () {
    let d = rootSuiteEngine._digest('BTC:1:LTC', 3);
    expect(d).to.match(/^[0-9a-f]{64}$/);
  });
  it('is deterministic', function () {
    expect(rootSuiteEngine._digest('X', 3)).to.equal(rootSuiteEngine._digest('X', 3));
  });
  it('different inputs produce different digests', function () {
    expect(rootSuiteEngine._digest('X', 3)).to.not.equal(rootSuiteEngine._digest('Y', 3));
  });
}
function registerFeature5digest() {
  describe('_digest()', function () {
    registerFeature5digestPart1();
  });
}
function registerFeature6requestAttestationPart1() {
  it('single-node stores attestation directly', async function () {
    rootSuiteEngine.setValidatorSet([]);
    rootSuitePm.getPeerStatus.returns([]);
    let result = await rootSuiteEngine.requestAttestation('BTC', 42, 'LTC');
    expect(result.attestationId).to.equal('BTC:42:LTC');
    expect(result.confirmations).to.equal(6); // BTC Tier-B default (2026-06-02)
    expect(result.status).to.equal('attested');
    expect(rootSuiteHub.db.doQuery.called).to.be.true;
  });
  it('single-node emits attestation:finalized so downstream listeners run', async function () {
    // SwapTracker progresses swap_records off this event. Without it a
    // single-operator hub wrote the attested row and left every swap at
    // 'initiated' forever.
    rootSuiteEngine.setValidatorSet([]);
    rootSuitePm.getPeerStatus.returns([]);
    let heard = [];
    rootSuiteEngine.on('attestation:finalized', a => heard.push(a));
    let result = await rootSuiteEngine.requestAttestation('BTC', 42, 'LTC');
    expect(heard).to.have.lengthOf(1);
    expect(heard[0].attestationId).to.equal(result.attestationId);
    expect(heard[0].status).to.equal('attested');
    // ...and the id is recorded as finalized, matching the consensus path.
    expect(rootSuiteEngine.finalized.has('BTC:42:LTC')).to.be.true;
  });
  it('REFUSES to finalize unilaterally over an EMPTY cross_chain snapshot (federation bootstrap guard)', async function () {
    // quorum resolves to 0 from an EMPTY capability snapshot (not a genuine
    // single node): unilaterally minting an unverified 'attested' row here is
    // the same hazard fixed for the DEX. Must throw, not store.
    rootSuiteEngine.setValidatorSet(VALIDATORS_3);
    rootSuiteHub.resolveBtcLatestBlock = async () => 800000;
    rootSuiteHub.capabilitySnapshot = {
      getSnapshot: async () => ({
        validators: [],
        count: 0
      }),
      getQuorum: () => 0
    };
    let threw = false;
    try {
      await rootSuiteEngine.requestAttestation('BTC', 7, 'LTC');
    } catch (e) {
      threw = true;
      expect(e.message).to.match(/EMPTY cross_chain snapshot/);
    }
    expect(threw, 'should refuse over an empty snapshot').to.be.true;
  });
}
function registerFeature6requestAttestationPart2() {
  it('returns stored attestation if already finalized', async function () {
    rootSuiteEngine.finalized.add('BTC:42:LTC');
    rootSuiteHub.db.doQuery.resolves([{
      attestation_id: 'BTC:42:LTC',
      status: 'attested'
    }]);
    let result = await rootSuiteEngine.requestAttestation('BTC', 42, 'LTC');
    expect(result.attestation_id).to.equal('BTC:42:LTC');
  });

  // The id was once built from the RAW argument while the guard
  // parsed it, so every spelling parseInt accepts minted its own id: followers
  // dropped 'BTC:1junk:LTC' on their canonical-id regex (_handlePropose) and the
  // round timed out, and a single-node hub stored one row per spelling.
}
const feature6requestAttestationNested5CANONICAL_ID = /^[A-Z]{2,6}:\d+:[A-Z]{2,6}$/; // the follower's own gate
function registerFeature6requestAttestationNested5Part1() {
  // the follower's own gate

  ['42', 42, '042', ' 42', '42junk', '42.9'].forEach(spelling => {
    it(`spelling ${JSON.stringify(spelling)} yields the canonical BTC:42:LTC`, async function () {
      rootSuiteEngine.setValidatorSet([]);
      rootSuitePm.getPeerStatus.returns([]);
      let result = await rootSuiteEngine.requestAttestation('BTC', spelling, 'LTC');
      expect(result.attestationId).to.equal('BTC:42:LTC');
      expect(result.attestationId).to.match(feature6requestAttestationNested5CANONICAL_ID);
      expect(result.sourceActionIndex).to.equal(42);
    });
  });
  it('two spellings of one index collapse onto a single finalized entry', async function () {
    rootSuiteEngine.setValidatorSet([]);
    rootSuitePm.getPeerStatus.returns([]);
    await rootSuiteEngine.requestAttestation('BTC', '7', 'LTC');
    expect(rootSuiteEngine.finalized.has('BTC:7:LTC')).to.be.true;
    const size = rootSuiteEngine.finalized.size;

    // Previously '07' minted a second, distinct id for the same action.
    rootSuiteHub.db.doQuery.resolves([{
      attestation_id: 'BTC:7:LTC',
      status: 'attested'
    }]);
    let again = await rootSuiteEngine.requestAttestation('BTC', '07', 'LTC');
    expect(again.attestation_id).to.equal('BTC:7:LTC');
    expect(rootSuiteEngine.finalized.size).to.equal(size);
  });
}
function registerFeature6requestAttestationNested5() {
  describe('attestationId canonicalization', function () {
    registerFeature6requestAttestationNested5Part1();
  });
}
function registerFeature6requestAttestationPart3() {
  it('uses correct confirmation counts per chain', async function () {
    rootSuiteEngine.setValidatorSet([]);
    rootSuitePm.getPeerStatus.returns([]);
    let btc = await rootSuiteEngine.requestAttestation('BTC', 1, 'LTC');
    expect(btc.confirmations).to.equal(6);
    let doge = await rootSuiteEngine.requestAttestation('DOGE', 1, 'BTC');
    expect(doge.confirmations).to.equal(60);
  });
  it('throws when not the leader in multi-node mode', async function () {
    rootSuiteEngine.setValidatorSet(VALIDATORS_3);
    wireLiveMirrorSnapshot(rootSuiteEngine, rootSuiteHub);
    rootSuitePm.validatorAddr = 'ws://not-in-set:10001';
    try {
      await rootSuiteEngine.requestAttestation('BTC', 1, 'LTC');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e.message).to.include('Not the leader');
    }
  });
}
function registerFeature6requestAttestation() {
  describe('requestAttestation()', function () {
    registerFeature6requestAttestationPart1();
    registerFeature6requestAttestationPart2();
    registerFeature6requestAttestationNested5();
    registerFeature6requestAttestationPart3();
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
  registerFeature1getChainPairSet();
  registerFeature2getQuorum();
  registerFeature3resolveQuorumFailClosed1223();
  registerFeature4getLeader();
  registerFeature5digest();
  registerFeature6requestAttestation();
});
