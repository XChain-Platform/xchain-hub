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
const OracleConsensus = require('../../../src/OracleConsensus');
const { createMockHub }      = require('../../helpers/mockHub');
const { buildSubmissions }   = require('../../helpers/fixtures');

describe('Boundary: Trimmed Median Aggregation', function () {

    let hub, oc, oracleRound;

    beforeEach(function () {
        hub = createMockHub();
        oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
        oc = new OracleConsensus(hub, oracleRound);
    });

    afterEach(function () {
        sinon.restore();
    });

    // Helper: build submissions for a single coin pair from an array of prices
    function submissionsForPair(prices, coinPair) {
        let entries = prices.map((p, i) => ({
            sender: 'validator-' + i,
            prices: [{ coinPair: coinPair || 'BTC/USD', price: String(p) }]
        }));
        return buildSubmissions(entries);
    }

    // -----------------------------------------------------------------
    // TRIM_PERCENT = 0.15
    // trimCount = floor(N * 0.15), applied only when trimCount > 0 AND N > 2
    //
    // Transition points:
    //   N=1–6:  trimCount=0 (no trim)
    //   N=7:    trimCount=1 (first trim)
    //   N=13:   trimCount=1 → N=14: trimCount=2
    //   N=20:   trimCount=3
    // -----------------------------------------------------------------

    describe('trim threshold transitions', function () {

        it('N=1: no trim, returns single value', function () {
            let subs = submissionsForPair([42000]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('42000.00000000');
        });

        it('N=2: no trim, returns average of two', function () {
            let subs = submissionsForPair([100, 200]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('150.00000000');
        });

        it('N=3: trimCount=0, no trim, returns middle value', function () {
            // floor(3 * 0.15) = 0
            let subs = submissionsForPair([10, 20, 30]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('20.00000000');
        });

        it('N=6: trimCount=0, no trim (last N before trim kicks in)', function () {
            // floor(6 * 0.15) = 0
            let subs = submissionsForPair([1, 2, 3, 4, 5, 6]);
            // Even count: median = (3+4)/2 = 3.5
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('3.50000000');
        });

        it('N=7: trimCount=1, trims 1 from each end (first trim transition)', function () {
            // floor(7 * 0.15) = 1
            let subs = submissionsForPair([1, 2, 3, 4, 5, 6, 7]);
            // After trim: [2, 3, 4, 5, 6] → median = 4
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('4.00000000');
        });

        it('N=13: trimCount=1, still trims only 1', function () {
            // floor(13 * 0.15) = 1
            let prices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
            let subs = submissionsForPair(prices);
            // After trim: [2..12] (11 values) → median = 7
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('7.00000000');
        });

        it('N=14: trimCount=2, trims 2 from each end (second trim transition)', function () {
            // floor(14 * 0.15) = 2
            let prices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
            let subs = submissionsForPair(prices);
            // After trim: [3..12] (10 values) → median = (7+8)/2 = 7.5
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('7.50000000');
        });

        it('N=20: trimCount=3, trims 3 from each end', function () {
            // floor(20 * 0.15) = 3
            let prices = Array.from({ length: 20 }, (_, i) => i + 1);
            let subs = submissionsForPair(prices);
            // After trim: [4..17] (14 values) → median = (10+11)/2 = 10.5
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('10.50000000');
        });
    });

    // -----------------------------------------------------------------
    // Outlier handling
    // -----------------------------------------------------------------

    describe('outlier handling', function () {

        it('N=5 (no trim): extreme outlier stays in dataset (if within price bounds)', function () {
            // floor(5 * 0.15) = 0 → no trim
            // Outlier 9999999 is within 10M bounds so it stays
            let subs = submissionsForPair([100000, 100001, 100002, 100003, 9999999]);
            // Sorted: [100000, 100001, 100002, 100003, 9999999] → median = 100002
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100002.00000000');
        });

        it('N=7 (trim=1): extreme outlier is trimmed', function () {
            let subs = submissionsForPair([100000, 100001, 100002, 100003, 100004, 100005, 9999999]);
            // After trim: [100001, 100002, 100003, 100004, 100005] → median = 100003
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100003.00000000');
        });

        it('N=7: both low and high outliers are trimmed', function () {
            let subs = submissionsForPair([1, 100000, 100001, 100002, 100003, 100004, 999999]);
            // After trim: [100000, 100001, 100002, 100003, 100004] → median = 100002
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100002.00000000');
        });
    });

    // -----------------------------------------------------------------
    // Identical values
    // -----------------------------------------------------------------

    describe('all-identical values', function () {

        it('N=1: single identical → returns that value', function () {
            let subs = submissionsForPair([65000]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('65000.00000000');
        });

        it('N=5: all identical, no trim → returns that value', function () {
            let subs = submissionsForPair([65000, 65000, 65000, 65000, 65000]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('65000.00000000');
        });

        it('N=10: all identical, trim removes same values → still that value', function () {
            let subs = submissionsForPair(Array(10).fill(65000));
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('65000.00000000');
        });
    });

    // -----------------------------------------------------------------
    // Float precision
    // -----------------------------------------------------------------

    describe('float precision', function () {

        it('very small price (8 decimal places)', function () {
            let subs = submissionsForPair([0.00000001]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('0.00000001');
        });

        it('average of two close floats preserves precision', function () {
            let subs = submissionsForPair([0.00000001, 0.00000003]);
            // (0.00000001 + 0.00000003) / 2 = 0.00000002
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('0.00000002');
        });

        it('large price value within bounds', function () {
            let subs = submissionsForPair([9999999]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('9999999.00000000');
        });

        it('toFixed(8) output format is consistent', function () {
            let subs = submissionsForPair([1.5]);
            let result = oc._aggregate(subs, 'BTC/USD');
            expect(result).to.match(/^\d+\.\d{8}$/);
        });
    });

    // -----------------------------------------------------------------
    // Invalid / missing price data
    // -----------------------------------------------------------------

    describe('invalid price data', function () {

        it('returns null for empty submissions', function () {
            expect(oc._aggregate(new Map(), 'BTC/USD')).to.be.null;
        });

        it('returns null for unknown coin pair', function () {
            let subs = submissionsForPair([100000]);
            expect(oc._aggregate(subs, 'ETH/USD')).to.be.null;
        });

        it('filters out zero prices', function () {
            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '0' }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '50000' }] }
            ];
            let subs = buildSubmissions(entries);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('50000.00000000');
        });

        it('filters out negative prices', function () {
            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '-100' }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '50000' }] }
            ];
            let subs = buildSubmissions(entries);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('50000.00000000');
        });

        it('filters out NaN prices', function () {
            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: 'not-a-number' }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '42000' }] }
            ];
            let subs = buildSubmissions(entries);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('42000.00000000');
        });

        it('returns null when ALL prices are invalid', function () {
            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '0' }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '-1' }] },
                { sender: 'v3', prices: [{ coinPair: 'BTC/USD', price: 'NaN' }] }
            ];
            let subs = buildSubmissions(entries);
            expect(oc._aggregate(subs, 'BTC/USD')).to.be.null;
        });

        it('handles submission with missing prices array', function () {
            let subs = new Map();
            subs.set('v1', { prices: null, sources: 0, timestamp: Date.now() });
            subs.set('v2', { prices: [{ coinPair: 'BTC/USD', price: '50000' }], sources: 1, timestamp: Date.now() });
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('50000.00000000');
        });

        it('handles submission with empty prices array', function () {
            let subs = new Map();
            subs.set('v1', { prices: [], sources: 0, timestamp: Date.now() });
            expect(oc._aggregate(subs, 'BTC/USD')).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // _aggregateAll boundary
    // -----------------------------------------------------------------

    describe('_aggregateAll()', function () {

        it('handles multiple coin pairs with different validity', function () {
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
            let result = oc._aggregateAll(subs);

            let btc = result.find(r => r.coinPair === 'BTC/USD');
            let ltc = result.find(r => r.coinPair === 'LTC/USD');
            expect(btc).to.not.be.undefined;
            expect(btc.price).to.equal('100001.00000000');
            expect(ltc).to.not.be.undefined;
            expect(ltc.price).to.equal('80.00000000');
        });

        it('returns empty array when all prices are invalid', function () {
            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '0' }] }
            ];
            let subs = buildSubmissions(entries);
            let result = oc._aggregateAll(subs);
            expect(result).to.deep.equal([]);
        });
    });
});
