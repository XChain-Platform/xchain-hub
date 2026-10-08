'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const overdueMixin = require('../../../../src/validators/governance/overdue.js');
const { getLogger } = require('../../../../src/observability');

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-08T12:00:00Z');

class StubGovernance {
    constructor(db) {
        this.db = db;
    }
}

Object.assign(StubGovernance.prototype, overdueMixin);

function subjectWith(proposals) {
    let query = sinon.stub().resolves(proposals);
    return new StubGovernance({ findGovernanceProposalsByStatusAndVotingEnd: query });
}

function installHooks(state) {
    beforeEach(function () {
        state.originalOverdueMs = process.env.GOVERNANCE_OVERDUE_MS;
        delete process.env.GOVERNANCE_OVERDUE_MS;
        sinon.stub(Date, 'now').returns(NOW);
        state.loggerError = sinon.stub(getLogger(), 'error');
    });

    afterEach(function () {
        sinon.restore();
        if (state.originalOverdueMs === undefined) delete process.env.GOVERNANCE_OVERDUE_MS;
        else process.env.GOVERNANCE_OVERDUE_MS = state.originalOverdueMs;
    });
}

describe('governance overdue proposal counting', function () {
    let state = {};
    installHooks(state);

    it('returns zero without logging when no proposal is overdue', async function () {
        let subject = subjectWith([]);

        expect(await subject.countOverdueProposals()).to.equal(0);
        expect(subject.overdueProposalCount).to.equal(0);
        expect(state.loggerError.called).to.equal(false);
        expect(subject.db.findGovernanceProposalsByStatusAndVotingEnd.calledOnceWithExactly())
            .to.equal(true);
    });

    it('counts and reports only rows older than the default threshold', async function () {
        let subject = subjectWith([
            { proposal_id: 'old', voting_end: new Date(NOW - 2 * HOUR_MS - 1).toISOString() },
            { proposal_id: 'threshold', voting_end: new Date(NOW - 2 * HOUR_MS) },
            { proposal_id: 'recent', voting_end: new Date(NOW - HOUR_MS) }
        ]);

        expect(await subject.countOverdueProposals(NOW)).to.equal(1);
        expect(subject.overdueProposalCount).to.equal(1);
        expect(state.loggerError.calledOnce).to.equal(true);
        expect(state.loggerError.firstCall.args[0]).to.include('old');
    });
});

describe('governance overdue proposal reporting', function () {
    let state = {};
    installHooks(state);

    it('tracks each overdue id on its own hourly schedule', async function () {
        let proposals = [{ proposal_id: 'stuck-a', voting_end: new Date(NOW - 3 * HOUR_MS) }];
        let subject = subjectWith(proposals);

        expect(await subject.countOverdueProposals(NOW)).to.equal(1);
        expect(await subject.countOverdueProposals(NOW)).to.equal(1);
        expect(state.loggerError.calledOnce).to.equal(true);
        proposals.push({ proposal_id: 'stuck-b', voting_end: new Date(NOW - 3 * HOUR_MS) });
        expect(await subject.countOverdueProposals(NOW + HOUR_MS / 2)).to.equal(2);
        expect(state.loggerError.callCount).to.equal(2);
        expect(await subject.countOverdueProposals(NOW + HOUR_MS + 1)).to.equal(2);
        expect(state.loggerError.callCount).to.equal(3);
        expect(await subject.countOverdueProposals(NOW + HOUR_MS * 1.5 + 1)).to.equal(2);
        expect(state.loggerError.callCount).to.equal(4);
    });

    it('drops ids that are no longer overdue', async function () {
        let row = { proposal_id: 'recovered', voting_end: new Date(NOW - 3 * HOUR_MS) };
        let subject = subjectWith([row]);
        let query = subject.db.findGovernanceProposalsByStatusAndVotingEnd;

        expect(await subject.countOverdueProposals(NOW)).to.equal(1);
        query.resolves([]);
        expect(await subject.countOverdueProposals(NOW)).to.equal(0);
        query.resolves([row]);
        expect(await subject.countOverdueProposals(NOW)).to.equal(1);
        expect(state.loggerError.callCount).to.equal(2);
    });
});

describe('governance overdue failures and configuration', function () {
    let state = {};
    installHooks(state);

    it('keeps the previous count when the query rejects', async function () {
        let subject = subjectWith([
            { proposal_id: 'stuck', voting_end: new Date(NOW - 3 * HOUR_MS) }
        ]);

        expect(await subject.countOverdueProposals(NOW)).to.equal(1);
        state.loggerError.resetHistory();
        subject.db.findGovernanceProposalsByStatusAndVotingEnd.rejects(new Error('db unavailable'));
        expect(await subject.countOverdueProposals(NOW)).to.equal(1);
        expect(subject.overdueProposalCount).to.equal(1);
        expect(state.loggerError.calledOnce).to.equal(true);
        expect(state.loggerError.firstCall.args[0]).to.include('db unavailable');
    });

    it('uses GOVERNANCE_OVERDUE_MS when it is configured', async function () {
        process.env.GOVERNANCE_OVERDUE_MS = '1000ms';
        let subject = subjectWith([
            { proposal_id: 'configured', voting_end: new Date(NOW - 1001) },
            { proposal_id: 'too-recent', voting_end: new Date(NOW - 999) }
        ]);

        expect(await subject.countOverdueProposals(NOW)).to.equal(1);
        expect(state.loggerError.calledOnce).to.equal(true);
        expect(state.loggerError.firstCall.args[0]).to.include('configured');
    });
});
