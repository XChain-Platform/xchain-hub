'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Below the STAKE_WEIGHTED_QUORUM activation height the fail-closed federation guards
// were conditional on weighted mode, so a NULL price snapshot (indexer down / timeout /
// 401-403 / malformed) fell through to getQuorum(), which reads this hub's own
// validatorSet or open-peer count. The finalization THRESHOLD then depended on local
// reachability: at one height a hub holding a three-member snapshot needs two votes
// while a hub whose fetch failed needs whatever its live set implies. The same null also
// unfiltered the member tally and reverted leader election to live-set rotation. Both
// round paths now refuse instead, matching Consensus.js and CrossChainEngine.
const sinon = require('sinon');
const {
  expect
} = require('chai');
const OracleConsensus = require('../../../../../src/oracle/consensus');
const swq = require('../../../../../src/stake_weighted_quorum.js');
const {
  createMockHub
} = require('../../../../helpers/mockHub');
const {
  VALIDATORS_3,
  buildSubmissions,
  makeCapabilitySnapshotStub
} = require('../../../../helpers/fixtures');
const HEIGHT = 900000;
const PRICES = [{
  coinPair: 'BTC/USD',
  price: '100000'
}];
let oracleConsensusAFederatedRoundNeedsADetermSuite1Hub, oracleConsensusAFederatedRoundNeedsADetermSuite1Pm, oracleConsensusAFederatedRoundNeedsADetermSuite1Oc, oracleConsensusAFederatedRoundNeedsADetermSuite1OracleRound;
function oracleConsensusAFederatedRoundNeedsADetermSuite1NullSnapshotSource() {
  return {
    getSnapshot: sinon.stub().resolves(null),
    getWeightSnapshot: sinon.stub().resolves(null),
    getQuorum: sinon.stub().returns(0)
  };
}

// The leader's own submissions, from snapshot members, priced identically.
function oracleConsensusAFederatedRoundNeedsADetermSuite1MemberSubmissions() {
  return buildSubmissions(VALIDATORS_3.map(v => ({
    sender: v.addr,
    prices: PRICES
  })));
}
function oracleConsensusAFederatedRoundNeedsADetermSuite1ProposeEnvelope(round) {
  let leader = VALIDATORS_3[round % 3];
  return {
    type: 'ORACLE_PROPOSE',
    sender: leader.addr,
    sig_pubkey: leader.pubkey,
    data: {
      round,
      prices: PRICES,
      digest: oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.digest(round, PRICES),
      btcBlockHeight: HEIGHT
    }
  };
}
function registerOracleConsensusAFederatedRoundNeedsADetermSuite1Part1() {
  beforeEach(function () {
    oracleConsensusAFederatedRoundNeedsADetermSuite1Hub = createMockHub();
    oracleConsensusAFederatedRoundNeedsADetermSuite1Hub.resolveBtcLatestBlock = sinon.stub().resolves(HEIGHT);
    oracleConsensusAFederatedRoundNeedsADetermSuite1Pm = oracleConsensusAFederatedRoundNeedsADetermSuite1Hub._peerManager;
    oracleConsensusAFederatedRoundNeedsADetermSuite1Pm.validatorPubkeys = new Set(); // size 0: isKnownSender accepts any sender
    oracleConsensusAFederatedRoundNeedsADetermSuite1OracleRound = {
      getSubmissions: sinon.stub().returns(new Map())
    };
    oracleConsensusAFederatedRoundNeedsADetermSuite1Oc = new OracleConsensus(oracleConsensusAFederatedRoundNeedsADetermSuite1Hub, oracleConsensusAFederatedRoundNeedsADetermSuite1OracleRound);
    oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.minSubmissions = 1;
    // Count mode: this gate is exactly the case the weighted-mode guards never covered.
    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
  });
  afterEach(function () {
    for (let [, pending] of oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.pendingRounds) if (pending.timer) clearTimeout(pending.timer);
    sinon.restore();
  });
}
function registerOracleConsensusAFederatedRoundNeedsADetermSuite1Part2() {
  describe('leader path (finalizeRound)', function () {
    it('SECURITY: skips the round rather than sizing quorum from the live validator set', async function () {
      oracleConsensusAFederatedRoundNeedsADetermSuite1Hub.capabilitySnapshot = oracleConsensusAFederatedRoundNeedsADetermSuite1NullSnapshotSource();
      oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.setValidatorSet(VALIDATORS_3);
      oracleConsensusAFederatedRoundNeedsADetermSuite1Pm.validatorAddr = VALIDATORS_3[0].addr; // leader for round 0
      oracleConsensusAFederatedRoundNeedsADetermSuite1OracleRound.getSubmissions.returns(oracleConsensusAFederatedRoundNeedsADetermSuite1MemberSubmissions());
      let quorumSpy = sinon.spy(oracleConsensusAFederatedRoundNeedsADetermSuite1Oc, 'getQuorum');
      await oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.finalizeRound(0, HEIGHT, 1700000000);
      expect(oracleConsensusAFederatedRoundNeedsADetermSuite1Pm.broadcast.called).to.equal(false);
      expect(oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.pendingRounds.has(0)).to.equal(false);
      // A skipped-round row was written, so the stall is durable rather than silent.
      let insert = oracleConsensusAFederatedRoundNeedsADetermSuite1Hub.db.doQuery.getCalls().find(c => /price_snapshots/.test(String(c.args[0])));
      expect(insert, 'a skipped-round row must be written').to.not.equal(undefined);
      expect(String(insert.args[0])).to.include('skipped');
      // The federation test may consult getQuorum, but nothing downstream may SIZE
      // the round from it: no round was opened at all.
      expect(quorumSpy.called).to.equal(true);
    });

    // Control: the same round with a resolvable snapshot proposes normally, so the
    // refusal above is the snapshot gate and not some other guard in the path.
    it('proposes normally once the snapshot resolves (control)', async function () {
      oracleConsensusAFederatedRoundNeedsADetermSuite1Hub.capabilitySnapshot = makeCapabilitySnapshotStub(VALIDATORS_3);
      oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.setValidatorSet(VALIDATORS_3);
      oracleConsensusAFederatedRoundNeedsADetermSuite1Pm.validatorAddr = VALIDATORS_3[0].addr;
      oracleConsensusAFederatedRoundNeedsADetermSuite1OracleRound.getSubmissions.returns(oracleConsensusAFederatedRoundNeedsADetermSuite1MemberSubmissions());
      await oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.finalizeRound(0, HEIGHT, 1700000000);
      expect(oracleConsensusAFederatedRoundNeedsADetermSuite1Pm.broadcast.called).to.equal(true);
      expect(oracleConsensusAFederatedRoundNeedsADetermSuite1Pm.broadcast.getCall(0).args[0]).to.equal('ORACLE_PROPOSE');
    });

    // A genuine single-node / regtest hub has no peer to diverge from, so it keeps the
    // bootstrap self-finalize path. Same federation test as the empty-snapshot guard.
    it('leaves a single-node hub (getQuorum() === 0) on its bootstrap path', async function () {
      oracleConsensusAFederatedRoundNeedsADetermSuite1Hub.capabilitySnapshot = oracleConsensusAFederatedRoundNeedsADetermSuite1NullSnapshotSource();
      oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.setValidatorSet([]);
      oracleConsensusAFederatedRoundNeedsADetermSuite1Pm.getPeerStatus.returns([]);
      expect(oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.getQuorum()).to.equal(0);
      oracleConsensusAFederatedRoundNeedsADetermSuite1Pm.validatorAddr = 'ws://solo:10001';
      oracleConsensusAFederatedRoundNeedsADetermSuite1OracleRound.getSubmissions.returns(buildSubmissions([{
        sender: 'ws://solo:10001',
        prices: PRICES
      }]));
      let storeSpy = sinon.spy(oracleConsensusAFederatedRoundNeedsADetermSuite1Oc, 'storeSnapshot');
      await oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.finalizeRound(1, HEIGHT, 1700000000);
      expect(storeSpy.callCount).to.equal(1);
    });
  });
}
function registerOracleConsensusAFederatedRoundNeedsADetermSuite1Part3() {
  describe('follower path (handlePropose)', function () {
    it('SECURITY: drops the PROPOSE rather than opening a locally-sized pending round', async function () {
      oracleConsensusAFederatedRoundNeedsADetermSuite1Hub.capabilitySnapshot = oracleConsensusAFederatedRoundNeedsADetermSuite1NullSnapshotSource();
      oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.setValidatorSet(VALIDATORS_3);
      oracleConsensusAFederatedRoundNeedsADetermSuite1Pm.validatorAddr = VALIDATORS_3[1].addr; // a follower for round 0
      oracleConsensusAFederatedRoundNeedsADetermSuite1OracleRound.getSubmissions.returns(oracleConsensusAFederatedRoundNeedsADetermSuite1MemberSubmissions());
      await oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.handlePropose(oracleConsensusAFederatedRoundNeedsADetermSuite1ProposeEnvelope(0));
      expect(oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.pendingRounds.has(0)).to.equal(false);
      expect(oracleConsensusAFederatedRoundNeedsADetermSuite1Pm.broadcast.called).to.equal(false);
    });
    it('opens the pending round once the snapshot resolves (control)', async function () {
      oracleConsensusAFederatedRoundNeedsADetermSuite1Hub.capabilitySnapshot = makeCapabilitySnapshotStub(VALIDATORS_3);
      oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.setValidatorSet(VALIDATORS_3);
      oracleConsensusAFederatedRoundNeedsADetermSuite1Pm.validatorAddr = VALIDATORS_3[1].addr;
      oracleConsensusAFederatedRoundNeedsADetermSuite1OracleRound.getSubmissions.returns(oracleConsensusAFederatedRoundNeedsADetermSuite1MemberSubmissions());
      await oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.handlePropose(oracleConsensusAFederatedRoundNeedsADetermSuite1ProposeEnvelope(0));
      expect(oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.pendingRounds.has(0)).to.equal(true);
    });
    it('leaves a single-node hub (getQuorum() === 0) on its bootstrap path', async function () {
      oracleConsensusAFederatedRoundNeedsADetermSuite1Hub.capabilitySnapshot = oracleConsensusAFederatedRoundNeedsADetermSuite1NullSnapshotSource();
      oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.setValidatorSet(VALIDATORS_3);
      sinon.stub(oracleConsensusAFederatedRoundNeedsADetermSuite1Oc, 'getQuorum').returns(0);
      oracleConsensusAFederatedRoundNeedsADetermSuite1Pm.validatorAddr = VALIDATORS_3[1].addr;
      oracleConsensusAFederatedRoundNeedsADetermSuite1OracleRound.getSubmissions.returns(oracleConsensusAFederatedRoundNeedsADetermSuite1MemberSubmissions());
      await oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.handlePropose(oracleConsensusAFederatedRoundNeedsADetermSuite1ProposeEnvelope(0));
      expect(oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.pendingRounds.has(0)).to.equal(true);
    });
  });
  it('hasDeterministicSnapshot separates a NULL snapshot from a present-but-empty one', function () {
    expect(oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.hasDeterministicSnapshot(null)).to.equal(false);
    expect(oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.hasDeterministicSnapshot({})).to.equal(false);
    expect(oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.hasDeterministicSnapshot({
      validators: []
    })).to.equal(true);
    expect(oracleConsensusAFederatedRoundNeedsADetermSuite1Oc.hasDeterministicSnapshot({
      validators: [{
        pubkey: 'aa'
      }]
    })).to.equal(true);
  });
}
describe('OracleConsensus: a federated round needs a deterministic capability snapshot', function () {
  registerOracleConsensusAFederatedRoundNeedsADetermSuite1Part1.call(this);
  registerOracleConsensusAFederatedRoundNeedsADetermSuite1Part2.call(this);
  registerOracleConsensusAFederatedRoundNeedsADetermSuite1Part3.call(this);
});

// The quorum a federated follower locks is resolved in one step of the PROPOSE handler and
// consumed by a later one. A step that drops or shadows that value either throws (the
// handler rejects) or opens the round sized from the live set, so pin both: the handler
// settles, and the pending round carries the SNAPSHOT's quorum, which the stub makes
// distinct from anything the live set could yield.
describe('OracleConsensus: a federated follower locks the snapshot quorum from PROPOSE', function () {
  afterEach(function () {
    sinon.restore();
  });
  it('carries the snapshot quorum into the pending round', async function () {
    let hub = createMockHub();
    hub.resolveBtcLatestBlock = sinon.stub().resolves(HEIGHT);
    hub._peerManager.validatorPubkeys = new Set();
    let oracleRound = {
      getSubmissions: sinon.stub().returns(buildSubmissions(VALIDATORS_3.map(v => ({
        sender: v.addr,
        prices: PRICES
      }))))
    };
    let oc = new OracleConsensus(hub, oracleRound);
    oc.minSubmissions = 1;
    sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    let snapQuorum = sinon.stub().returns(7);
    hub.capabilitySnapshot = Object.assign(makeCapabilitySnapshotStub(VALIDATORS_3), {
      getQuorum: snapQuorum
    });
    oc.setValidatorSet(VALIDATORS_3);
    expect(oc.getQuorum()).to.be.above(0).and.not.equal(7);
    hub._peerManager.validatorAddr = VALIDATORS_3[1].addr;
    let leader = VALIDATORS_3[0];
    await oc.handlePropose({
      type: 'ORACLE_PROPOSE',
      sender: leader.addr,
      sig_pubkey: leader.pubkey,
      data: {
        round: 0,
        prices: PRICES,
        digest: oc.digest(0, PRICES),
        btcBlockHeight: HEIGHT
      }
    });
    let pending = oc.pendingRounds.get(0);
    if (pending && pending.timer) clearTimeout(pending.timer);
    expect(snapQuorum.called).to.equal(true);
    expect(snapQuorum.firstCall.args[0].validators).to.have.length(3);
    expect(pending, 'the PROPOSE must open a pending round').to.not.equal(undefined);
    expect(pending.quorum).to.equal(7);
  });
});
