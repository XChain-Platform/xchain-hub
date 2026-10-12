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

// Verify ranked takeover entitlement across failover windows.

const { expect } = require('chai');
const { rankedElectorate, resultSenderEntitled } =
    require('../../../../src/validators/governance/takeover_rank.js');

const ELECTORATE = [
    { pubkey: '01', addr: 'validator-a' },
    { pubkey: '02', addr: 'validator-b' },
    { pubkey: '03', addr: 'validator-c' },
    { pubkey: '04', addr: 'validator-d' }
];

describe('governance takeover entitlement', function () {
    const votingEnd = Date.UTC(2026, 9, 1);
    const stepMs = 60_000;
    const ranked = rankedElectorate(ELECTORATE, 'validator-c');

    it('entitles the leader before windows open regardless of the failover gate', function () {
        const beforeVotingEnd = votingEnd - stepMs;
        expect(resultSenderEntitled(ranked, 'validator-c', votingEnd, beforeVotingEnd, stepMs, false))
            .to.equal(true);
        expect(resultSenderEntitled(ranked, 'validator-c', votingEnd, beforeVotingEnd, stepMs, true))
            .to.equal(true);
    });

    it('refuses rank one while failover is inactive at any time', function () {
        const afterWindow = votingEnd + stepMs * 10;
        expect(resultSenderEntitled(ranked, 'validator-d', votingEnd, afterWindow, stepMs, false))
            .to.equal(false);
    });

    it('opens rank one at its exact window with number and Date times', function () {
        expect(resultSenderEntitled(ranked, 'validator-d', votingEnd, votingEnd + stepMs - 1, stepMs, true))
            .to.equal(false);
        expect(resultSenderEntitled(ranked, 'validator-d', votingEnd, votingEnd + stepMs, stepMs, true))
            .to.equal(true);
        expect(resultSenderEntitled(
            ranked, 'validator-d', votingEnd, new Date(votingEnd + stepMs + 1), stepMs, true
        )).to.equal(true);
    });

    it('opens rank two only at its own window', function () {
        expect(resultSenderEntitled(ranked, 'validator-a', votingEnd, votingEnd + stepMs, stepMs, true))
            .to.equal(false);
        expect(resultSenderEntitled(ranked, 'validator-a', votingEnd, votingEnd + stepMs * 2, stepMs, true))
            .to.equal(true);
    });

    it('refuses absent senders and invalid inputs', function () {
        expect(resultSenderEntitled(ranked, 'missing', votingEnd, votingEnd, stepMs, true)).to.equal(false);
        expect(resultSenderEntitled(null, 'validator-c', votingEnd, votingEnd, stepMs, true)).to.equal(false);
        expect(resultSenderEntitled(ranked, 'validator-d', null, votingEnd, stepMs, true)).to.equal(false);
        expect(resultSenderEntitled(ranked, 'validator-c', votingEnd, NaN, stepMs, true)).to.equal(false);
    });
});
