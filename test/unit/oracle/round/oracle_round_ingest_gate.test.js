'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Stress-sweep 2026-07-08: OracleRound ingest gate.
//   - Unregistered senders must not enter the aggregate (Sybil stuffing).
//   - Non-canonical coin pairs must not enter the aggregate (pair injection).
const sinon = require('sinon');
const {
  expect
} = require('chai');
const proxyquire = require('proxyquire');
const {
  createMockHub
} = require('../../../helpers/mockHub');
const {
  pubkeyForTestSender
} = require('../../../helpers/fixtures');
let oracleRoundIngestGateStressSweepSuite1Hub, oracleRoundIngestGateStressSweepSuite1Pm, oracleRoundIngestGateStressSweepSuite1Or, oracleRoundIngestGateStressSweepSuite1OracleRound;
// sigPubkey defaults to a key unique to this sender. Admission keys on the
// PROVEN signing key now, so an envelope without one is never counted.
function oracleRoundIngestGateStressSweepSuite1Submit(sender, prices, round, sigPubkey) {
  oracleRoundIngestGateStressSweepSuite1Or._handleMessage({
    type: 'ORACLE_PRICE_SUBMIT',
    sender,
    sig_pubkey: sigPubkey || pubkeyForTestSender(sender),
    data: {
      round,
      prices,
      sources: 1,
      timestamp: Date.now()
    }
  });
}
function registerOracleRoundIngestGateStressSweepSuite1Part1() {
  beforeEach(function () {
    let mockPriceFetcher = {
      fetchPrices: sinon.stub().resolves([{
        coinPair: 'BTC/USD',
        price: '100000.00000000',
        sources: 2
      }])
    };
    oracleRoundIngestGateStressSweepSuite1OracleRound = proxyquire('../../../../src/oracle/round', {
      './price_fetcher': function () {
        return mockPriceFetcher;
      }
    });
    oracleRoundIngestGateStressSweepSuite1Hub = createMockHub({
      p2pConfig: {
        ORACLE_ROUND_INTERVAL: '60000',
        ORACLE_SUBMISSION_WINDOW: '30000'
      }
    });
    oracleRoundIngestGateStressSweepSuite1Pm = oracleRoundIngestGateStressSweepSuite1Hub._peerManager;
    oracleRoundIngestGateStressSweepSuite1Or = new oracleRoundIngestGateStressSweepSuite1OracleRound(oracleRoundIngestGateStressSweepSuite1Hub);
  });
  afterEach(function () {
    sinon.restore();
  });
  it('drops a submission from an unregistered sender when the registry is populated', async function () {
    await oracleRoundIngestGateStressSweepSuite1Or._executeRound();
    let round = oracleRoundIngestGateStressSweepSuite1Or.currentRound;
    // Registry populated with only the self validator + one real peer.
    oracleRoundIngestGateStressSweepSuite1Pm.validatorPubkeys = new Map([[oracleRoundIngestGateStressSweepSuite1Pm.validatorAddr, 'aa'.repeat(32)], ['ws://real-peer:10001', 'bb'.repeat(32)]]);
    oracleRoundIngestGateStressSweepSuite1Submit('ws://forged-sender-xyz:10001', [{
      coinPair: 'BTC/USD',
      price: '1'
    }], round, 'ee'.repeat(32)); // a key neither the chain nor the registry attributes

    let subs = oracleRoundIngestGateStressSweepSuite1Or.submissions.get(round);
    expect(subs.has('ws://forged-sender-xyz:10001')).to.equal(false);
  });
  it('accepts a submission from a registered sender', async function () {
    await oracleRoundIngestGateStressSweepSuite1Or._executeRound();
    let round = oracleRoundIngestGateStressSweepSuite1Or.currentRound;
    oracleRoundIngestGateStressSweepSuite1Pm.validatorPubkeys = new Map([[oracleRoundIngestGateStressSweepSuite1Pm.validatorAddr, 'aa'.repeat(32)], ['ws://real-peer:10001', 'bb'.repeat(32)]]);
    oracleRoundIngestGateStressSweepSuite1Submit('ws://real-peer:10001', [{
      coinPair: 'BTC/USD',
      price: '100001'
    }], round, 'bb'.repeat(32));
    expect(oracleRoundIngestGateStressSweepSuite1Or.submissions.get(round).has('ws://real-peer:10001')).to.equal(true);
  });
}
function registerOracleRoundIngestGateStressSweepSuite1Part2() {
  it('bootstrap (empty registry) still accepts submissions', async function () {
    await oracleRoundIngestGateStressSweepSuite1Or._executeRound();
    let round = oracleRoundIngestGateStressSweepSuite1Or.currentRound;
    oracleRoundIngestGateStressSweepSuite1Pm.validatorPubkeys = new Map(); // empty => permissive bootstrap
    oracleRoundIngestGateStressSweepSuite1Submit('ws://anyone:10001', [{
      coinPair: 'BTC/USD',
      price: '100001'
    }], round);
    expect(oracleRoundIngestGateStressSweepSuite1Or.submissions.get(round).has('ws://anyone:10001')).to.equal(true);
  });
  it('drops a fabricated (non-canonical) coin pair on ingest', async function () {
    await oracleRoundIngestGateStressSweepSuite1Or._executeRound();
    let round = oracleRoundIngestGateStressSweepSuite1Or.currentRound;
    oracleRoundIngestGateStressSweepSuite1Pm.validatorPubkeys = new Map(); // bootstrap: sender gate open, isolate the pair gate
    oracleRoundIngestGateStressSweepSuite1Submit('ws://peer:10001', [{
      coinPair: 'BTC/ZZZ',
      price: '5'
    }], round);
    // Only a bogus pair => no valid prices => no submission recorded.
    expect(oracleRoundIngestGateStressSweepSuite1Or.submissions.get(round).has('ws://peer:10001')).to.equal(false);
  });
  it('drops a price whose spelling parseFloat would admit as a prefix', async function () {
    await oracleRoundIngestGateStressSweepSuite1Or._executeRound();
    let round = oracleRoundIngestGateStressSweepSuite1Or.currentRound;
    oracleRoundIngestGateStressSweepSuite1Pm.validatorPubkeys = new Map(); // bootstrap: isolate the price gate
    // parseFloat('100junk') is 100 and clears every bound, while bcmath.bcnum
    // reads the same string as 0: admitting it puts two numbers in the round.
    oracleRoundIngestGateStressSweepSuite1Submit('ws://peer:10001', [{
      coinPair: 'BTC/USD',
      price: '100junk'
    }], round);
    expect(oracleRoundIngestGateStressSweepSuite1Or.submissions.get(round).has('ws://peer:10001')).to.equal(false);
  });
  it('never lets a malformed price reach the persisted audit row', async function () {
    await oracleRoundIngestGateStressSweepSuite1Or._executeRound();
    let round = oracleRoundIngestGateStressSweepSuite1Or.currentRound;
    oracleRoundIngestGateStressSweepSuite1Pm.validatorPubkeys = new Map([['ws://peer:10001', 'bb'.repeat(32)]]);
    let persist = sinon.spy(oracleRoundIngestGateStressSweepSuite1Or, 'persistSubmissions');
    oracleRoundIngestGateStressSweepSuite1Submit('ws://peer:10001', [{
      coinPair: 'BTC/USD',
      price: '100junk'
    }, {
      coinPair: 'LTC/USD',
      price: '90'
    }], round, 'bb'.repeat(32));
    expect(persist.calledOnce).to.equal(true);
    let persisted = persist.firstCall.args[2].map(p => p.price);
    expect(persisted).to.deep.equal(['90']);
  });
}
function registerOracleRoundIngestGateStressSweepSuite1Part3() {
  it('drops a non-scalar price a coercing gate would admit', async function () {
    await oracleRoundIngestGateStressSweepSuite1Or._executeRound();
    let round = oracleRoundIngestGateStressSweepSuite1Or.currentRound;
    oracleRoundIngestGateStressSweepSuite1Pm.validatorPubkeys = new Map();
    // parseFloat(['100']) is 100, so an array-valued price cleared the old gate.
    oracleRoundIngestGateStressSweepSuite1Submit('ws://peer:10001', [{
      coinPair: 'BTC/USD',
      price: ['100']
    }], round);
    expect(oracleRoundIngestGateStressSweepSuite1Or.submissions.get(round).has('ws://peer:10001')).to.equal(false);
  });
  it('keeps an honest bcformat price spelling byte-identical', async function () {
    await oracleRoundIngestGateStressSweepSuite1Or._executeRound();
    let round = oracleRoundIngestGateStressSweepSuite1Or.currentRound;
    oracleRoundIngestGateStressSweepSuite1Pm.validatorPubkeys = new Map();
    oracleRoundIngestGateStressSweepSuite1Submit('ws://peer:10001', [{
      coinPair: 'BTC/USD',
      price: '100000.00000000'
    }], round);
    let sub = oracleRoundIngestGateStressSweepSuite1Or.submissions.get(round).get('ws://peer:10001');
    expect(sub).to.exist;
    expect(sub.prices[0].price).to.equal('100000.00000000');
  });
  it('keeps canonical pairs and strips only the bogus ones from a mixed submission', async function () {
    await oracleRoundIngestGateStressSweepSuite1Or._executeRound();
    let round = oracleRoundIngestGateStressSweepSuite1Or.currentRound;
    oracleRoundIngestGateStressSweepSuite1Pm.validatorPubkeys = new Map();
    oracleRoundIngestGateStressSweepSuite1Submit('ws://peer:10001', [{
      coinPair: 'BTC/ZZZ',
      price: '5'
    }, {
      coinPair: 'LTC/USD',
      price: '90'
    }], round);
    let sub = oracleRoundIngestGateStressSweepSuite1Or.submissions.get(round).get('ws://peer:10001');
    expect(sub).to.exist;
    let pairs = sub.prices.map(p => p.coinPair);
    expect(pairs).to.deep.equal(['LTC/USD']);
  });
}
describe('OracleRound ingest gate (stress-sweep 2026-07-08)', function () {
  registerOracleRoundIngestGateStressSweepSuite1Part1.call(this);
  registerOracleRoundIngestGateStressSweepSuite1Part2.call(this);
  registerOracleRoundIngestGateStressSweepSuite1Part3.call(this);
});
