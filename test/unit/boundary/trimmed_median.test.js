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

const sinon           = require('sinon');
const { expect }      = require('chai');
const OracleConsensus = require('../../../src/oracle/consensus');
const { createMockHub }      = require('../../helpers/mockHub');
const { buildSubmissions }   = require('../../helpers/fixtures');

let hub, oc, oracleRound;
function submissionsForPair(prices, coinPair) {
    let entries = prices.map((p, i) => ({
        sender: 'validator-' + i,
        prices: [{ coinPair: coinPair || 'BTC/USD', price: String(p) }]
    }));
    return buildSubmissions(entries);
}

describe('Boundary: Trimmed Median Aggregation', registerBoundaryTrimmedMedianAggregation);

function registerBoundaryTrimmedMedianAggregation() {
    beforeEach(function () {
        hub = createMockHub();
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc = new OracleConsensus(hub, oracleRound);
    });
    afterEach(function () {
        sinon.restore();
    });
    // Item 7067: the even-split gate measures the PUBLISHED price
    describe('even-split gate measures the rounded median, not the exact midpoint', registerEvenSplitGateMeasuresTheRoundedMedianNotTheExactMidpoint);
    // Item 7663: the even-count median rounds ONCE, and the gate is unconditional
    describe('even-count median rounds once', registerEvenCountMedianRoundsOnce);
    // aggregateAll boundary
    describe('aggregateAll()', registerAggregateAll);
}

function registerEvenSplitGateMeasuresTheRoundedMedianNotTheExactMidpoint() {
    // The exact-midpoint form of this gate answered a question no co-signer asks.
    // These two submissions spread 0.049999997500002625 (inside the 5% band), but
    // the 8-decimal median they produce is 0.10000011, and the low submission sits
    // 0.0500000449999505 from THAT. A follower re-deriving over the proposer-excluded
    // set lands on 0.09500010, trips the identical band in handlePropose, and
    // rejects the whole proposal, so one boundary pair wedged the entire round.
    it('drops the pair whose rounded median puts a middle submission outside the band', testDropsThePairWhoseRoundedMedianPutsAMiddleSubmissionOutsideThe);
    it('still publishes a pair whose rounded median keeps both middles inside the band', testStillPublishesAPairWhoseRoundedMedianKeepsBothMiddlesInsideThe);
    it('is never looser than the exact-midpoint form it replaced', testIsNeverLooserThanTheExactMidpointFormItReplaced);
    // deviation_band divides by the reference, and bcdiv's zero guard returns 0, so a
    // zero median would make every band check pass vacuously and federation-sign a
    // 0.00000000 price. Reachable only from a sub-8-decimal ingest value.
    it('drops a pair whose aggregate rounds to zero at 8 decimals', testDropsAPairWhoseAggregateRoundsToZeroAt8Decimals);
    it('drops an odd-length set whose only value rounds to zero at 8 decimals', testDropsAnOddLengthSetWhoseOnlyValueRoundsToZeroAt);
    it('leaves odd-length sets on the plain median path', testLeavesOddLengthSetsOnThePlainMedianPath);
}

function testDropsThePairWhoseRoundedMedianPutsAMiddleSubmissionOutsideThe() {
    const devband = require('../../../src/consensus/deviation_band.js');
    const lo = '0.09500010', hi = '0.10500011';
    // The premise, executed rather than asserted: the OLD gate passed this pair.
    expect(devband.twoSourceSpreadExceeds(lo, hi, 0.05, 18)).to.be.false;
    expect(devband.exceedsBand(lo, '0.10000011', 0.05, 18)).to.be.true;

    let subs = submissionsForPair([lo, hi], 'XCHAIN/USD');
    expect(oc.aggregate(subs, 'XCHAIN/USD')).to.be.null;
}

function testStillPublishesAPairWhoseRoundedMedianKeepsBothMiddlesInsideThe() {
    // Same neighbourhood, one ulp tighter: median 0.10000010, both middles inside.
    let subs = submissionsForPair(['0.09500011', '0.10500009'], 'XCHAIN/USD');
    expect(oc.aggregate(subs, 'XCHAIN/USD')).to.equal('0.10000010');
}

function testIsNeverLooserThanTheExactMidpointFormItReplaced() {
    // A spread the OLD gate rejected must still be rejected.
    let subs = submissionsForPair(['100', '110.6'], 'BTC/USD');
    expect(oc.aggregate(subs, 'BTC/USD')).to.be.null;
}

function testDropsAPairWhoseAggregateRoundsToZeroAt8Decimals() {
    // Two IDENTICAL sub-8-decimal values: spread 0, so the even-split gate has
    // nothing to object to and the pair reaches the median unchallenged. Before
    // this guard the aggregate published was the string '0.00000000'.
    const devband = require('../../../src/consensus/deviation_band.js');
    expect(devband.twoSourceSpreadExceeds('0.000000002', '0.000000002', 0.05, 18)).to.be.false;
    let subs = submissionsForPair(['0.000000002', '0.000000002'], 'BTC/USD');
    expect(oc.aggregate(subs, 'BTC/USD')).to.be.null;
}

function testDropsAnOddLengthSetWhoseOnlyValueRoundsToZeroAt() {
    let subs = submissionsForPair(['0.000000001'], 'BTC/USD');
    expect(oc.aggregate(subs, 'BTC/USD')).to.be.null;
}

function testLeavesOddLengthSetsOnThePlainMedianPath() {
    let subs = submissionsForPair(['0.09500010', '0.10000011', '0.10500011'], 'BTC/USD');
    expect(oc.aggregate(subs, 'BTC/USD')).to.equal('0.10000011');
}

function registerEvenCountMedianRoundsOnce() {
    // Two IDENTICAL sub-8-decimal submissions. Each quantizes to 0.00000014, so the
    // pair is unanimous. The old scale-8 add plus scale-8 divide rounded twice and
    // produced 0.00000015 - one ulp outside the camp's own value - which a co-signer
    // re-deriving over the proposer-excluded set scored at 6.667% and rejected,
    // wedging the whole round.
    it('keeps a unanimous sub-ulp pair on its own quantized value', testKeepsAUnanimousSubUlpPairOnItsOwnQuantizedValue);
    // The now-unconditional gate must not drop a pair every submitter agreed on:
    // lo === hi implies median === lo, so both band calls score 0.
    it('still publishes the unanimous sub-ulp pair rather than dropping it', testStillPublishesTheUnanimousSubUlpPairRatherThanDroppingIt);
    // Rounding once is inert at 8 decimals: this is the existing published-value
    // contract restated at the ulp boundary, where a change would show up first.
    it('is inert for 8-decimal producers at the rounding boundary', testIsInertFor8DecimalProducersAtTheRoundingBoundary);
    // The gate lost its short-circuit, not its teeth: a real two-camp disagreement
    // beyond the 5% band is still dropped.
    it('still drops two 8-decimal middles that disagree beyond the band', testStillDropsTwo8DecimalMiddlesThatDisagreeBeyondTheBand);
}

function testKeepsAUnanimousSubUlpPairOnItsOwnQuantizedValue() {
    const bcmath = require('../../../src/bcmath.js');
    // The premise, executed rather than asserted: both middles quantize to the
    // same price, and the OLD double-rounded form did not.
    expect(bcmath.bcformat('0.0000001425', 8)).to.equal('0.00000014');
    expect(bcmath.bcformat(bcmath.bcdiv(
        bcmath.bcadd('0.0000001425', '0.0000001425', 8), '2', 8), 8)).to.equal('0.00000015');

    let subs = submissionsForPair(['0.0000001425', '0.0000001425'], 'BTC/USD');
    expect(oc.aggregate(subs, 'BTC/USD')).to.equal('0.00000014');
}

function testStillPublishesTheUnanimousSubUlpPairRatherThanDroppingIt() {
    let subs = submissionsForPair(['0.0000001425', '0.0000001425'], 'BTC/USD');
    expect(oc.aggregate(subs, 'BTC/USD')).to.not.be.null;
}

function testIsInertFor8DecimalProducersAtTheRoundingBoundary() {
    expect(oc.aggregate(submissionsForPair(['1.00000001', '1.00000002']), 'BTC/USD'))
        .to.equal('1.00000002');
    expect(oc.aggregate(submissionsForPair(['1.00000001', '1.00000004']), 'BTC/USD'))
        .to.equal('1.00000003');
}

function testStillDropsTwo8DecimalMiddlesThatDisagreeBeyondTheBand() {
    let subs = submissionsForPair(['100.00000000', '120.00000000'], 'BTC/USD');
    expect(oc.aggregate(subs, 'BTC/USD')).to.be.null;
}

function registerAggregateAll() {
    it('handles multiple coin pairs with different validity', testHandlesMultipleCoinPairsWithDifferentValidity);
    it('returns empty array when all prices are invalid', testReturnsEmptyArrayWhenAllPricesAreInvalid);
}

function testHandlesMultipleCoinPairsWithDifferentValidity() {
    let entries = [
        { sender: 'v1', prices: [
            { coinPair: 'BTC/USD', price: '100000' },
            { coinPair: 'LTC/USD', price: '0' }        // invalid
        ]},
        { sender: 'v2', prices: [
            { coinPair: 'BTC/USD', price: '100002' },
            { coinPair: 'LTC/USD', price: '80' }
        ]}
    ];
    let subs = buildSubmissions(entries);
    let result = oc.aggregateAll(subs);

    let btc = result.find(r => r.coinPair === 'BTC/USD');
    let ltc = result.find(r => r.coinPair === 'LTC/USD');
    expect(btc).to.not.be.undefined;
    expect(btc.price).to.equal('100001.00000000');
    expect(ltc).to.not.be.undefined;
    expect(ltc.price).to.equal('80.00000000');
}

function testReturnsEmptyArrayWhenAllPricesAreInvalid() {
    let entries = [
        { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '0' }] }
    ];
    let subs = buildSubmissions(entries);
    let result = oc.aggregateAll(subs);
    expect(result).to.deep.equal([]);
}
