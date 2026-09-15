'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Stress-sweep 2026-07-08: a follower must withhold its co-sign when the
// leader's PROPOSE omits a pair the follower priced locally (or is empty).
// The per-price deviation loop only bounds pairs the proposer INCLUDES, so
// omission was otherwise unbounded, letting a Byzantine leader freeze a pair.
const sinon = require('sinon');
const {
  expect
} = require('chai');
const OracleConsensus = require('../../src/oracle/consensus');
const {
  createMockHub
} = require('../helpers/mockHub');
const {
  VALIDATORS_3,
  buildSubmissions,
  makeCapabilitySnapshotStub
} = require('../helpers/fixtures');
let oracleConsensusPROPOSEPairCoverageStressSwSuite1Hub, oracleConsensusPROPOSEPairCoverageStressSwSuite1Pm, oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc, oracleConsensusPROPOSEPairCoverageStressSwSuite1OracleRound, oracleConsensusPROPOSEPairCoverageStressSwSuite1Leader;
const oracleConsensusPROPOSEPairCoverageStressSwSuite1ROUND = 1;
function oracleConsensusPROPOSEPairCoverageStressSwSuite1Envelope(prices) {
  return {
    sender: oracleConsensusPROPOSEPairCoverageStressSwSuite1Leader.addr,
    sig_pubkey: oracleConsensusPROPOSEPairCoverageStressSwSuite1Leader.pubkey,
    data: {
      round: oracleConsensusPROPOSEPairCoverageStressSwSuite1ROUND,
      prices,
      digest: oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc._digest(oracleConsensusPROPOSEPairCoverageStressSwSuite1ROUND, prices),
      btcBlockHeight: 100,
      btcBlockTime: 1700000000
    }
  };
}
function registerOracleConsensusPROPOSEPairCoverageStressSwSuite1Part1() {
  beforeEach(function () {
    oracleConsensusPROPOSEPairCoverageStressSwSuite1Hub = createMockHub();
    oracleConsensusPROPOSEPairCoverageStressSwSuite1Pm = oracleConsensusPROPOSEPairCoverageStressSwSuite1Hub._peerManager;
    oracleConsensusPROPOSEPairCoverageStressSwSuite1Pm.validatorPubkeys = new Set();
    oracleConsensusPROPOSEPairCoverageStressSwSuite1OracleRound = {
      getSubmissions: sinon.stub().returns(new Map())
    };
    // A federated hub refuses a round with no deterministic capability snapshot, so the
    // harness models one over the same validators: these cases are about something else,
    // not about the snapshot being unreachable.
    oracleConsensusPROPOSEPairCoverageStressSwSuite1Hub.capabilitySnapshot = makeCapabilitySnapshotStub(VALIDATORS_3);
    oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc = new OracleConsensus(oracleConsensusPROPOSEPairCoverageStressSwSuite1Hub, oracleConsensusPROPOSEPairCoverageStressSwSuite1OracleRound);
    oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc.setValidatorSet(VALIDATORS_3);
    oracleConsensusPROPOSEPairCoverageStressSwSuite1Leader = oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc._getLeader(oracleConsensusPROPOSEPairCoverageStressSwSuite1ROUND);
    oracleConsensusPROPOSEPairCoverageStressSwSuite1Pm.validatorAddr = VALIDATORS_3.find(v => v.addr !== oracleConsensusPROPOSEPairCoverageStressSwSuite1Leader.addr).addr;
    // This follower priced BTC/USD locally this round.
    oracleConsensusPROPOSEPairCoverageStressSwSuite1OracleRound.getSubmissions.returns(buildSubmissions([{
      sender: oracleConsensusPROPOSEPairCoverageStressSwSuite1Pm.validatorAddr,
      prices: [{
        coinPair: 'BTC/USD',
        price: '100000'
      }]
    }]));
  });
  afterEach(function () {
    sinon.restore();
  });
  it('withholds co-sign when the proposal omits a locally-priced pair', async function () {
    // Proposal covers only LTC/USD; this follower priced BTC/USD but it is dropped.
    await oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc._handlePropose(oracleConsensusPROPOSEPairCoverageStressSwSuite1Envelope([{
      coinPair: 'LTC/USD',
      price: '90'
    }]));
    expect(oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc.pendingRounds.has(oracleConsensusPROPOSEPairCoverageStressSwSuite1ROUND)).to.be.false;
    expect(oracleConsensusPROPOSEPairCoverageStressSwSuite1Pm.broadcast.called).to.be.false;
  });
  it('withholds co-sign on an empty proposal', async function () {
    await oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc._handlePropose(oracleConsensusPROPOSEPairCoverageStressSwSuite1Envelope([]));
    expect(oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc.pendingRounds.has(oracleConsensusPROPOSEPairCoverageStressSwSuite1ROUND)).to.be.false;
    expect(oracleConsensusPROPOSEPairCoverageStressSwSuite1Pm.broadcast.called).to.be.false;
  });
}
function registerOracleConsensusPROPOSEPairCoverageStressSwSuite1Part2() {
  it('co-signs when the proposal covers the locally-priced pair', async function () {
    await oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc._handlePropose(oracleConsensusPROPOSEPairCoverageStressSwSuite1Envelope([{
      coinPair: 'BTC/USD',
      price: '100000'
    }]));
    expect(oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc.pendingRounds.has(oracleConsensusPROPOSEPairCoverageStressSwSuite1ROUND)).to.be.true;
  });

  // item 4939: coverage is owed only for pairs the LEADER's own aggregation prices.
  // A pair submitted by the leader plus exactly one other hub, disagreeing past
  // ORACLE_DEVIATION_THRESHOLD, is dropped by the leader's exactly-2-source gate and
  // honestly omitted. The follower's reference excludes the proposer, so that pair
  // looks single-source there, never meets the 2-source gate, and once tripped this
  // check on every honest round the two feeds diverged - costing all 36+ pairs and
  // leaving no price_snapshots row at all.
  it('co-signs when the leader honestly drops a 2-source divergent pair', async function () {
    oracleConsensusPROPOSEPairCoverageStressSwSuite1OracleRound.getSubmissions.returns(buildSubmissions([{
      sender: oracleConsensusPROPOSEPairCoverageStressSwSuite1Leader.addr,
      prices: [{
        coinPair: 'BTC/USD',
        price: '100000'
      }, {
        coinPair: 'LTC/USD',
        price: '100'
      }]
    }, {
      sender: oracleConsensusPROPOSEPairCoverageStressSwSuite1Pm.validatorAddr,
      prices: [{
        coinPair: 'BTC/USD',
        price: '100000'
      }, {
        coinPair: 'LTC/USD',
        price: '200'
      } // (200-100)/300 = 33% > 5% gate
      ]
    }]));
    // The leader aggregates the full set, so LTC/USD drops out of its proposal.
    let leaderPairs = oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc._aggregateAll(oracleConsensusPROPOSEPairCoverageStressSwSuite1OracleRound.getSubmissions(oracleConsensusPROPOSEPairCoverageStressSwSuite1ROUND)).map(a => a.coinPair);
    expect(leaderPairs).to.deep.equal(['BTC/USD']);
    await oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc._handlePropose(oracleConsensusPROPOSEPairCoverageStressSwSuite1Envelope([{
      coinPair: 'BTC/USD',
      price: '100000'
    }]));
    expect(oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc.pendingRounds.has(oracleConsensusPROPOSEPairCoverageStressSwSuite1ROUND), 'honest 2-source drop must not wedge the round').to.be.true;
  });
}
function registerOracleConsensusPROPOSEPairCoverageStressSwSuite1Part3() {
  it('still withholds when the leader suppresses a pair its own aggregate prices', async function () {
    // Same shape, but the two feeds AGREE, so the leader's aggregate keeps
    // LTC/USD: omitting it is suppression and the round is withheld.
    oracleConsensusPROPOSEPairCoverageStressSwSuite1OracleRound.getSubmissions.returns(buildSubmissions([{
      sender: oracleConsensusPROPOSEPairCoverageStressSwSuite1Leader.addr,
      prices: [{
        coinPair: 'BTC/USD',
        price: '100000'
      }, {
        coinPair: 'LTC/USD',
        price: '100'
      }]
    }, {
      sender: oracleConsensusPROPOSEPairCoverageStressSwSuite1Pm.validatorAddr,
      prices: [{
        coinPair: 'BTC/USD',
        price: '100000'
      }, {
        coinPair: 'LTC/USD',
        price: '100'
      }]
    }]));
    let events = [];
    oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc.on('oracle:propose-rejected', e => events.push(e));
    await oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc._handlePropose(oracleConsensusPROPOSEPairCoverageStressSwSuite1Envelope([{
      coinPair: 'BTC/USD',
      price: '100000'
    }]));
    expect(oracleConsensusPROPOSEPairCoverageStressSwSuite1Oc.pendingRounds.has(oracleConsensusPROPOSEPairCoverageStressSwSuite1ROUND)).to.be.false;
    expect(events.map(e => e.reason)).to.include('missing-pairs');
  });
}
describe('OracleConsensus PROPOSE pair-coverage (stress-sweep 2026-07-08)', function () {
  registerOracleConsensusPROPOSEPairCoverageStressSwSuite1Part1.call(this);
  registerOracleConsensusPROPOSEPairCoverageStressSwSuite1Part2.call(this);
  registerOracleConsensusPROPOSEPairCoverageStressSwSuite1Part3.call(this);
});
