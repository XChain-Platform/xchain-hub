/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Hub - Governance Engine
 *
 * Off-chain governance via PBFT voting. Validators propose parameter
 * changes, vote over a configurable voting period, and apply changes
 * at the next epoch boundary when 2/3+ approve.
 *
 * Proposal lifecycle: PROPOSE → VOTING (7 days) → TALLY → APPLY/REJECT
 *
 ********************************************************************/

const crypto = require('crypto');
const EventEmitter = require('events');

const GOV_PROPOSE = 'GOV_PROPOSE';
const GOV_VOTE    = 'GOV_VOTE';
const GOV_RESULT  = 'GOV_RESULT';

// Change bounds
const MAX_INCREASE         = 0.50;  // 50% max increase
const MAX_DECREASE         = 0.33;  // 33% max decrease
const MAX_SLASH_INCREASE   = 0.25;  // 25% max increase for slashing params
const MAX_SLASH_DECREASE   = 0.20;  // 20% max decrease for slashing params
const COOLDOWN_DAYS        = 14;    // Days before re-proposing a rejected parameter

const SLASHING_PARAMS = ['SLASH_DEVIATION_THRESHOLD', 'SLASH_MISSED_ROUNDS_THRESHOLD'];

class Governance extends EventEmitter {

    constructor(hub) {
        super();
        this.hub         = hub;
        this.peerManager = hub.getPeerManager();
        this.identity    = hub.getIdentity();
        this.db          = hub.db;

        // Validator set
        this.validatorSet = [];

        // Message handler
        this._messageHandler = null;

        // Tally check timer
        this._tallyTimer = null;

        // Config
        this.votingPeriod = parseInt(process.env.GOV_VOTING_PERIOD) || (7 * 24 * 60 * 60 * 1000); // 7 days
    }

    setValidatorSet(validators) {
        this.validatorSet = validators;
    }

    async start() {
        this._messageHandler = (envelope) => this._handleMessage(envelope);
        this.peerManager.on('message', this._messageHandler);

        // Periodically check for proposals that need tallying (every 60s)
        this._tallyTimer = setInterval(() => this._checkExpiredProposals(), 60000);

        console.log('Governance engine started (voting period: ' + (this.votingPeriod / 86400000).toFixed(1) + ' days)');
    }

    async stop() {
        if (this._messageHandler) {
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        if (this._tallyTimer) {
            clearInterval(this._tallyTimer);
            this._tallyTimer = null;
        }
    }

    // Submit a governance proposal
    async propose(parameter, currentValue, proposedValue, rationale) {
        // Validate proposer is an active validator
        let proposerPubkey = this.identity ? this.identity.getPubkeyHex() : null;
        if (!proposerPubkey) throw new Error('No validator identity configured');

        let isValidator = this.validatorSet.some(v => v.pubkey === proposerPubkey);
        if (!isValidator) throw new Error('Proposer is not an active validator');

        // Validate parameter name and rationale length
        if (parameter.length > 255)
            throw new Error('parameter name exceeds maximum length of 255 characters');
        if (rationale && rationale.length > 2000)
            throw new Error('rationale exceeds maximum length of 2000 characters');

        // Check for active proposal on the same parameter
        let active = await this.db.doQuery(
            "SELECT id FROM governance_proposals WHERE parameter = ? AND status = 'voting'",
            [parameter]
        );
        if (active.length > 0) throw new Error('Active proposal already exists for ' + parameter);

        // Check cooldown from recent rejection
        let rejected = await this.db.doQuery(
            "SELECT voting_end FROM governance_proposals WHERE parameter = ? AND status = 'failed' ORDER BY voting_end DESC LIMIT 1",
            [parameter]
        );
        if (rejected.length > 0) {
            let cooldownEnd = new Date(rejected[0].voting_end).getTime() + (COOLDOWN_DAYS * 86400000);
            if (Date.now() < cooldownEnd) {
                let daysLeft = ((cooldownEnd - Date.now()) / 86400000).toFixed(1);
                throw new Error('Cooldown: ' + daysLeft + ' days remaining before re-proposing ' + parameter);
            }
        }

        // Validate change bounds
        this._validateChangeBounds(parameter, currentValue, proposedValue);

        // Create the proposal
        let proposalId = 'gov:' + parameter + ':' + Date.now();
        let now = new Date();
        let votingEnd = new Date(now.getTime() + this.votingPeriod);

        await this.db.doQuery(
            `INSERT INTO governance_proposals
                (proposal_id, proposer_pubkey, parameter, current_value, proposed_value,
                 rationale, status, voting_start, voting_end)
             VALUES (?, ?, ?, ?, ?, ?, 'voting', ?, ?)`,
            [proposalId, proposerPubkey, parameter, currentValue, proposedValue,
             rationale || '', now, votingEnd]
        );

        // Broadcast the proposal
        this.peerManager.broadcast(GOV_PROPOSE, {
            proposalId, parameter, currentValue, proposedValue, rationale,
            proposerPubkey, votingEnd: votingEnd.toISOString()
        });

        console.log('Governance: Proposal created — ' + proposalId + ' (' + parameter + ': ' + currentValue + ' → ' + proposedValue + ')');

        return { proposalId, parameter, status: 'voting', votingEnd: votingEnd.toISOString() };
    }

    // Cast a vote on a proposal
    async vote(proposalId, voteChoice) {
        if (!['approve', 'reject'].includes(voteChoice))
            throw new Error('Vote must be "approve" or "reject"');

        let voterPubkey = this.identity ? this.identity.getPubkeyHex() : null;
        if (!voterPubkey) throw new Error('No validator identity configured');

        let isValidatorVoter = this.validatorSet.some(v => v.pubkey === voterPubkey);
        if (!isValidatorVoter) throw new Error('Voter is not an active validator');

        // Verify proposal exists and is in voting state
        let proposals = await this.db.doQuery(
            "SELECT * FROM governance_proposals WHERE proposal_id = ? AND status = 'voting'",
            [proposalId]
        );
        if (proposals.length === 0) throw new Error('Proposal not found or not in voting state');

        // Check voting period hasn't ended
        let proposal = proposals[0];
        if (new Date(proposal.voting_end).getTime() < Date.now())
            throw new Error('Voting period has ended');

        // Sign the vote
        let votePayload = JSON.stringify({ proposalId, vote: voteChoice, voter: voterPubkey });
        let signature = this.identity ? this.identity.sign(votePayload) : '';

        // Record the vote (upsert — allows changing vote during voting period)
        await this.db.doQuery(
            `INSERT INTO governance_votes (proposal_id, voter_pubkey, vote, signature)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE vote = ?, signature = ?, created_at = NOW()`,
            [proposalId, voterPubkey, voteChoice, signature, voteChoice, signature]
        );

        // Broadcast the vote
        this.peerManager.broadcast(GOV_VOTE, {
            proposalId, vote: voteChoice, voterPubkey, signature
        });

        console.log('Governance: Vote cast — ' + voteChoice + ' on ' + proposalId);
        return { proposalId, vote: voteChoice, voter: voterPubkey };
    }

    // Get proposals by status
    async getProposals(status) {
        let query = "SELECT * FROM governance_proposals";
        let args = [];
        if (status) {
            query += " WHERE status = ?";
            args.push(status);
        }
        query += " ORDER BY created_at DESC LIMIT 50";
        return await this.db.doQuery(query, args);
    }

    // Get a specific proposal with its votes
    async getProposal(proposalId) {
        let proposals = await this.db.doQuery(
            "SELECT * FROM governance_proposals WHERE proposal_id = ?", [proposalId]
        );
        if (proposals.length === 0) return null;

        let votes = await this.db.doQuery(
            "SELECT voter_pubkey, vote, created_at FROM governance_votes WHERE proposal_id = ?",
            [proposalId]
        );

        return { proposal: proposals[0], votes: votes };
    }

    // --- Message handlers ---

    _handleMessage(envelope) {
        switch (envelope.type) {
            case GOV_PROPOSE: this._handlePropose(envelope); break;
            case GOV_VOTE:    this._handleVote(envelope);    break;
            case GOV_RESULT:  this._handleResult(envelope);  break;
        }
    }

    _handlePropose(envelope) {
        let { proposalId, parameter, currentValue, proposedValue, rationale, proposerPubkey, votingEnd } = envelope.data;
        if (!proposalId || !parameter) return;

        // Store the proposal locally if we don't have it
        this.db.doQuery(
            `INSERT IGNORE INTO governance_proposals
                (proposal_id, proposer_pubkey, parameter, current_value, proposed_value,
                 rationale, status, voting_start, voting_end)
             VALUES (?, ?, ?, ?, ?, ?, 'voting', NOW(), ?)`,
            [proposalId, proposerPubkey || '', parameter, currentValue, proposedValue,
             rationale || '', votingEnd]
        ).catch(e => {}); // Ignore duplicate
    }

    _handleVote(envelope) {
        let { proposalId, vote, voterPubkey, signature } = envelope.data;
        if (!proposalId || !vote || !voterPubkey) return;

        // Store the vote locally
        this.db.doQuery(
            `INSERT INTO governance_votes (proposal_id, voter_pubkey, vote, signature)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE vote = ?, signature = ?, created_at = NOW()`,
            [proposalId, voterPubkey, vote, signature || '', vote, signature || '']
        ).catch(e => {}); // Ignore errors
    }

    _handleResult(envelope) {
        let { proposalId, status } = envelope.data;
        if (!proposalId || !status) return;

        // Update proposal status locally
        this.db.doQuery(
            "UPDATE governance_proposals SET status = ?, applied_at = NOW() WHERE proposal_id = ? AND status = 'voting'",
            [status, proposalId]
        ).catch(e => {});
    }

    // --- Tally logic ---

    // Check for proposals whose voting period has ended and tally them
    async _checkExpiredProposals() {
        try {
            let expired = await this.db.doQuery(
                "SELECT * FROM governance_proposals WHERE status = 'voting' AND voting_end <= NOW()"
            );

            for (let proposal of expired) {
                await this._tallyProposal(proposal);
            }
        } catch (e) {
            // Silent — tally check runs on a timer, don't crash
        }
    }

    async _tallyProposal(proposal) {
        // Get all votes for this proposal
        let votes = await this.db.doQuery(
            "SELECT voter_pubkey, vote FROM governance_votes WHERE proposal_id = ?",
            [proposal.proposal_id]
        );

        let approvals = votes.filter(v => v.vote === 'approve').length;
        let rejections = votes.filter(v => v.vote === 'reject').length;
        let totalVotes = votes.length;
        let validatorCount = Math.max(this.validatorSet.length, 1);

        // Check quorum (50% minimum participation)
        let quorumMet = totalVotes >= Math.ceil(validatorCount / 2);

        // Check 2/3+ approval
        let approved = quorumMet && approvals >= Math.ceil(validatorCount * 2 / 3);

        let newStatus = approved ? 'passed' : 'failed';

        await this.db.doQuery(
            "UPDATE governance_proposals SET status = ?, applied_at = NOW() WHERE proposal_id = ?",
            [newStatus, proposal.proposal_id]
        );

        // Broadcast the result
        this.peerManager.broadcast(GOV_RESULT, {
            proposalId: proposal.proposal_id,
            status: newStatus,
            approvals, rejections, totalVotes, validatorCount
        });

        console.log('Governance: Proposal ' + proposal.proposal_id + ' — ' + newStatus +
            ' (' + approvals + '/' + totalVotes + ' approve, ' + validatorCount + ' validators)');

        if (approved) {
            this.emit('proposal:passed', {
                proposalId: proposal.proposal_id,
                parameter:  proposal.parameter,
                oldValue:   proposal.current_value,
                newValue:   proposal.proposed_value
            });
        }
    }

    // --- Validation ---

    _validateChangeBounds(parameter, currentValue, proposedValue) {
        // Only validate numeric parameters
        let current  = parseFloat(currentValue);
        let proposed = parseFloat(proposedValue);
        if (isNaN(current) || isNaN(proposed) || current === 0) return;

        let changeRatio = (proposed - current) / current;
        let isSlashParam = SLASHING_PARAMS.includes(parameter);

        let maxIncrease = isSlashParam ? MAX_SLASH_INCREASE : MAX_INCREASE;
        let maxDecrease = isSlashParam ? MAX_SLASH_DECREASE : MAX_DECREASE;

        if (changeRatio > maxIncrease) {
            throw new Error('Proposed increase (' + (changeRatio * 100).toFixed(1) + '%) exceeds maximum (' + (maxIncrease * 100) + '%)');
        }
        if (changeRatio < -maxDecrease) {
            throw new Error('Proposed decrease (' + (Math.abs(changeRatio) * 100).toFixed(1) + '%) exceeds maximum (' + (maxDecrease * 100) + '%)');
        }
    }
}

module.exports = Governance;
