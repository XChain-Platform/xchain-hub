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
//
// The local source median rounds an even-count midpoint ONCE, at the final 8-decimal
// format, the same rule the consensus aggregate applies to the submissions this value
// becomes. Rounding the sum and then the halving each to 8 decimals lands one ulp off
// the value both middle sources agree on.

const { expect }      = require('chai');
const sinon           = require('sinon');
const PriceFetcher    = require('../../../../../src/oracle/price_fetcher');
const OracleConsensus = require('../../../../../src/oracle/consensus');
const { createMockHub } = require('../../../../helpers/mockHub');
const { buildSubmissions } = require('../../../../helpers/fixtures');

// The consensus aggregate for the same values, one submitter each.
function consensusMedian(values) {
    let oc = new OracleConsensus(createMockHub(), { getSubmissions: sinon.stub().returns(new Map()) });
    let subs = buildSubmissions(values.map((v, i) => ({
        sender: 'v' + (i + 1), prices: [{ coinPair: 'BTC/USD', price: String(v) }] })));
    return oc.aggregate(subs, 'BTC/USD');
}

describe('PriceFetcher.computeMedian: even-count midpoint rounds once', function () {
    let pf;

    beforeEach(function () { pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0 }); });
    afterEach(function () { sinon.restore(); });

    it('returns the shared value when two sources agree below one ulp', function () {
        expect(pf.computeMedian([1.425e-7, 1.425e-7])).to.equal('0.00000014');
    });

    it('rounds the exact midpoint of finer-than-8-decimal middles', function () {
        expect(pf.computeMedian([100.123456784, 100.123456785])).to.equal('100.12345678');
        expect(pf.computeMedian([1.000000004, 1.000000004, 0.9, 1.1])).to.equal('1.00000000');
    });

    it('agrees with the consensus median on the same 8-decimal-or-finer values', function () {
        for (let set of [[0.0000001425, 0.0000001425], [100.123456784, 100.123456785],
            [1.000000004, 1.000000004], [100.5, 100.50000001, 100.7, 100.9]]) {
            expect(pf.computeMedian(set), JSON.stringify(set)).to.equal(consensusMedian(set.map(v => v.toFixed(10))));
        }
    });
});
