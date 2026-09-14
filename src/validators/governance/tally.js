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
 * XChain Hub - the TALLY, as a Governance.prototype mixin.
 *
 * The deterministic leader for a proposal, the expiry sweep that finds proposals
 * whose voting window closed, and the tally itself. Only the leader tallies and
 * broadcasts GOV_RESULT: two hubs tallying independently off differently-delivered
 * gossip would reach contradictory outcomes, which is the split-brain the leader
 * pin removes.
 *
 ********************************************************************/

const crypto = require('crypto');
const nodeUtil = require('node:util');
const { GOV_RESULT, normalizeVoteSeq } = require('./rules.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Deterministic leader for a proposal. Mirrors OracleConsensus._getLeader
    // (modular index into the validator set) but, since governance has no
    // sequential round counter, derives the round from a hash of the immutable
    // proposal_id. Every hub computes the same leader for a given proposal.
    getProposalLeader(proposalId) {
        if (this.validatorSet.length === 0) return null;
        let round = crypto.createHash('sha256').update(proposalId).digest().readUInt32BE(0);
        return this.validatorSet[round % this.validatorSet.length];
    },

    // True if this hub is the deterministic leader responsible for tallying the
    // given proposal. A hub with no validator set (standalone / dev) falls back
    // to tallying locally so single-node operation is unaffected.
    isTallyLeader(proposalId) {
        if (this.validatorSet.length === 0) return true;
        let leader = this.getProposalLeader(proposalId);
        return !!leader && leader.addr === this.peerManager.validatorAddr;
    },

    // Check for proposals whose voting period has ended and tally them
    async checkExpiredProposals() {
        let expired;
        try {
            expired = await this.db.findGovernanceProposalsByStatusAndVotingEnd();
        } catch (e) {
            // Tally check runs on a timer, so don't crash -- but log the error.
            // A systematic failure here (schema drift, column mismatch) would
            // otherwise freeze every proposal in 'voting' state with no signal.
            logger.error(nodeUtil.format('Governance tally error:', e.message, e));
            return;
        }

        for (let proposal of expired) {
            // Only the deterministic leader for this proposal tallies and
            // broadcasts the result; followers accept the GOV_RESULT broadcast
            // as authoritative. This prevents two hubs from independently
            // tallying with different gossip-delivered vote counts and reaching
            // contradictory passed/failed conclusions (split-brain).
            if (!this.isTallyLeader(proposal.proposal_id)) continue;
            try {
                await this.tallyProposal(proposal);
            } catch (e) {
                logger.error(nodeUtil.format('Governance: tally failed for proposal ' + proposal.proposal_id + ':', e));
            }
        }
    },

    async tallyProposal(proposal) {
        // R2-M2: include the signature so followers can re-verify each vote when
        // they re-tally locally (R2-H2), not accept the leader's status blind.
        // vote_seq travels with the evidence: a follower re-verifying these
        // signatures must rebuild the exact signed bytes, which now include seq.
        let votes = await this.db.findGovernanceVotesWithSignature(proposal.proposal_id);

        // R2-M2: tally against the proposal's LOCKED electorate (snapshot), not the
        // live mutable validatorSet, so a set churn mid-vote cannot move the
        // denominator. Legacy (NULL-snapshot) rows fall back to the live set.
        let electorate = this.parseSnapshot(proposal.validator_snapshot);
        let tally = this.computeTally(votes, electorate);
        let { approvals, rejections, totalVotes, validatorCount, approved } = tally;

        let newStatus = approved ? 'passed' : 'failed';

        // Gate the broadcast + emit on the status transition actually landing on THIS
        // row. setInterval(checkExpiredProposals) does not await its async pass, so a
        // slow DB lets the next tick re-select the still-'voting' proposal and re-tally
        // it; the status='voting' WHERE clause makes only one UPDATE affect a row, but
        // without this affectedRows check both passes would broadcast GOV_RESULT and
        // emit proposal:finalized, double-applying on the leader. Mirrors _handleResult.
        let res = await this.db.updateGovernanceProposal(newStatus, proposal.proposal_id);
        if (!res || !res.affectedRows) return;

        this.peerManager.broadcast(GOV_RESULT, {
            proposalId: proposal.proposal_id,
            status: newStatus,
            approvals, rejections, totalVotes, validatorCount,
            // R2-H2: carry the authenticated vote evidence so a follower that
            // missed some GOV_VOTE gossip can reproduce this exact tally locally
            // and NEVER apply the wire status on faith. Each entry re-verifies on
            // the receive side (membership in the locked snapshot + ed25519 sig).
            // Bounded by the snapshot cap. Old hubs ignore the extra field.
            votes: votes.map(v => ({
                voterPubkey: v.voter_pubkey, vote: v.vote, signature: v.signature,
                seq: normalizeVoteSeq(Number(v.vote_seq))
            }))
        });

        logger.info('Governance: Proposal ' + proposal.proposal_id + ': ' + newStatus +
            ' (' + approvals + '/' + totalVotes + ' approve, ' + validatorCount + ' validators)');

        if (approved) {
            this.emit('proposal:finalized', {
                proposalId: proposal.proposal_id,
                parameter:  proposal.parameter,
                oldValue:   proposal.current_value,
                newValue:   proposal.proposed_value,
                activationBlock: proposal.activation_block
            });
        }
    }

};
