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
const Governance = require('../../../../src/validators/governance.js');
const logger = require('../../../../src/observability').getLogger();

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 8, 12);

function makeGovernance(rows) {
    const peerManager = {
        validatorAddr: 'local-validator',
        on: sinon.stub(),
        removeListener: sinon.stub(),
        broadcast: sinon.stub()
    };
    const mail = sinon.stub();
    const db = {
        findGovernanceProposalsByStatusAndVotingEnd: sinon.stub().resolves(rows)
    };
    const governance = new Governance({
        db,
        mail,
        getPeerManager: () => peerManager,
        getIdentity: () => null
    });
    governance.overdueMs = 2 * HOUR;
    governance.setValidatorSet([]);
    return { governance, db, mail };
}

describe('governance overdue proposal alert', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('logs and counts a proposal still voting well past its window without sending mail', async function () {
        const row = {
            proposal_id: 'gov:STALE:1',
            voting_end: new Date(NOW - 3 * HOUR)
        };
        const { governance, db, mail } = makeGovernance([row]);
        sinon.stub(governance, 'tallyProposal').resolves();
        const error = sinon.stub(logger, 'error');
        const clock = sinon.useFakeTimers({ now: NOW });

        await governance.checkExpiredProposals();

        expect(error.calledOnceWithMatch('gov:STALE:1')).to.equal(true);
        expect(governance._overdueCount).to.equal(1);
        expect(db.findGovernanceProposalsByStatusAndVotingEnd.calledOnceWithExactly()).to.equal(true);
        expect(mail.called).to.equal(false);
        clock.restore();
    });

    it('counts overdue proposals on a follower without attempting their tally', async function () {
        const row = {
            proposal_id: 'gov:FOLLOWER:1',
            voting_end: new Date(NOW - 3 * HOUR)
        };
        const { governance } = makeGovernance([row]);
        sinon.stub(governance, 'isTallyLeader').returns(false);
        const tally = sinon.stub(governance, 'tallyProposal').resolves();
        sinon.stub(logger, 'error');
        const clock = sinon.useFakeTimers({ now: NOW });

        await governance.checkExpiredProposals();

        expect(governance._overdueCount).to.equal(1);
        expect(tally.called).to.equal(false);
        clock.restore();
    });
});
