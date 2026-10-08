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

const sinon = require('sinon');
const { expect } = require('chai');
const Governance = require('../../../../src/validators/governance');
const { createMockHub } = require('../../../helpers/mockHub');
const { VALIDATORS_3 } = require('../../../helpers/fixtures');

const PROPOSAL_ID = 'gov:P:1';
const PAST = '2020-01-01T00:00:00.000Z';

let hub, pm, gov, snapshot;

function finalProposal(status) {
    return {
        proposal_id: PROPOSAL_ID,
        status,
        voting_end: PAST,
        validator_snapshot: JSON.stringify(snapshot)
    };
}

function voteRows() {
    return [
        { voter_pubkey: snapshot[0].pubkey, vote: 'approve', signature: 'sig-a', vote_seq: 11 },
        { voter_pubkey: snapshot[1].pubkey, vote: 'approve', signature: 'sig-b', vote_seq: 12 },
        { voter_pubkey: snapshot[2].pubkey, vote: 'reject', signature: 'sig-c', vote_seq: 13 }
    ];
}

describe('Governance result request catch-up', function () {
    beforeEach(function () {
        hub = createMockHub();
        pm = hub._peerManager;
        gov = new Governance(hub);
        gov.setValidatorSet(VALIDATORS_3);
        snapshot = gov.buildValidatorSnapshot();
    });

    afterEach(function () {
        if (gov._tallyTimer) clearInterval(gov._tallyTimer);
        sinon.restore();
    });

    it('broadcasts a delayed result request for an expired voting row and throttles repeats', async function () {
        let clock = sinon.useFakeTimers({ now: Date.parse('2026-10-08T00:00:10.000Z') });
        gov.tallyInterval = 1000;
        hub.db.doQuery.resolves([{
            proposal_id: PROPOSAL_ID,
            status: 'voting',
            voting_end: new Date(Date.now() - 2000)
        }]);

        await gov.requestMissingResults();
        await gov.requestMissingResults();
        expect(pm.broadcast.calledOnceWithExactly(Governance.GOV_RESULT_REQ, { proposalId: PROPOSAL_ID })).to.equal(true);

        clock.tick(1000);
        await gov.requestMissingResults();
        expect(pm.broadcast.callCount).to.equal(2);
        clock.restore();
    });

    it('does not request before the grace interval or when the query fails', async function () {
        gov.tallyInterval = 1000;
        hub.db.doQuery.resolves([{
            proposal_id: PROPOSAL_ID,
            status: 'voting',
            voting_end: new Date(Date.now() - 999)
        }]);
        await gov.requestMissingResults();
        expect(pm.broadcast.called).to.equal(false);

        hub.db.doQuery.rejects(new Error('offline'));
        await gov.requestMissingResults();
        expect(pm.broadcast.called).to.equal(false);
    });

    it('answers an authenticated request with the stored final status and vote evidence', async function () {
        hub.db.doQuery.onCall(0).resolves([finalProposal('passed')]);
        hub.db.doQuery.onCall(1).resolves(voteRows());

        await gov.handleResultRequest({ sender: 'peer', data: { proposalId: PROPOSAL_ID } });

        expect(pm.sendToPeer.calledOnce).to.equal(true);
        expect(pm.sendToPeer.getCall(0).args).to.deep.equal([
            'peer', 'GOV_RESULT', {
                proposalId: PROPOSAL_ID,
                status: 'passed',
                approvals: 2,
                rejections: 1,
                totalVotes: 3,
                validatorCount: 3,
                votes: [
                    { voterPubkey: snapshot[0].pubkey, vote: 'approve', signature: 'sig-a', seq: 11 },
                    { voterPubkey: snapshot[1].pubkey, vote: 'approve', signature: 'sig-b', seq: 12 },
                    { voterPubkey: snapshot[2].pubkey, vote: 'reject', signature: 'sig-c', seq: 13 }
                ],
                catchUp: true
            }
        ]);
    });

    it('broadcasts the reply when the requester is not directly addressable', async function () {
        pm.sendToPeer.returns(false);
        hub.db.doQuery.onCall(0).resolves([finalProposal('passed')]);
        hub.db.doQuery.onCall(1).resolves(voteRows());

        await gov.handleResultRequest({ sender: 'peer', data: { proposalId: PROPOSAL_ID } });

        expect(pm.broadcast.calledOnce).to.equal(true);
        expect(pm.broadcast.getCall(0).args[0]).to.equal('GOV_RESULT');
        expect(pm.broadcast.getCall(0).args[1].catchUp).to.equal(true);
    });

    it('does not answer unknown, absent, voting, legacy, or inconsistent proposals', async function () {
        pm.validatorPubkeys = new Map([['known', snapshot[0].pubkey]]);
        await gov.handleResultRequest({ sender: 'unknown', data: { proposalId: PROPOSAL_ID } });
        expect(hub.db.doQuery.called).to.equal(false);

        hub.db.doQuery.onCall(0).resolves([]);
        hub.db.doQuery.onCall(1).resolves([{ ...finalProposal('passed'), status: 'voting' }]);
        hub.db.doQuery.onCall(2).resolves([{ ...finalProposal('passed'), validator_snapshot: null }]);
        hub.db.doQuery.onCall(3).resolves([finalProposal('passed')]);
        hub.db.doQuery.onCall(4).resolves([]);
        await gov.handleResultRequest({ sender: 'known', data: { proposalId: PROPOSAL_ID } });
        await gov.handleResultRequest({ sender: 'known', data: { proposalId: PROPOSAL_ID } });
        await gov.handleResultRequest({ sender: 'known', data: { proposalId: PROPOSAL_ID } });
        await gov.handleResultRequest({ sender: 'known', data: { proposalId: PROPOSAL_ID } });
        expect(pm.sendToPeer.called).to.equal(false);
        expect(pm.broadcast.called).to.equal(false);
    });

    it('applies a requested catch-up result from a known non-leader after local re-tally', async function () {
        let nonLeader = VALIDATORS_3.find(v => v.addr !== gov.getProposalLeader(PROPOSAL_ID).addr).addr;
        pm.validatorPubkeys = new Map([[nonLeader, snapshot[0].pubkey]]);
        gov._resultRequests.set(PROPOSAL_ID, Date.now());
        sinon.stub(gov, 'ingestResultVotes').resolves();
        hub.db.doQuery.onCall(0).resolves([{
            voting_end: PAST,
            validator_snapshot: JSON.stringify(snapshot)
        }]);
        hub.db.doQuery.onCall(1).resolves(voteRows());
        hub.db.doQuery.onCall(2).resolves({ affectedRows: 1 });
        hub.db.doQuery.onCall(3).resolves([{
            parameter: 'P', current_value: '100', proposed_value: '120', activation_block: null
        }]);
        let finalized;
        gov.on('proposal:finalized', data => { finalized = data; });

        await gov.handleCatchUpResult({
            sender: nonLeader,
            data: {
                proposalId: PROPOSAL_ID,
                status: 'passed',
                approvals: 2,
                rejections: 1,
                totalVotes: 3,
                validatorCount: 3,
                votes: [],
                catchUp: true
            }
        });

        expect(hub.db.doQuery.getCall(2).args[1]).to.deep.equal(['passed', PROPOSAL_ID]);
        expect(finalized).to.include({ proposalId: PROPOSAL_ID, parameter: 'P' });
        expect(gov._resultRequests.has(PROPOSAL_ID)).to.equal(false);
    });

    it('rejects unsolicited, unknown, early, and tally-mismatched catch-up results', async function () {
        let data = {
            proposalId: PROPOSAL_ID,
            status: 'passed',
            approvals: 2,
            rejections: 1,
            totalVotes: 3,
            validatorCount: 3,
            votes: [],
            catchUp: true
        };
        await gov.handleCatchUpResult({ sender: 'peer', data });
        expect(hub.db.doQuery.called).to.equal(false);

        gov._resultRequests.set(PROPOSAL_ID, Date.now());
        pm.validatorPubkeys = new Map([['known', snapshot[0].pubkey]]);
        await gov.handleCatchUpResult({ sender: 'unknown', data });
        expect(hub.db.doQuery.called).to.equal(false);

        hub.db.doQuery.onCall(0).resolves([{
            voting_end: '2999-01-01T00:00:00.000Z',
            validator_snapshot: JSON.stringify(snapshot)
        }]);
        await gov.handleCatchUpResult({ sender: 'known', data });

        sinon.stub(gov, 'ingestResultVotes').resolves();
        hub.db.doQuery.onCall(1).resolves([{
            voting_end: PAST,
            validator_snapshot: JSON.stringify(snapshot)
        }]);
        hub.db.doQuery.onCall(2).resolves(voteRows());
        await gov.handleCatchUpResult({
            sender: 'known',
            data: { ...data, approvals: 3 }
        });

        expect(hub.db.doQuery.callCount).to.equal(3);
        expect(gov._resultRequests.has(PROPOSAL_ID)).to.equal(true);
    });
});
