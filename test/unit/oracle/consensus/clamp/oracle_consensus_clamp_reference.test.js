'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// CONSENSUS GUARD: the aggregation clamp and the no-local-submission co-sign band
// both measure against the last FINALIZED price. The timed reseed bounds how stale
// that reference gets by each hub's own wall clock, which leaves every hub on its
// own schedule: two hubs can judge one PROPOSE against references from different
// rounds and co-sign differently. The reference must be a function of what
// price_snapshots holds at the round being judged, not of when a process booted.
const sinon = require('sinon');
const {
  expect
} = require('chai');
const OracleConsensus = require('../../../../../src/oracle/consensus');
const bcmath = require('../../../../../src/bcmath');
const {
  ORACLE_MAX_CHANGE_PER_ROUND
} = require('../../../../../src/constants');
const {
  createMockHub
} = require('../../../../helpers/mockHub');
const {
  buildSubmissions,
  VALIDATORS_3,
  makeCapabilitySnapshotStub
} = require('../../../../helpers/fixtures');
const ocrMod = require('../../../../../src/oracle_clamp_reference_activation.js');
const ARMED = ocrMod.ORACLE_CLAMP_REFERENCE_ACTIVATION.testnet;

// Both sides of the divergence the gate switches between, derived from the two
// candidate references rather than hardcoded, so a change to the per-round bound
// moves them together.
function clampedFrom(reference) {
  return bcmath.bcformat(bcmath.bcadd(reference, bcmath.bcmul(reference, String(ORACLE_MAX_CHANGE_PER_ROUND), 8), 8), 8);
}
const ALIGNED = clampedFrom('200.00000000'); // 250.00000000, the round-100 reference
const STALE = clampedFrom('100.00000000'); // 125.00000000, the round-99 reference

let oracleConsensusTheClampReferenceIsAlignedTSuite1Hub, oracleConsensusTheClampReferenceIsAlignedTSuite1Oc, oracleConsensusTheClampReferenceIsAlignedTSuite1OracleRound;

// price_snapshots row shape the seed query returns.
function oracleConsensusTheClampReferenceIsAlignedTSuite1Row(coinPair, price, roundNumber) {
  return {
    coin_pair: coinPair,
    price: price,
    round_number: roundNumber
  };
}
// Round 99 seeded and stored locally, round 100 finalized by the federation
// without this hub storing it (the row is in price_snapshots but never went
// through _storeSnapshot), round 101 a runaway aggregate the clamp must bind.
// Returns the price round 101 stored.
async function oracleConsensusTheClampReferenceIsAlignedTSuite1RunStraddledRound(network, btcBlockHeight) {
  oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.network = network;
  oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.db.doQuery.resolves([oracleConsensusTheClampReferenceIsAlignedTSuite1Row('BTC/USD', '100.00000000', 99)]);
  await oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.seedLastFinalizedPrices();
  expect(oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.getLastFinalizedPrice('BTC/USD')).to.equal('100.00000000');
  expect(oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.lastFinalizedRoundFor('BTC/USD')).to.equal(99);
  oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.db.doQuery.resolves([oracleConsensusTheClampReferenceIsAlignedTSuite1Row('BTC/USD', '200.00000000', 100)]);
  oracleConsensusTheClampReferenceIsAlignedTSuite1OracleRound.getSubmissions.returns(buildSubmissions([{
    sender: 'ws://validator-1:10001',
    prices: [{
      coinPair: 'BTC/USD',
      price: '999999.00000000'
    }]
  }, {
    sender: 'ws://validator-2:10001',
    prices: [{
      coinPair: 'BTC/USD',
      price: '999999.00000000'
    }]
  }]));
  const store = sinon.stub(oracleConsensusTheClampReferenceIsAlignedTSuite1Oc, '_storeSnapshot').resolves();
  await oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.finalizeRound(101, btcBlockHeight, 1700000000);
  expect(store.calledOnce, 'round 101 stored').to.be.true;
  return store.firstCall.args[1].find(p => p.coinPair === 'BTC/USD').price;
}
function registerOracleConsensusTheClampReferenceIsAlignedTSuite1Part1() {
  beforeEach(function () {
    oracleConsensusTheClampReferenceIsAlignedTSuite1Hub = createMockHub();
    oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.network = 'regtest';
    oracleConsensusTheClampReferenceIsAlignedTSuite1OracleRound = {
      getSubmissions: sinon.stub().returns(new Map())
    };
    oracleConsensusTheClampReferenceIsAlignedTSuite1Oc = new OracleConsensus(oracleConsensusTheClampReferenceIsAlignedTSuite1Hub, oracleConsensusTheClampReferenceIsAlignedTSuite1OracleRound);
    sinon.stub(console, 'warn');
    sinon.stub(console, 'log');
  });
  afterEach(function () {
    sinon.restore();
  });
  it('re-reads the reference when the hub sat out the round the federation finalized', async function () {
    const price = await oracleConsensusTheClampReferenceIsAlignedTSuite1RunStraddledRound('testnet', ARMED);
    expect(price, 'clamped against the round-100 price, not the round-99 one').to.equal(ALIGNED);
    expect(oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.lastFinalizedRoundFor('BTC/USD')).to.equal(100);
  });
  it('takes the aligned path on a regtest hub, which is armed at genesis', async function () {
    const price = await oracleConsensusTheClampReferenceIsAlignedTSuite1RunStraddledRound('regtest', 0);
    expect(price).to.equal(ALIGNED);
    expect(oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.lastFinalizedRoundFor('BTC/USD')).to.equal(100);
  });

  // The negative control. This is the pre-alignment behaviour the fleet still runs
  // below the height, and it is the divergence the gate exists to schedule: an
  // identical submission set emits half the price an aligned hub emits.
  it('keeps the stale timer-only reference one block below the height', async function () {
    const price = await oracleConsensusTheClampReferenceIsAlignedTSuite1RunStraddledRound('testnet', ARMED - 1);
    expect(price, 'the round-99 reference still bounds the aggregate').to.equal(STALE);
    expect(price).to.not.equal(ALIGNED);
    expect(oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.lastFinalizedRoundFor('BTC/USD'), 'no round-aligned re-read ran').to.equal(99);
  });
  it('keeps the stale timer-only reference on unratified mainnet at any height', async function () {
    const price = await oracleConsensusTheClampReferenceIsAlignedTSuite1RunStraddledRound('mainnet', 9999999);
    expect(price).to.equal(STALE);
    expect(oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.lastFinalizedRoundFor('BTC/USD')).to.equal(99);
  });
  it('issues no query on the common path where the hub already holds the previous round', async function () {
    oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.db.doQuery.resolves([oracleConsensusTheClampReferenceIsAlignedTSuite1Row('BTC/USD', '100.00000000', 100)]);
    await oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.seedLastFinalizedPrices();
    oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.db.doQuery.resetHistory();
    await oracleConsensusTheClampReferenceIsAlignedTSuite1Oc._refreshLastFinalizedForRound(101);
    expect(oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.db.doQuery.called, 'a current reference must not cost a read').to.be.false;
  });
}
function registerOracleConsensusTheClampReferenceIsAlignedTSuite1Part2() {
  it('re-reads at most once per round when the database itself is behind', async function () {
    oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.db.doQuery.resolves([oracleConsensusTheClampReferenceIsAlignedTSuite1Row('BTC/USD', '100.00000000', 50)]);
    await oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.seedLastFinalizedPrices();
    oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.db.doQuery.resetHistory();
    await oracleConsensusTheClampReferenceIsAlignedTSuite1Oc._refreshLastFinalizedForRound(101);
    await oracleConsensusTheClampReferenceIsAlignedTSuite1Oc._refreshLastFinalizedForRound(101);
    await oracleConsensusTheClampReferenceIsAlignedTSuite1Oc._refreshLastFinalizedForRound(101);
    expect(oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.db.doQuery.callCount, 'one attempt per round, not one per PROPOSE').to.equal(1);
  });
  it('counts a reference that is still behind after the re-read', async function () {
    oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.db.doQuery.resolves([oracleConsensusTheClampReferenceIsAlignedTSuite1Row('BTC/USD', '100.00000000', 50)]);
    await oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.seedLastFinalizedPrices();
    await oracleConsensusTheClampReferenceIsAlignedTSuite1Oc._refreshLastFinalizedForRound(101);
    expect(oracleConsensusTheClampReferenceIsAlignedTSuite1Oc._staleClampReference, 'this hub never received round 100').to.equal(1);
  });
  it('a rejected query keeps the previous reference and never throws into consensus', async function () {
    oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.db.doQuery.resolves([oracleConsensusTheClampReferenceIsAlignedTSuite1Row('BTC/USD', '100.00000000', 99)]);
    await oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.seedLastFinalizedPrices();
    oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.db.doQuery.rejects(new Error('replica mid-restore'));
    await oracleConsensusTheClampReferenceIsAlignedTSuite1Oc._refreshLastFinalizedForRound(101);
    expect(oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.getLastFinalizedPrice('BTC/USD'), 'reference survives a failed read').to.equal('100.00000000');
  });
  it('an empty result set does not clear the reference', async function () {
    // An absent reference means NO clamp at all, so an unbounded aggregate is
    // worse than a stale bound: a truncated read must never drop a pair.
    oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.db.doQuery.resolves([oracleConsensusTheClampReferenceIsAlignedTSuite1Row('BTC/USD', '100.00000000', 99)]);
    await oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.seedLastFinalizedPrices();
    oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.db.doQuery.resolves([]);
    await oracleConsensusTheClampReferenceIsAlignedTSuite1Oc._refreshLastFinalizedForRound(101);
    expect(oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.getLastFinalizedPrice('BTC/USD')).to.equal('100.00000000');
  });
  it('reports the highest cached round, which is what "behind" is measured against', async function () {
    oracleConsensusTheClampReferenceIsAlignedTSuite1Hub.db.doQuery.resolves([oracleConsensusTheClampReferenceIsAlignedTSuite1Row('BTC/USD', '100.00000000', 98), oracleConsensusTheClampReferenceIsAlignedTSuite1Row('LTC/USD', '50.00000000', 101)]);
    await oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.seedLastFinalizedPrices();
    expect(oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.maxCachedFinalizedRound()).to.equal(101);
  });
  it('treats an empty cache as no position rather than round zero', async function () {
    expect(oracleConsensusTheClampReferenceIsAlignedTSuite1Oc.maxCachedFinalizedRound(), 'a cold cache is null, not 0').to.equal(null);
  });
}
describe('OracleConsensus: the clamp reference is aligned to the round being judged', function () {
  registerOracleConsensusTheClampReferenceIsAlignedTSuite1Part1.call(this);
  registerOracleConsensusTheClampReferenceIsAlignedTSuite1Part2.call(this);
});

// The second call site. finalizeRound decides what a leader emits; this one decides
// what a follower will co-sign, so both have to flip on the same height or the two
// halves of one round are judged against different references.

let oracleConsensusTheProposeSideClampReferencSuite2Hub, oracleConsensusTheProposeSideClampReferencSuite2Pm, oracleConsensusTheProposeSideClampReferencSuite2Oc, oracleConsensusTheProposeSideClampReferencSuite2OracleRound, oracleConsensusTheProposeSideClampReferencSuite2Leader, oracleConsensusTheProposeSideClampReferencSuite2Refresh;
const oracleConsensusTheProposeSideClampReferencSuite2ROUND = 1;
// A PROPOSE whose height this hub ACCEPTS, which is what makes an assertion about
// the gate meaningful: the follower freshness bound runs ahead of the gate, so a
// height the bound refuses never reaches it and "no re-read" would hold for the
// wrong reason. The tip defaults to the proposed height (dead centre of the
// tolerance band) unless a case is about the bound itself.
function oracleConsensusTheProposeSideClampReferencSuite2Propose(btcBlockHeight, tip) {
  oracleConsensusTheProposeSideClampReferencSuite2Hub.resolveBtcLatestBlock.resolves(tip === undefined ? btcBlockHeight : tip);
  const prices = [{
    coinPair: 'BTC/USD',
    price: '100000'
  }];
  return {
    sender: oracleConsensusTheProposeSideClampReferencSuite2Leader.addr,
    sig_pubkey: oracleConsensusTheProposeSideClampReferencSuite2Leader.pubkey,
    data: {
      round: oracleConsensusTheProposeSideClampReferencSuite2ROUND,
      prices,
      digest: oracleConsensusTheProposeSideClampReferencSuite2Oc._digest(oracleConsensusTheProposeSideClampReferencSuite2ROUND, prices),
      btcBlockHeight,
      btcBlockTime: 1700000000
    }
  };
}
function registerOracleConsensusTheProposeSideClampReferencSuite2Part1() {
  beforeEach(function () {
    oracleConsensusTheProposeSideClampReferencSuite2Hub = createMockHub();
    oracleConsensusTheProposeSideClampReferencSuite2Pm = oracleConsensusTheProposeSideClampReferencSuite2Hub._peerManager;
    oracleConsensusTheProposeSideClampReferencSuite2Pm.validatorPubkeys = new Set(); // size 0, so _isKnownSender accepts any sender
    oracleConsensusTheProposeSideClampReferencSuite2OracleRound = {
      getSubmissions: sinon.stub().returns(new Map())
    };
    oracleConsensusTheProposeSideClampReferencSuite2Hub.capabilitySnapshot = makeCapabilitySnapshotStub(VALIDATORS_3);
    oracleConsensusTheProposeSideClampReferencSuite2Oc = new OracleConsensus(oracleConsensusTheProposeSideClampReferencSuite2Hub, oracleConsensusTheProposeSideClampReferencSuite2OracleRound);
    oracleConsensusTheProposeSideClampReferencSuite2Oc.setValidatorSet(VALIDATORS_3);
    oracleConsensusTheProposeSideClampReferencSuite2Leader = oracleConsensusTheProposeSideClampReferencSuite2Oc._getLeader(oracleConsensusTheProposeSideClampReferencSuite2ROUND);
    oracleConsensusTheProposeSideClampReferencSuite2Pm.validatorAddr = VALIDATORS_3.find(v => v.addr !== oracleConsensusTheProposeSideClampReferencSuite2Leader.addr).addr;
    oracleConsensusTheProposeSideClampReferencSuite2Refresh = sinon.spy(oracleConsensusTheProposeSideClampReferencSuite2Oc, '_refreshLastFinalizedForRound');
    sinon.stub(console, 'warn');
    sinon.stub(console, 'log');
  });
  afterEach(function () {
    sinon.restore();
  });
  it('aligns the reference for a PROPOSE at the height', async function () {
    oracleConsensusTheProposeSideClampReferencSuite2Hub.network = 'testnet';
    await oracleConsensusTheProposeSideClampReferencSuite2Oc._handlePropose(oracleConsensusTheProposeSideClampReferencSuite2Propose(ARMED));
    expect(oracleConsensusTheProposeSideClampReferencSuite2Refresh.calledOnceWithExactly(oracleConsensusTheProposeSideClampReferencSuite2ROUND)).to.be.true;
  });
  it('aligns it on regtest, which is armed at genesis', async function () {
    oracleConsensusTheProposeSideClampReferencSuite2Hub.network = 'regtest';
    // Any height at or above 0 is armed on regtest; a real BTC height rather than
    // literal block 0, which the snapshot-anchor guard refuses on a federated hub.
    await oracleConsensusTheProposeSideClampReferencSuite2Oc._handlePropose(oracleConsensusTheProposeSideClampReferencSuite2Propose(500));
    expect(oracleConsensusTheProposeSideClampReferencSuite2Refresh.calledOnceWithExactly(oracleConsensusTheProposeSideClampReferencSuite2ROUND)).to.be.true;
  });
  it('does not touch the reference one block below the height', async function () {
    oracleConsensusTheProposeSideClampReferencSuite2Hub.network = 'testnet';
    await oracleConsensusTheProposeSideClampReferencSuite2Oc._handlePropose(oracleConsensusTheProposeSideClampReferencSuite2Propose(ARMED - 1));
    expect(oracleConsensusTheProposeSideClampReferencSuite2Refresh.called, 'the pre-alignment path reads nothing per round').to.be.false;
  });
}
function registerOracleConsensusTheProposeSideClampReferencSuite2Part2() {
  it('does not touch the reference on unratified mainnet', async function () {
    oracleConsensusTheProposeSideClampReferencSuite2Hub.network = 'mainnet';
    await oracleConsensusTheProposeSideClampReferencSuite2Oc._handlePropose(oracleConsensusTheProposeSideClampReferencSuite2Propose(9999999));
    expect(oracleConsensusTheProposeSideClampReferencSuite2Refresh.called).to.be.false;
  });

  // ORDERING (operator ruling 2026-09-11). The gate is keyed on the envelope's own
  // btcBlockHeight, so whichever runs first owns the round: with the activation read
  // ahead of the freshness bound, a registered sender chose which side of the gate
  // this hub took for one round just by claiming a height, and the PROPOSE it rode in
  // on was dropped a few lines later. The bound now runs first, so a height this hub
  // refuses steers nothing.
  it('refuses a height outside the tolerance band without reading the reference', async function () {
    oracleConsensusTheProposeSideClampReferencSuite2Hub.network = 'regtest'; // armed at genesis, so the gate would fire
    const height = 5000;
    const tip = height - oracleConsensusTheProposeSideClampReferencSuite2Oc.snapshotToleranceBlocks - 1;
    await oracleConsensusTheProposeSideClampReferencSuite2Oc._handlePropose(oracleConsensusTheProposeSideClampReferencSuite2Propose(height, tip));
    expect(oracleConsensusTheProposeSideClampReferencSuite2Refresh.called, 'the bound drops the PROPOSE before the gate is read').to.be.false;
    expect(oracleConsensusTheProposeSideClampReferencSuite2Hub.db.doQuery.called, 'and before it can cost this hub a query').to.be.false;
  });
  it('still reads the reference at the far edge of the band, which the refusal is measured against', async function () {
    oracleConsensusTheProposeSideClampReferencSuite2Hub.network = 'regtest';
    const height = 5000;
    await oracleConsensusTheProposeSideClampReferencSuite2Oc._handlePropose(oracleConsensusTheProposeSideClampReferencSuite2Propose(height, height - oracleConsensusTheProposeSideClampReferencSuite2Oc.snapshotToleranceBlocks));
    expect(oracleConsensusTheProposeSideClampReferencSuite2Refresh.calledOnceWithExactly(oracleConsensusTheProposeSideClampReferencSuite2ROUND), 'an accepted height reaches the gate').to.be.true;
  });
  it('reads nothing when this hub cannot resolve a tip of its own', async function () {
    oracleConsensusTheProposeSideClampReferencSuite2Hub.network = 'regtest';
    await oracleConsensusTheProposeSideClampReferencSuite2Oc._handlePropose(oracleConsensusTheProposeSideClampReferencSuite2Propose(5000, null));
    expect(oracleConsensusTheProposeSideClampReferencSuite2Refresh.called, 'no tip means no bound, so nothing downstream may run').to.be.false;
    expect(oracleConsensusTheProposeSideClampReferencSuite2Hub.db.doQuery.called).to.be.false;
  });
}
describe('OracleConsensus: the propose-side clamp reference honours the same height', function () {
  registerOracleConsensusTheProposeSideClampReferencSuite2Part1.call(this);
  registerOracleConsensusTheProposeSideClampReferencSuite2Part2.call(this);
});
