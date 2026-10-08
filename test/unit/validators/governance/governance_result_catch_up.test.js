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
const {
    voteEvidence, catchUpResult, resultRequestDue
} = require('../../../../src/validators/governance/result_catch_up.js');

const ELECTORATE = [{ pubkey: 'aa' }, { pubkey: 'bb' }];
const VOTES = [
    { voter_pubkey: 'aa', vote: 'approve', signature: 'sig-a', vote_seq: '3' },
    { voter_pubkey: 'bb', vote: 'reject', signature: 'sig-b', vote_seq: -1 }
];
const TALLY = {
    approvals: 1,
    rejections: 1,
    totalVotes: 2,
    validatorCount: 2,
    approved: true
};

describe('governance result catch-up vote evidence', function () {
    it('maps database rows in order without mutating or reusing them', function () {
        let before = JSON.stringify(VOTES);
        let evidence = voteEvidence(VOTES);

        expect(evidence).to.deep.equal([
            { voterPubkey: 'aa', vote: 'approve', signature: 'sig-a', seq: 3 },
            { voterPubkey: 'bb', vote: 'reject', signature: 'sig-b', seq: 0 }
        ]);
        expect(JSON.stringify(VOTES)).to.equal(before);
        expect(evidence[0]).to.not.equal(VOTES[0]);
        expect(evidence[1]).to.not.equal(VOTES[1]);
    });

    it('returns an empty list for a non-array', function () {
        expect(voteEvidence(null)).to.deep.equal([]);
        expect(voteEvidence({})).to.deep.equal([]);
    });
});

describe('governance catch-up result construction', function () {
    it('builds passed and failed results from the local status and tally counts', function () {
        for (let status of ['passed', 'failed']) {
            let proposal = { proposal_id: 'proposal-1', status };
            expect(catchUpResult(proposal, ELECTORATE, VOTES, TALLY)).to.deep.equal({
                proposalId: 'proposal-1',
                status,
                approvals: 1,
                rejections: 1,
                totalVotes: 2,
                validatorCount: 2,
                votes: [
                    { voterPubkey: 'aa', vote: 'approve', signature: 'sig-a', seq: 3 },
                    { voterPubkey: 'bb', vote: 'reject', signature: 'sig-b', seq: 0 }
                ],
                catchUp: true
            });
        }
    });

    it('requires an identified finalized proposal', function () {
        expect(catchUpResult(null, ELECTORATE, VOTES, TALLY)).to.equal(null);
        expect(catchUpResult({}, ELECTORATE, VOTES, TALLY)).to.equal(null);
        expect(catchUpResult({ proposal_id: '', status: 'failed' }, ELECTORATE, VOTES, TALLY)).to.equal(null);
        expect(catchUpResult({ proposal_id: 1, status: 'failed' }, ELECTORATE, VOTES, TALLY)).to.equal(null);
        expect(catchUpResult({ proposal_id: 'proposal-1', status: 'voting' }, ELECTORATE, VOTES, TALLY)).to.equal(null);
    });

    it('requires a locked electorate, vote rows, and tally', function () {
        let proposal = { proposal_id: 'proposal-1', status: 'failed' };
        expect(catchUpResult(proposal, null, VOTES, TALLY)).to.equal(null);
        expect(catchUpResult(proposal, [], VOTES, TALLY)).to.equal(null);
        expect(catchUpResult(proposal, ELECTORATE, null, TALLY)).to.equal(null);
        expect(catchUpResult(proposal, ELECTORATE, VOTES, null)).to.equal(null);
        expect(catchUpResult(proposal, ELECTORATE, VOTES, [])).to.equal(null);
    });
});

describe('governance result request timing', function () {
    const END_MS = Date.UTC(2026, 9, 1);
    const STEP_MS = 60_000;

    function expectWindow(votingEnd) {
        let proposal = { status: 'voting', voting_end: votingEnd };
        expect(resultRequestDue(proposal, END_MS + STEP_MS - 1, STEP_MS)).to.equal(false);
        expect(resultRequestDue(proposal, END_MS + STEP_MS, STEP_MS)).to.equal(true);
        expect(resultRequestDue(proposal, END_MS + STEP_MS + 1, STEP_MS)).to.equal(true);
    }

    it('handles Date voting ends before, at, and past the request window', function () {
        expectWindow(new Date(END_MS));
    });

    it('handles millisecond voting ends before, at, and past the request window', function () {
        expectWindow(END_MS);
    });

    it('handles string voting ends before, at, and past the request window', function () {
        expectWindow('2026-10-01T00:00:00.000Z');
    });

    it('rejects invalid proposals and voting ends', function () {
        expect(resultRequestDue(null, END_MS + STEP_MS, STEP_MS)).to.equal(false);
        expect(resultRequestDue({ status: 'passed', voting_end: END_MS }, END_MS + STEP_MS, STEP_MS)).to.equal(false);
        expect(resultRequestDue({ status: 'voting', voting_end: null }, END_MS + STEP_MS, STEP_MS)).to.equal(false);
        expect(resultRequestDue({ status: 'voting' }, END_MS + STEP_MS, STEP_MS)).to.equal(false);
        expect(resultRequestDue({ status: 'voting', voting_end: 'invalid' }, END_MS + STEP_MS, STEP_MS)).to.equal(false);
        expect(resultRequestDue({ status: 'voting', voting_end: Symbol('end') }, END_MS + STEP_MS, STEP_MS)).to.equal(false);
    });

    it('requires a finite current time and a positive integer step', function () {
        let proposal = { status: 'voting', voting_end: END_MS };
        expect(resultRequestDue(proposal, NaN, STEP_MS)).to.equal(false);
        expect(resultRequestDue(proposal, Infinity, STEP_MS)).to.equal(false);
        expect(resultRequestDue(proposal, END_MS + STEP_MS, 0)).to.equal(false);
        expect(resultRequestDue(proposal, END_MS + STEP_MS, -1)).to.equal(false);
        expect(resultRequestDue(proposal, END_MS + STEP_MS, 1.5)).to.equal(false);
    });
});
