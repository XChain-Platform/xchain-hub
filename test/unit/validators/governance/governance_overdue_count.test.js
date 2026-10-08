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

function makeCounter(rows = [], overdueMs = OVERDUE_MS) {
    return Object.assign({
        db: { findGovernanceProposalsByStatusAndVotingEnd: sinon.stub().resolves(rows) },
        overdueMs
    }, overdueMixin);
}

describe('governance overdue counter mixin', function () {
    let error;

    beforeEach(function () {
        error = sinon.stub(logger, 'error');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('returns zero without logging when no proposal is overdue', async function () {
        let counter = makeCounter([]);
        expect(await counter.countOverdueProposals(NOW)).to.equal(0);
        expect(error.called).to.equal(false);
    });

    it('logs a newly overdue proposal and throttles repeat lines for one hour', async function () {
        let row = proposal('proposal-1', NOW - OVERDUE_MS - MINUTE);
        let counter = makeCounter([row]);

        expect(await counter.countOverdueProposals(NOW)).to.equal(1);
        expect(error.calledOnceWithMatch('proposal-1')).to.equal(true);
        error.resetHistory();
        expect(await counter.countOverdueProposals(NOW)).to.equal(1);
        expect(error.called).to.equal(false);
        expect(await counter.countOverdueProposals(NOW + 61 * MINUTE)).to.equal(1);
        expect(error.calledOnceWithMatch('proposal-1')).to.equal(true);
    });

    it('removes proposal ids from the log throttle after they stop being overdue', async function () {
        let row = proposal('proposal-2', NOW - OVERDUE_MS - MINUTE);
        let counter = makeCounter([row]);
        await counter.countOverdueProposals(NOW);
        counter.db.findGovernanceProposalsByStatusAndVotingEnd.resolves([]);

        expect(await counter.countOverdueProposals(NOW)).to.equal(0);
        expect(counter._overdueLogged.has('proposal-2')).to.equal(false);
    });

    it('uses the default threshold when overdueMs is not a positive integer', async function () {
        let row = proposal('proposal-3', NOW - OVERDUE_MS - MINUTE);
        let counter = makeCounter([row], 0);
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
