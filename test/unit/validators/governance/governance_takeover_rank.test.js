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

const { expect } = require('chai');
const { rankedElectorate, takeoverRank, rankOpensAt } =
    require('../../../../src/validators/governance/takeover_rank.js');

const ELECTORATE = [
    { pubkey: '01', addr: 'validator-a' },
    { pubkey: '02', addr: 'validator-b' },
    { pubkey: '03', addr: 'validator-c' },
    { pubkey: '04', addr: 'validator-d' }
];

describe('governance ranked electorate', function () {
    it('rotates snapshot order around the leader with wrap-around', function () {
        const ranked = rankedElectorate(ELECTORATE, 'validator-c');
        expect(ranked.map(entry => entry.addr)).to.deep.equal([
            'validator-c', 'validator-d', 'validator-a', 'validator-b'
        ]);
    });

    it('returns fresh entries without changing the locked electorate', function () {
        const before = JSON.stringify(ELECTORATE);
        const ranked = rankedElectorate(ELECTORATE, 'validator-a');
        expect(JSON.stringify(ELECTORATE)).to.equal(before);
        expect(ranked).to.deep.equal(ELECTORATE);
        ranked.forEach((entry, index) => expect(entry).to.not.equal(ELECTORATE[index]));
    });

    it('returns null for absent or ambiguous leaders', function () {
        expect(rankedElectorate(ELECTORATE, 'missing')).to.equal(null);
        const duplicated = ELECTORATE.concat({ pubkey: '05', addr: 'validator-a' });
        expect(rankedElectorate(duplicated, 'validator-a')).to.equal(null);
    });

    it('returns null for an invalid electorate or leader address', function () {
        expect(rankedElectorate(null, 'validator-a')).to.equal(null);
        expect(rankedElectorate({}, 'validator-a')).to.equal(null);
        expect(rankedElectorate([], 'validator-a')).to.equal(null);
        expect(rankedElectorate(ELECTORATE, null)).to.equal(null);
        expect(rankedElectorate(ELECTORATE, 3)).to.equal(null);
    });
});

describe('governance takeover rank lookup', function () {
    it('returns the address index in the ranked electorate', function () {
        const ranked = rankedElectorate(ELECTORATE, 'validator-c');
        expect(takeoverRank(ranked, 'validator-c')).to.equal(0);
        expect(takeoverRank(ranked, 'validator-b')).to.equal(3);
    });

    it('returns -1 for an absent address or a non-array rank list', function () {
        expect(takeoverRank(ELECTORATE, 'missing')).to.equal(-1);
        expect(takeoverRank(null, 'validator-a')).to.equal(-1);
        expect(takeoverRank({}, 'validator-a')).to.equal(-1);
    });
});

describe('governance takeover window', function () {
    const votingEndMs = Date.UTC(2026, 9, 1);

    it('computes takeover windows from Date, number, and string times', function () {
        expect(rankOpensAt(new Date(votingEndMs), 2, 60_000)).to.equal(votingEndMs + 120_000);
        expect(rankOpensAt(votingEndMs, 0, 60_000)).to.equal(votingEndMs);
        expect(rankOpensAt('2026-10-01T00:00:00Z', 1, 1_000)).to.equal(votingEndMs + 1_000);
    });

    it('returns null for missing or invalid voting end times', function () {
        expect(rankOpensAt(null, 1, 1_000)).to.equal(null);
        expect(rankOpensAt(undefined, 1, 1_000)).to.equal(null);
        expect(rankOpensAt('not-a-date', 1, 1_000)).to.equal(null);
        expect(rankOpensAt(new Date(NaN), 1, 1_000)).to.equal(null);
        expect(rankOpensAt({}, 1, 1_000)).to.equal(null);
    });

    it('returns null for invalid ranks', function () {
        expect(rankOpensAt(votingEndMs, -1, 1_000)).to.equal(null);
        expect(rankOpensAt(votingEndMs, 1.5, 1_000)).to.equal(null);
        expect(rankOpensAt(votingEndMs, '1', 1_000)).to.equal(null);
    });

    it('returns null for invalid takeover steps', function () {
        expect(rankOpensAt(votingEndMs, 1, 0)).to.equal(null);
        expect(rankOpensAt(votingEndMs, 1, -1)).to.equal(null);
        expect(rankOpensAt(votingEndMs, 1, 1.5)).to.equal(null);
        expect(rankOpensAt(votingEndMs, 1, '1000')).to.equal(null);
    });
});
