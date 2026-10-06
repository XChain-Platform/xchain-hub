'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Stress-sweep #7 LOCALLY-SKIPPED DIVERGENCE: a hub whose gossip lagged below
// minSubmissions at the block boundary stores the round as 'skipped'. That skip
// must NOT land in `finalized` (which would make handlePropose drop the
// federation's legitimate PROPOSE and handlePrepare/handleCommit refuse to
// buffer, permanently pinning a NULL price_snapshot for a round the rest of the
// federation finalized). It must land in a separate `locallySkipped` set so a
// later PROPOSE still processes and can upgrade the skipped rows to finalized.
const sinon = require('sinon');
const {
  expect
} = require('chai');
const OracleConsensus = require('../../../../../src/oracle/consensus');
const {
  createMockHub
} = require('../../../../helpers/mockHub');
const {
  pubkeyForTestSender,
  VALIDATORS_3,
  buildSubmissions
} = require('../../../../helpers/fixtures');
const { getLogger } = require('../../../../../src/observability');
const { bftQuorumOrSingle } = require('../../../../../src/lib/bft_quorum.js');
let oracleConsensusLocallySkippedRoundsStayRepSuite1Hub, oracleConsensusLocallySkippedRoundsStayRepSuite1Oc, oracleConsensusLocallySkippedRoundsStayRepSuite1OracleRound;
const oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND = 7;
function registerOracleConsensusLocallySkippedRoundsStayRepSuite1Part1() {
  beforeEach(function () {
    oracleConsensusLocallySkippedRoundsStayRepSuite1Hub = createMockHub();
    oracleConsensusLocallySkippedRoundsStayRepSuite1OracleRound = {
      getSubmissions: sinon.stub().returns(new Map())
    };
    oracleConsensusLocallySkippedRoundsStayRepSuite1Oc = new OracleConsensus(oracleConsensusLocallySkippedRoundsStayRepSuite1Hub, oracleConsensusLocallySkippedRoundsStayRepSuite1OracleRound);
  });
  afterEach(function () {
    sinon.restore();
  });
  it('records a local-shortfall skip in locallySkipped, NOT finalized', async function () {
    // No submissions -> finalizeRound stores a skipped round.
    await oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.finalizeRound(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND, 100, 1700000000);
    expect(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.locallySkipped.has(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND)).to.be.true;
    expect(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.finalized.has(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND)).to.be.false;
  });
  it('does NOT drop a later PROPOSE for a round it locally skipped', async function () {
    await oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.finalizeRound(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND, 100, 1700000000);
    expect(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.locallySkipped.has(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND)).to.be.true;

    // handlePropose returns at the `finalized.has(round)` guard (before it ever
    // calls isKnownSender). Spying on isKnownSender therefore proves whether the
    // PROPOSE was dropped by that guard or allowed to proceed. Return false so the
    // handler still exits promptly (right after the membership gate) without
    // needing a full snapshot/leader setup.
    let known = sinon.stub(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc, 'isKnownSender').returns(false);
    let prices = [{
      coinPair: 'BTC/USD',
      price: '100000'
    }];
    await oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.handlePropose({
      sender: 'ws://validator-2:10001',
      sig_pubkey: pubkeyForTestSender('ws://validator-2:10001'),
      data: {
        round: oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND,
        prices,
        digest: oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.digest(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND, prices),
        btcBlockHeight: 100
      }
    });

    // Reached the membership gate => the finalized guard did NOT drop the PROPOSE.
    expect(known.called).to.be.true;
  });
}
function registerOracleConsensusLocallySkippedRoundsStayRepSuite1Part2() {
  it('a genuinely finalized round IS still dropped at the finalized guard (contrast)', async function () {
    oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.markFinalized(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND);
    let known = sinon.stub(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc, 'isKnownSender').returns(false);
    let prices = [{
      coinPair: 'BTC/USD',
      price: '100000'
    }];
    await oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.handlePropose({
      sender: 'ws://validator-2:10001',
      sig_pubkey: pubkeyForTestSender('ws://validator-2:10001'),
      data: {
        round: oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND,
        prices,
        digest: oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.digest(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND, prices),
        btcBlockHeight: 100
      }
    });

    // Dropped at the finalized guard, before the membership gate.
    expect(known.called).to.be.false;
  });
  it('finalizing a locally-skipped round moves it out of locallySkipped into finalized', function () {
    oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.markLocallySkipped(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND);
    expect(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.locallySkipped.has(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND)).to.be.true;
    expect(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc._locallySkippedOrder).to.include(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND);
    oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.markFinalized(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND);
    expect(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.locallySkipped.has(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND)).to.be.false;
    expect(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc._locallySkippedOrder).to.not.include(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND);
    expect(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.finalized.has(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND)).to.be.true;
  });
}
function registerOracleConsensusLocallySkippedRoundsStayRepSuite1Part3() {
  it('a locally-skipped round that reaches commit quorum upgrades to finalized', async function () {
    // Local shortfall first.
    await oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.finalizeRound(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND, 100, 1700000000);
    expect(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.locallySkipped.has(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND)).to.be.true;

    // The federation's PROPOSE re-created the round and it reached commit quorum;
    // finalizeCommittedRound persists (ON DUPLICATE KEY UPDATE upgrades the
    // skipped rows) and marks it finalized.
    sinon.stub(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc, 'storeSnapshot').resolves();
    oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.pendingRounds.set(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND, {
      prepares: new Set(['pkA', 'pkB', 'pkC']),
      commits: new Set(['pkA', 'pkB', 'pkC']),
      signatures: new Map([['pkA', 'sigA']]),
      prices: [{
        coinPair: 'BTC/USD',
        price: '100000'
      }],
      btcBlockHeight: 100,
      btcBlockTime: 1700000000,
      finalized: true
    });
    await oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.finalizeCommittedRound(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND);
    expect(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.locallySkipped.has(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND)).to.be.false;
    expect(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.finalized.has(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND)).to.be.true;
  });
  it('markLocallySkipped is a no-op once the round is already finalized', function () {
    oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.markFinalized(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND);
    oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.markLocallySkipped(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND);
    expect(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.locallySkipped.has(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND)).to.be.false;
    expect(oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.finalized.has(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND)).to.be.true;
  });

  // item 4942: OracleRound's consecutiveSkippedRounds gauge subscribes to this
  // event, so it must fire exactly once per round that becomes a durable
  // non-finalized record - the same round set hydrateFreshnessCounters counts
  // back from price_snapshots after a restart.
  it('emits round:skipped exactly once per round, and never for a finalized one', function () {
    let seen = [];
    oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.on('round:skipped', e => seen.push(e && e.round));
    oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.markLocallySkipped(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND);
    oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.markLocallySkipped(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND);
    expect(seen).to.deep.equal([oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND]);
    oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.markFinalized(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND + 1);
    oracleConsensusLocallySkippedRoundsStayRepSuite1Oc.markLocallySkipped(oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND + 1);
    expect(seen).to.deep.equal([oracleConsensusLocallySkippedRoundsStayRepSuite1ROUND]);
  });
}
describe('OracleConsensus: locally-skipped rounds stay reprocessable (#7)', function () {
  registerOracleConsensusLocallySkippedRoundsStayRepSuite1Part1.call(this);
  registerOracleConsensusLocallySkippedRoundsStayRepSuite1Part2.call(this);
  registerOracleConsensusLocallySkippedRoundsStayRepSuite1Part3.call(this);
});

// A skip that lost the whole round must warn like a partial shortfall does: the
// stored skip's own summary line is info, and log alerting keys on level.
let warnHub, warnOc, warnRound;
const BTC_USD = [{ coinPair: 'BTC/USD', price: '100000' }];

// The warn lines one round produced; the info summary never lands here.
function spyRoundWarns() {
  const spy = sinon.spy(getLogger(), 'warn');
  return round => spy.getCalls().map(c => String(c.args[0])).filter(m => m.includes('Round ' + round + ' '));
}
function snapshotOf(capability, blockIndex) {
  const vals = Array.isArray(warnOc.validatorSet) ? warnOc.validatorSet : [];
  return { capability, blockIndex: Number(blockIndex), count: vals.length,
    validators: vals.map(v => ({ pubkey: v.pubkey, amount: '50000' })) };
}
function registerTotalLossWarnHarness() {
  beforeEach(function () {
    warnHub = createMockHub();
    warnRound = { getSubmissions: sinon.stub().returns(new Map()) };
    warnOc = new OracleConsensus(warnHub, warnRound);
    warnHub.capabilitySnapshot = {
      getSnapshot: async (c, b) => snapshotOf(c, b),
      getWeightSnapshot: async (c, b) => snapshotOf(c, b),
      getQuorum: s => bftQuorumOrSingle(s && Array.isArray(s.validators) ? s.validators.length : 0, 0)
    };
    warnOc.minSubmissions = 1;
  });
  afterEach(function () {
    sinon.restore();
  });
}
function registerTotalLossWarnSubmissionTests() {
  it('warns when a round has no submissions at all', async function () {
    const warns = spyRoundWarns();
    await warnOc.finalizeRound(5);
    expect(warns(5)).to.have.length(1);
    expect(warns(5)[0]).to.include('no submissions');
  });
  it('warns when no submission comes from a snapshot member', async function () {
    const warns = spyRoundWarns();
    warnOc.setValidatorSet(VALIDATORS_3);
    warnRound.getSubmissions.returns(buildSubmissions([{ sender: 'ws://outsider:1', prices: BTC_USD }]));
    await warnOc.finalizeRound(6, 900000, 1700000000);
    expect(warns(6)).to.have.length(1);
    expect(warns(6)[0]).to.include('snapshot members');
  });
  it('still warns exactly once on a partial shortfall', async function () {
    const warns = spyRoundWarns();
    warnOc.minSubmissions = 3;
    warnRound.getSubmissions.returns(buildSubmissions([{ sender: 'v1', prices: BTC_USD }]));
    await warnOc.finalizeRound(9);
    expect(warns(9)).to.have.length(1);
    expect(warns(9)[0]).to.include('minimum is 3');
  });
}
function registerTotalLossWarnAggregateTests() {
  it('warns when the solo path aggregates no prices', async function () {
    const warns = spyRoundWarns();
    warnOc.setValidatorSet([]);
    warnHub._peerManager.getPeerStatus.returns([]);
    sinon.stub(warnOc, 'aggregateAll').returns([]);
    warnRound.getSubmissions.returns(buildSubmissions([{ sender: warnHub._peerManager.validatorAddr, prices: BTC_USD }]));
    await warnOc.finalizeRound(7, 900000, 1700000000);
    expect(warns(7)).to.have.length(1);
    expect(warns(7)[0]).to.include('aggregation yielded no prices');
  });
  it('warns when the proposer aggregates no prices, keeping the skip reason', async function () {
    const warns = spyRoundWarns();
    sinon.stub(warnOc, 'aggregateAll').returns([]);
    const store = sinon.stub(warnOc, 'storeSkippedRound').resolves();
    const subs = buildSubmissions([{ sender: 'v1', prices: BTC_USD }]);
    await warnOc.proposeRound(8, subs, false, 900000, 1700000000, null, 1, false, null);
    expect(warns(8)).to.have.length(1);
    expect(store.getCall(0).args[3]).to.equal('aggregation yielded no prices');
  });
}
describe('OracleConsensus: a round that lost everything warns like a partial shortfall', function () {
  registerTotalLossWarnHarness();
  registerTotalLossWarnSubmissionTests();
  registerTotalLossWarnAggregateTests();
});
