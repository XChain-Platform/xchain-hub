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

// Build submissions for a single coin pair from an array of prices.
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
    // TRIM_PERCENT = 0.15
    // trimCount = floor(N * 0.15), applied only when trimCount > 0 AND N > 2
    //
    // Transition points:
    //   N=1–6:  trimCount=0 (no trim)
    //   N=7:    trimCount=1 (first trim)
    //   N=13:   trimCount=1 → N=14: trimCount=2
    //   N=20:   trimCount=3
    describe('trim threshold transitions', registerTrimThresholdTransitions);
    // Outlier handling
    describe('outlier handling', registerOutlierHandling);
    // Identical values
    describe('all-identical values', registerAllIdenticalValues);
    // Float precision
    describe('float precision', registerFloatPrecision);
    // Invalid / missing price data
    describe('invalid price data', registerInvalidPriceData);
}

function registerTrimThresholdTransitions() {
    it('N=1: no trim, returns single value', testN1NoTrimReturnsSingleValue);
    it('N=2: no trim, returns average of two', testN2NoTrimReturnsAverageOfTwo);
    it('N=3: trimCount=0, no trim, returns middle value', testN3TrimCount0NoTrimReturnsMiddleValue);
    it('N=6: trimCount=1, even post-trim count medians the middle pair', testN6TrimCount1EvenPostTrimCountMediansTheMiddlePair);
    it('N=7: trimCount=1, trims 1 from each end (first trim transition)', testN7TrimCount1Trims1FromEachEndFirstTrimTransition);
    it('N=13: trimCount=1, still trims only 1', testN13TrimCount1StillTrimsOnly1);
    it('N=14: trimCount=3, trims 3 from each end (second trim transition)', testN14TrimCount3Trims3FromEachEndSecondTrimTransition);
    it('N=20: trimCount=3, trims 3 from each end', testN20TrimCount3Trims3FromEachEnd);
}
function testN1NoTrimReturnsSingleValue() {
    let subs = submissionsForPair([42000]);
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('42000.00000000');
}
function testN2NoTrimReturnsAverageOfTwo() {
    // Within the 2-source deviation gate (spread 2/300 ~ 0.67% < 5%) so the
    // gate passes and the no-trim mean is returned; the gate itself is
    // covered separately in OracleConsensus.test.js.
    let subs = submissionsForPair([149, 151]);
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('150.00000000');
}
function testN3TrimCount0NoTrimReturnsMiddleValue() {
    // floor(3 * 0.15) = 0
    let subs = submissionsForPair([10, 20, 30]);
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('20.00000000');
}
function testN6TrimCount1EvenPostTrimCountMediansTheMiddlePair() {
    // ceil(6 * 0.15) = 1 → after trim: [1002, 1004, 1006, 1008]
    // Clustered prices so the even-split deviation gate passes (middle-pair spread
    // (1006-1004)/2010 ≈ 0.1% << 5%); the gate itself is covered in
    // OracleConsensus.test.js.
    let subs = submissionsForPair([1000, 1002, 1004, 1006, 1008, 1010]);
    // Even count: median = (1004+1006)/2 = 1005
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('1005.00000000');
}
function testN7TrimCount1Trims1FromEachEndFirstTrimTransition() {
    // floor(7 * 0.15) = 1
    let subs = submissionsForPair([1, 2, 3, 4, 5, 6, 7]);
    // After trim: [2, 3, 4, 5, 6] → median = 4
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('4.00000000');
}
function testN13TrimCount1StillTrimsOnly1() {
    // floor(13 * 0.15) = 1
    let prices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    let subs = submissionsForPair(prices);
    // After trim: [2..12] (11 values) → median = 7
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('7.00000000');
}
function testN14TrimCount3Trims3FromEachEndSecondTrimTransition() {
    // ceil(14 * 0.15) = 3
    // Clustered prices so the even-split deviation gate passes (middle-pair spread
    // (1014-1012)/2026 ≈ 0.1% << 5%).
    let prices = Array.from({ length: 14 }, (_, i) => 1000 + i * 2);
    let subs = submissionsForPair(prices);
    // After trim: [1006..1020] (8 values) → median = (1012+1014)/2 = 1013
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('1013.00000000');
}
function testN20TrimCount3Trims3FromEachEnd() {
    // floor(20 * 0.15) = 3
    let prices = Array.from({ length: 20 }, (_, i) => i + 1);
    let subs = submissionsForPair(prices);
    // After trim: [4..17] (14 values) → median = (10+11)/2 = 10.5
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('10.50000000');
}

function registerOutlierHandling() {
    it('N=5 (no trim): extreme outlier stays in dataset (if within price bounds)', testN5NoTrimExtremeOutlierStaysInDatasetIfWithinPrice);
    it('N=7 (trim=1): extreme outlier is trimmed', testN7Trim1ExtremeOutlierIsTrimmed);
    it('N=7: both low and high outliers are trimmed', testN7BothLowAndHighOutliersAreTrimmed);
}
function testN5NoTrimExtremeOutlierStaysInDatasetIfWithinPrice() {
    // floor(5 * 0.15) = 0 → no trim
    // Outlier 9999999 is within 10M bounds so it stays
    let subs = submissionsForPair([100000, 100001, 100002, 100003, 9999999]);
    // Sorted: [100000, 100001, 100002, 100003, 9999999] → median = 100002
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100002.00000000');
}
function testN7Trim1ExtremeOutlierIsTrimmed() {
    let subs = submissionsForPair([100000, 100001, 100002, 100003, 100004, 100005, 9999999]);
    // After trim: [100001, 100002, 100003, 100004, 100005] → median = 100003
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100003.00000000');
}
function testN7BothLowAndHighOutliersAreTrimmed() {
    let subs = submissionsForPair([1, 100000, 100001, 100002, 100003, 100004, 999999]);
    // After trim: [100000, 100001, 100002, 100003, 100004] → median = 100002
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100002.00000000');
}

function registerAllIdenticalValues() {
    it('N=1: single identical → returns that value', testN1SingleIdenticalReturnsThatValue);
    it('N=5: all identical, no trim → returns that value', testN5AllIdenticalNoTrimReturnsThatValue);
    it('N=10: all identical, trim removes same values → still that value', testN10AllIdenticalTrimRemovesSameValuesStillThatValue);
}
function testN1SingleIdenticalReturnsThatValue() {
    let subs = submissionsForPair([65000]);
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('65000.00000000');
}
function testN5AllIdenticalNoTrimReturnsThatValue() {
    let subs = submissionsForPair([65000, 65000, 65000, 65000, 65000]);
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('65000.00000000');
}
function testN10AllIdenticalTrimRemovesSameValuesStillThatValue() {
    let subs = submissionsForPair(Array(10).fill(65000));
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('65000.00000000');
}

function registerFloatPrecision() {
    it('very small price (8 decimal places)', testVerySmallPrice8DecimalPlaces);
    it('average of two close floats preserves precision', testAverageOfTwoCloseFloatsPreservesPrecision);
    it('large price value within bounds', testLargePriceValueWithinBounds);
    it('toFixed(8) output format is consistent', testToFixed8OutputFormatIsConsistent);
}
function testVerySmallPrice8DecimalPlaces() {
    let subs = submissionsForPair([0.00000001]);
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('0.00000001');
}
function testAverageOfTwoCloseFloatsPreservesPrecision() {
    // Relatively-close pair so the 2-source deviation gate passes (spread
    // ~1e-8 << 5%), while the mean still lands exactly on an 8-dp boundary
    // to exercise bignumber precision: (1.00000001 + 1.00000003)/2.
    let subs = submissionsForPair([1.00000001, 1.00000003]);
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('1.00000002');
}
function testLargePriceValueWithinBounds() {
    let subs = submissionsForPair([9999999]);
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('9999999.00000000');
}
function testToFixed8OutputFormatIsConsistent() {
    let subs = submissionsForPair([1.5]);
    let result = oc._aggregate(subs, 'BTC/USD');
    expect(result).to.match(/^\d+\.\d{8}$/);
}

function registerInvalidPriceData() {
    it('returns null for empty submissions', testReturnsNullForEmptySubmissions);
    it('returns null for unknown coin pair', testReturnsNullForUnknownCoinPair);
    it('filters out zero prices', testFiltersOutZeroPrices);
    it('filters out negative prices', testFiltersOutNegativePrices);
    it('filters out NaN prices', testFiltersOutNaNPrices);
    it('returns null when ALL prices are invalid', testReturnsNullWhenALLPricesAreInvalid);
    it('handles submission with missing prices array', testHandlesSubmissionWithMissingPricesArray);
    it('handles submission with empty prices array', testHandlesSubmissionWithEmptyPricesArray);
}
function testReturnsNullForEmptySubmissions() {
    expect(oc._aggregate(new Map(), 'BTC/USD')).to.be.null;
}
function testReturnsNullForUnknownCoinPair() {
    let subs = submissionsForPair([100000]);
    expect(oc._aggregate(subs, 'ETH/USD')).to.be.null;
}
function testFiltersOutZeroPrices() {
    let entries = [
        { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '0' }] },
        { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '50000' }] }
    ];
    let subs = buildSubmissions(entries);
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('50000.00000000');
}
function testFiltersOutNegativePrices() {
    let entries = [
        { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '-100' }] },
        { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '50000' }] }
    ];
    let subs = buildSubmissions(entries);
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('50000.00000000');
}
function testFiltersOutNaNPrices() {
    let entries = [
        { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: 'not-a-number' }] },
        { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '42000' }] }
    ];
    let subs = buildSubmissions(entries);
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('42000.00000000');
}
function testReturnsNullWhenALLPricesAreInvalid() {
    let entries = [
        { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '0' }] },
        { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '-1' }] },
        { sender: 'v3', prices: [{ coinPair: 'BTC/USD', price: 'NaN' }] }
    ];
    let subs = buildSubmissions(entries);
    expect(oc._aggregate(subs, 'BTC/USD')).to.be.null;
}
function testHandlesSubmissionWithMissingPricesArray() {
    let subs = new Map();
    subs.set('v1', { prices: null, sources: 0, timestamp: Date.now() });
    subs.set('v2', { prices: [{ coinPair: 'BTC/USD', price: '50000' }], sources: 1, timestamp: Date.now() });
    expect(oc._aggregate(subs, 'BTC/USD')).to.equal('50000.00000000');
}
function testHandlesSubmissionWithEmptyPricesArray() {
    let subs = new Map();
    subs.set('v1', { prices: [], sources: 0, timestamp: Date.now() });
    expect(oc._aggregate(subs, 'BTC/USD')).to.be.null;
}
