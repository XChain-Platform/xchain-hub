/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - governance result request and catch-up paths.
 *
 ********************************************************************/

const { GOV_RESULT, GOV_SNAPSHOT_MAX_VALIDATORS } = require('./rules.js');
const { catchUpResult, resultRequestDue } = require('./result_catch_up.js');

const GOV_RESULT_REQ = 'GOV_RESULT_REQ';

const resultRequestMixin = {

    async requestMissingResults() {
        let proposals;
        try {
            proposals = await this.db.findGovernanceProposalsByStatusAndVotingEnd();
        } catch (_) {
            return;
        }

        let now = Date.now();
        let active = new Set();
        for (let proposal of proposals) {
            if (!proposal || typeof proposal.proposal_id !== 'string' || proposal.proposal_id === '') continue;
            active.add(proposal.proposal_id);
        }
        for (let proposalId of this._resultRequests.keys()) {
            if (!active.has(proposalId)) this._resultRequests.delete(proposalId);
        }

        for (let proposal of proposals) {
            if (!resultRequestDue(proposal, now, this.tallyInterval)) continue;
            let last = this._resultRequests.get(proposal.proposal_id);
            if (last !== undefined && now - last < this.tallyInterval) continue;
            let sent = this.peerManager.broadcast(GOV_RESULT_REQ, { proposalId: proposal.proposal_id });
            if (sent) this._resultRequests.set(proposal.proposal_id, now);
        }
    },

    async handleResultRequest(envelope) {
        let proposalId = envelope && envelope.data && envelope.data.proposalId;
        if (typeof proposalId !== 'string' || proposalId === '') return;
        if (!this.isKnownSender(envelope.sender)) return;

        let proposals;
        try {
            proposals = await this.db.findGovernanceProposalsByProposalId(proposalId);
        } catch (_) {
            return;
        }
        if (!proposals.length) return;

        let proposal = proposals[0];
        let electorate = this.parseSnapshot(proposal.validator_snapshot);
        if (!electorate || (proposal.status !== 'passed' && proposal.status !== 'failed')) return;

        let votes;
        try {
            votes = await this.db.findGovernanceVotesWithSignature(proposalId);
        } catch (_) {
            return;
        }
        let tally = this.computeTally(votes, electorate);
        let localStatus = tally.approved ? 'passed' : 'failed';
        if (localStatus !== proposal.status) return;

        let result = catchUpResult(proposal, electorate, votes, tally);
        if (!result) return;
        if (!this.peerManager.sendToPeer(envelope.sender, GOV_RESULT, result)) {
            this.peerManager.broadcast(GOV_RESULT, result);
        }
    },

    async handleCatchUpResult(envelope) {
        let data = envelope && envelope.data;
        if (!data || data.catchUp !== true) return;
        let { proposalId, status } = data;
        if (typeof proposalId !== 'string' || proposalId === '') return;
        if (status !== 'passed' && status !== 'failed') return;
        if (!this._resultRequests.has(proposalId)) return;
        if (!this.isKnownSender(envelope.sender)) return;
        if (!Array.isArray(data.votes) || data.votes.length > GOV_SNAPSHOT_MAX_VALIDATORS) return;

        let rows;
        try {
            rows = await this.db.getGovernanceProposalElectorate(proposalId);
        } catch (_) {
            return;
        }
        if (!rows.length) return;
        let votingEnd;
        try {
            votingEnd = new Date(rows[0].voting_end).getTime();
        } catch (_) {
            return;
        }
        if (!Number.isFinite(votingEnd) || votingEnd > Date.now()) return;

        let electorate = this.parseSnapshot(rows[0].validator_snapshot);
        if (!electorate) return;
        await this.ingestResultVotes(proposalId, data.votes, electorate);

        let votes;
        try {
            votes = await this.db.findGovernanceVotes(proposalId);
        } catch (_) {
            return;
        }
        let tally = this.computeTally(votes, electorate);
        let localStatus = tally.approved ? 'passed' : 'failed';
        if (localStatus !== status ||
            tally.approvals !== data.approvals ||
            tally.rejections !== data.rejections ||
            tally.totalVotes !== data.totalVotes ||
            tally.validatorCount !== data.validatorCount) return;

        let res;
        try {
            res = await this.db.updateGovernanceProposal(localStatus, proposalId);
        } catch (_) {
            return;
        }
        this._resultRequests.delete(proposalId);
        if (localStatus === 'passed' && res && res.affectedRows > 0) await this.emitFinalized(proposalId);
    }

};

Object.defineProperty(resultRequestMixin, 'GOV_RESULT_REQ', { value: GOV_RESULT_REQ });

module.exports = resultRequestMixin;
