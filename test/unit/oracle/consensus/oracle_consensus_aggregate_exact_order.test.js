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
// CONSENSUS GUARD: the aggregate for a pair is a function of the submitted values alone,
// never of the order they arrived in. Above 2^26 two 8-decimal prices one ulp apart parse
// to the same float (BTC/KRW sits near 1.5e8), so a float-ordered sort leaves them in
// arrival order and the median, and with it the round digest, depends on gossip timing.

const sinon            = require('sinon');
const { expect }       = require('chai');
const OracleConsensus  = require('../../../../src/oracle/consensus');
const { createMockHub } = require('../../../helpers/mockHub');
const { buildSubmissions } = require('../../../helpers/fixtures');

const PAIR = 'BTC/KRW';

function permutations(arr) {
    if (arr.length <= 1) return [arr.slice()];
    let out = [];
    arr.forEach((x, i) => {
        for (let rest of permutations(arr.slice(0, i).concat(arr.slice(i + 1)))) out.push([x].concat(rest));
    });
    return out;
}

function newOc() {
    return new OracleConsensus(createMockHub(), { getSubmissions: sinon.stub().returns(new Map()) });
}

// Every arrival order of the given prices, one sender each: the set of distinct
// aggregate arrays and the set of distinct round digests they produce.
function outcomesOverOrders(prices) {
    let oc = newOc();
    let entries = prices.map((price, i) => ({ sender: 'v' + (i + 1), prices: [{ coinPair: PAIR, price }] }));
    let arrays = new Set(), digests = new Set();
    for (let order of permutations(entries)) {
        let out = oc.aggregateAll(buildSubmissions(order));
        arrays.add(JSON.stringify(out));
        digests.add(oc.digest(7, out));
    }
    return { arrays: [...arrays], digests: [...digests] };
}

describe('OracleConsensus.aggregate: exact decimal order, independent of arrival order', function () {
    afterEach(function () { sinon.restore(); });

    it('publishes one median for an odd set whose middle pair is float-equal', function () {
        let r = outcomesOverOrders(['150123456.12345678', '150123456.12345679', '150200000.00000000']);
        expect(r.arrays).to.deep.equal([JSON.stringify([{ coinPair: PAIR, price: '150123456.12345679' }])]);
        expect(r.digests).to.have.lengthOf(1);
    });

    it('publishes one mean for an even set whose upper middle is float-equal to its neighbour', function () {
        let r = outcomesOverOrders(['149000000', '149500000', '150000000.00000000', '150000000.00000001']);
        expect(r.arrays).to.deep.equal([JSON.stringify([{ coinPair: PAIR, price: '149750000.00000000' }])]);
        expect(r.digests).to.have.lengthOf(1);
    });

    it('gives one digest across 120 orders of five hubs with a one-ulp BTC/KRW tie at the median', function () {
        let r = outcomesOverOrders(['151800000.00000001', '151800000.00000000', '151800000.00000002',
            '151000000', '152600000']);
        expect(r.arrays).to.deep.equal([JSON.stringify([{ coinPair: PAIR, price: '151800000.00000001' }])]);
        expect(r.digests).to.have.lengthOf(1);
    });

    it('keeps the bytes identical when equal values are spelled differently', function () {
        let r = outcomesOverOrders(['100', '100.00000000', '100.0', '250']);
        expect(r.arrays).to.deep.equal([JSON.stringify([{ coinPair: PAIR, price: '100.00000000' }])]);
    });

    it('still orders ordinary distinct prices by value', function () {
        let r = outcomesOverOrders(['100.00000002', '99.99999999', '100.00000001', '100', '100.00000003']);
        expect(r.arrays).to.deep.equal([JSON.stringify([{ coinPair: PAIR, price: '100.00000001' }])]);
    });
});
