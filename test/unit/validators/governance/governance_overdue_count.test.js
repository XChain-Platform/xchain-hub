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
const sinon = require('sinon');
const overdueMixin = require('../../../../src/validators/governance/overdue.js');
const logger = require('../../../../src/observability').getLogger();

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const OVERDUE_MS = 2 * HOUR;
const NOW = Date.UTC(2026, 9, 8, 12);

function proposal(id, votingEnd) {
    return { proposal_id: id, voting_end: new Date(votingEnd) };
}

function makeCounter(rows = [], overdueMs) {
    let counter = {
        db: { findGovernanceProposalsByStatusAndVotingEnd: sinon.stub().resolves(rows) }
    };
    if (overdueMs !== undefined) counter.overdueMs = overdueMs;
    return Object.assign(counter, overdueMixin);
}

describe('governance overdue counter mixin', function () {
    let error;
    let originalOverdueMs;

    beforeEach(function () {
        originalOverdueMs = process.env.GOVERNANCE_OVERDUE_MS;
        delete process.env.GOVERNANCE_OVERDUE_MS;
        error = sinon.stub(logger, 'error');
    });

    afterEach(function () {
        sinon.restore();
        if (originalOverdueMs === undefined) delete process.env.GOVERNANCE_OVERDUE_MS;
        else process.env.GOVERNANCE_OVERDUE_MS = originalOverdueMs;
    });

    it('returns zero without logging when no proposal is overdue', async function () {
        let counter = makeCounter([]);
        expect(await counter.countOverdueProposals(NOW)).to.equal(0);
        expect(error.called).to.equal(false);
        expect(counter.db.findGovernanceProposalsByStatusAndVotingEnd.calledOnceWithExactly())
            .to.equal(true);
    });

    it('counts rows at or beyond the default threshold', async function () {
        let counter = makeCounter([
            proposal('old', NOW - OVERDUE_MS - 1),
            proposal('threshold', NOW - OVERDUE_MS),
            proposal('recent', NOW - OVERDUE_MS + 1)
        ]);

        expect(await counter.countOverdueProposals(NOW)).to.equal(2);
        expect(counter._overdueCount).to.equal(2);
        expect(error.callCount).to.equal(2);
    });

    it('logs a newly overdue proposal and throttles repeat lines for one hour', async function () {
        let counter = makeCounter([proposal('proposal-1', NOW - OVERDUE_MS - MINUTE)]);

        expect(await counter.countOverdueProposals(NOW)).to.equal(1);
        expect(error.calledOnceWithMatch('proposal-1')).to.equal(true);
        error.resetHistory();
        expect(await counter.countOverdueProposals(NOW)).to.equal(1);
        expect(error.called).to.equal(false);
        expect(await counter.countOverdueProposals(NOW + 61 * MINUTE)).to.equal(1);
        expect(error.calledOnceWithMatch('proposal-1')).to.equal(true);
    });

    it('tracks each overdue id on its own hourly schedule', async function () {
        let rows = [proposal('proposal-a', NOW - 3 * HOUR)];
        let counter = makeCounter(rows);

        expect(await counter.countOverdueProposals(NOW)).to.equal(1);
        rows.push(proposal('proposal-b', NOW - 3 * HOUR));
        expect(await counter.countOverdueProposals(NOW + 30 * MINUTE)).to.equal(2);
        expect(error.callCount).to.equal(2);
        expect(await counter.countOverdueProposals(NOW + 61 * MINUTE)).to.equal(2);
        expect(error.callCount).to.equal(3);
        expect(await counter.countOverdueProposals(NOW + 91 * MINUTE)).to.equal(2);
        expect(error.callCount).to.equal(4);
    });

    it('removes proposal ids from the log throttle after they stop being overdue', async function () {
        let row = proposal('proposal-2', NOW - OVERDUE_MS - MINUTE);
        let counter = makeCounter([row]);
        await counter.countOverdueProposals(NOW);
        counter.db.findGovernanceProposalsByStatusAndVotingEnd.resolves([]);

        expect(await counter.countOverdueProposals(NOW)).to.equal(0);
        expect(counter._overdueLogged.has('proposal-2')).to.equal(false);
        counter.db.findGovernanceProposalsByStatusAndVotingEnd.resolves([row]);
        expect(await counter.countOverdueProposals(NOW)).to.equal(1);
        expect(error.callCount).to.equal(2);
    });

    it('uses GOVERNANCE_OVERDUE_MS when configured', async function () {
        process.env.GOVERNANCE_OVERDUE_MS = '1000ms';
        let counter = makeCounter([
            proposal('configured', NOW - 1000),
            proposal('too-recent', NOW - 999)
        ]);

        expect(await counter.countOverdueProposals(NOW)).to.equal(1);
        expect(error.calledOnceWithMatch('configured')).to.equal(true);
    });

    it('prefers a positive integer instance threshold', async function () {
        process.env.GOVERNANCE_OVERDUE_MS = '1000';
        let counter = makeCounter([proposal('instance', NOW - MINUTE)], 2 * MINUTE);
        expect(await counter.countOverdueProposals(NOW)).to.equal(0);
    });

    it('uses the default threshold when thresholds are invalid', async function () {
        process.env.GOVERNANCE_OVERDUE_MS = 'invalid';
        let counter = makeCounter([proposal('proposal-3', NOW - OVERDUE_MS - MINUTE)], 0);
        expect(await counter.countOverdueProposals(NOW)).to.equal(1);
    });

    it('logs a rejected query and returns the previous count', async function () {
        let counter = makeCounter([proposal('proposal-4', NOW - OVERDUE_MS - MINUTE)]);
        expect(await counter.countOverdueProposals(NOW)).to.equal(1);
        error.resetHistory();
        counter.db.findGovernanceProposalsByStatusAndVotingEnd.rejects(new Error('database unavailable'));

        expect(await counter.countOverdueProposals(NOW)).to.equal(1);
        expect(error.calledOnceWithMatch('database unavailable')).to.equal(true);
    });
});
