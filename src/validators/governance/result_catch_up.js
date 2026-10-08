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
 * XChain Hub - pure governance result catch-up helpers.
 *
 ********************************************************************/

const { normalizeVoteSeq } = require('./rules.js');

function voteEvidence(votes) {
    if (!Array.isArray(votes)) return [];
    return votes.map(vote => ({
        voterPubkey: vote.voter_pubkey,
        vote: vote.vote,
        signature: vote.signature,
        seq: normalizeVoteSeq(Number(vote.vote_seq))
    }));
}

function catchUpResult(proposal, electorate, votes, tally) {
    if (!proposal || typeof proposal !== 'object') return null;
    if (typeof proposal.proposal_id !== 'string' || proposal.proposal_id === '') return null;
    if (proposal.status !== 'passed' && proposal.status !== 'failed') return null;
    if (!Array.isArray(electorate) || electorate.length === 0) return null;
    if (!Array.isArray(votes)) return null;
    if (!tally || typeof tally !== 'object' || Array.isArray(tally)) return null;

    return {
        proposalId: proposal.proposal_id,
        status: proposal.status,
        approvals: tally.approvals,
        rejections: tally.rejections,
        totalVotes: tally.totalVotes,
        validatorCount: tally.validatorCount,
        votes: voteEvidence(votes),
        catchUp: true
    };
}

function resultRequestDue(proposal, now, stepMs) {
    if (!proposal || typeof proposal !== 'object' || proposal.status !== 'voting') return false;
    if (proposal.voting_end === null || proposal.voting_end === undefined) return false;
    if (typeof now !== 'number' || !Number.isFinite(now)) return false;
    if (!Number.isInteger(stepMs) || stepMs <= 0) return false;

    let votingEnd;
    try {
        votingEnd = new Date(proposal.voting_end).getTime();
    } catch (_) {
        return false;
    }
    return Number.isFinite(votingEnd) && now >= votingEnd + stepMs;
}

module.exports = { voteEvidence, catchUpResult, resultRequestDue };
