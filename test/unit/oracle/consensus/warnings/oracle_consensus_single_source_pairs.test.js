'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const finalizeRoundMethods = require('../../../../../src/oracle/consensus/finalize_round.js');
const { singleSourcePairs } = require('../../../../../src/oracle/consensus/source_diversity.js');

function submissions(rows) {
    return new Map(rows.map(row => [row.submitter, { prices: row.prices }]));
}

describe('singleSourcePairs()', function () {
    it('filters capable pairs and sorts de-duplicated pairs and submitters', function () {
        let result = singleSourcePairs(submissions([
            { submitter: 'bbbbbbbbbbbb-extra', prices: [
                { coinPair: 'ETH/USD', sources: 1 },
                { coinPair: 'BTC/USD', sources: 1 },
                { coinPair: 'BTC/USD', sources: 0 }
            ] },
            { submitter: 'aaaaaaaaaaaa-extra', prices: [
                { coinPair: 'BTC/USD', sources: 1 },
                { coinPair: 'DOGE/USD', sources: 1 },
                { coinPair: 'ETH/USD', sources: 2 }
            ] }
        ]), new Set(['BTC/USD', 'ETH/USD']));

        expect(result).to.deep.equal({
            pairs: [
                { coinPair: 'BTC/USD', submitters: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'] },
                { coinPair: 'ETH/USD', submitters: ['bbbbbbbbbbbb'] }
            ],
            total: 2
        });
    });

    it('truncates the sorted array while retaining the full count', function () {
        let result = singleSourcePairs(submissions([
            { submitter: 'submitter-three', prices: [
                { coinPair: 'C/USD', sources: 1 },
                { coinPair: 'A/USD', sources: 1 },
                { coinPair: 'B/USD', sources: 1 }
            ] }
        ]), null, 2);

        expect(result.pairs.map(pair => pair.coinPair)).to.deep.equal(['A/USD', 'B/USD']);
        expect(result.total).to.equal(3);
    });

    it('uses a five-pair default limit', function () {
        let prices = ['F', 'E', 'D', 'C', 'B', 'A']
            .map(name => ({ coinPair: name + '/USD', sources: 1 }));
        let result = singleSourcePairs(submissions([{ submitter: 'submitter', prices }]));

        expect(result.pairs.map(pair => pair.coinPair)).to.deep.equal(
            ['A/USD', 'B/USD', 'C/USD', 'D/USD', 'E/USD']);
        expect(result.total).to.equal(6);
    });
});

describe('singleSourcePairs() empty and invalid input', function () {
    it('returns no pairs when submissions carry no source counts', function () {
        let result = singleSourcePairs(submissions([
            { submitter: 'submitter', prices: [{ coinPair: 'BTC/USD' }] }
        ]));
        expect(result).to.deep.equal({ pairs: [], total: 0 });
    });

    it('ignores non-numeric source counts', function () {
        let result = singleSourcePairs(submissions([
            { submitter: 'submitter', prices: [
                { coinPair: 'BTC/USD', sources: '1' },
                { coinPair: 'ETH/USD', sources: null }
            ] }
        ]));
        expect(result).to.deep.equal({ pairs: [], total: 0 });
    });

    it('returns no pairs for an empty submission map', function () {
        expect(singleSourcePairs(new Map())).to.deep.equal({ pairs: [], total: 0 });
    });
});

describe('noteSourceDiversity()', function () {
    afterEach(function () { sinon.restore(); });

    it('names the single-source pair in its warning', function () {
        let warn = sinon.stub(console, 'warn');
        let context = {
            oracleRound: null,
            computeMinRoundSources: finalizeRoundMethods.computeMinRoundSources,
            _singleSourceRounds: 0,
            _lastSingleSourceRound: null
        };
        let roundSubmissions = submissions([
            { submitter: '02abcdef1234-rest', prices: [{ coinPair: 'BTC/USD', sources: 1 }] }
        ]);

        finalizeRoundMethods.noteSourceDiversity.call(context, 42, roundSubmissions);

        expect(warn.calledOnce).to.equal(true);
        expect(warn.firstCall.args[0]).to.include('pairs: BTC/USD (by 02abcdef1234)');
        expect(context._singleSourceRounds).to.equal(1);
        expect(context._lastSingleSourceRound).to.equal(42);
    });
});
