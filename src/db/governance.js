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
 * XChain Hub - query methods for the governance proposal and vote tables.
 *
 * Owns src/sql/governance_proposals.sql, src/sql/governance_votes.sql.
 * src/db/index.js installs every method below on Database.prototype, so callers
 * keep writing db.<method>() and never see which file the query lives in.
 *
 * Add a query as one more object-literal method before the closing brace: one
 * statement per method, ? placeholders, and a get/find/create/update/set/delete/
 * is/has verb prefix naming the table family it reads.
 *
 ********************************************************************/

module.exports = {
    // Inserts a row into governance_proposals.
    // Moved here from src/Governance.js:372.
    async createGovernanceProposalByProposalId(proposalId, proposerPubkey, parameter, currentValue, proposedValue, rationale, now, votingEnd, activation, snapshotJson) {
        return this.doQuery(`INSERT INTO governance_proposals
                (proposal_id, proposer_pubkey, parameter, current_value, proposed_value,
                 rationale, status, voting_start, voting_end, activation_block, validator_snapshot)
             VALUES (?, ?, ?, ?, ?, ?, 'voting', ?, ?, ?, ?)`, [proposalId, proposerPubkey, parameter, currentValue, proposedValue, rationale, now, votingEnd, activation, snapshotJson]);
    },

    // Inserts a row into governance_proposals.
    // Moved here from src/Governance.js:711.
    async createGovernanceProposalByProposalIdAndProposerPubkey(proposalId, proposer_pubkey, parameter, currentValue, proposedValue, rationale, localVotingEnd, activation, snapshotJson) {
        return this.doQuery(`INSERT IGNORE INTO governance_proposals
                (proposal_id, proposer_pubkey, parameter, current_value, proposed_value,
                 rationale, status, voting_start, voting_end, activation_block, validator_snapshot)
             VALUES (?, ?, ?, ?, ?, ?, 'voting', NOW(), ?, ?, ?)`, [proposalId, proposer_pubkey, parameter, currentValue, proposedValue, rationale, localVotingEnd, activation, snapshotJson]);
    },

    // Reads rows from governance_proposals.
    // Moved here from src/Governance.js:326.
    async findGovernanceProposalsByParameter(parameter) {
        return this.doQuery(`SELECT id FROM governance_proposals WHERE parameter = ? AND status = 'voting'`, [parameter]);
    },

    // Reads rows from governance_proposals.
    // Moved here from src/Governance.js:493.
    async findGovernanceProposalsByProposalId(proposalId) {
        return this.doQuery('SELECT * FROM governance_proposals WHERE proposal_id = ?', [proposalId]);
    },

    // Reads rows from governance_proposals.
    // Moved here from src/Governance.js:403.
    async findGovernanceProposalsByProposalIdInVoting(proposalId) {
        return this.doQuery(`SELECT * FROM governance_proposals WHERE proposal_id = ? AND status = 'voting'`, [proposalId]);
    },

    // Reads rows from governance_proposals.
    // Moved here from src/CapabilityRegistry.js:185, src/ProviderRegistry.js:430.
    async findGovernanceProposalsByStatus() {
        return this.doQuery(`SELECT parameter, proposed_value, activation_block
                   FROM governance_proposals
                  WHERE status = 'passed' AND activation_block IS NOT NULL
                  ORDER BY activation_block ASC, id ASC`);
    },

    // Reads rows from governance_proposals.
    // Moved here from src/Governance.js:983.
    async findGovernanceProposalsByStatusAndVotingEnd() {
        return this.doQuery(`SELECT * FROM governance_proposals WHERE status = 'voting' AND voting_end <= NOW()`);
    },

    // Reads rows from governance_votes.
    // Moved here from src/Governance.js:882.
    async findGovernanceVotes(proposalId) {
        return this.doQuery('SELECT voter_pubkey, vote FROM governance_votes WHERE proposal_id = ?', [proposalId]);
    },

    // Reads rows from governance_votes.
    // Moved here from src/Governance.js:498.
    async findGovernanceVotesWithCreatedAt(proposalId) {
        return this.doQuery('SELECT voter_pubkey, vote, created_at FROM governance_votes WHERE proposal_id = ?', [proposalId]);
    },

    // Reads rows from governance_votes.
    // Moved here from src/Governance.js:1014.
    async findGovernanceVotesWithSignature(proposal_id) {
        return this.doQuery('SELECT voter_pubkey, vote, signature, vote_seq FROM governance_votes WHERE proposal_id = ?', [proposal_id]);
    },

    // Reads one row from governance_proposals.
    // Moved here from src/Governance.js:332, src/Governance.js:693.
    async getGovernanceProposalByParameter(parameter) {
        return this.doQuery(`SELECT voting_end FROM governance_proposals WHERE parameter = ? AND status = 'failed' ORDER BY voting_end DESC LIMIT 1`, [parameter]);
    },

    // Reads one row from governance_proposals.
    // Moved here from src/Governance.js:861.
    async getGovernanceProposalElectorate(proposalId) {
        return this.doQuery('SELECT voting_end, validator_snapshot FROM governance_proposals WHERE proposal_id = ? LIMIT 1', [proposalId]);
    },

    // Reads one row from governance_proposals.
    // Moved here from src/Governance.js:791.
    async getGovernanceProposalElectorateInVoting(proposalId) {
        return this.doQuery(`SELECT voting_end, validator_snapshot FROM governance_proposals WHERE proposal_id = ? AND status = 'voting' LIMIT 1`, [proposalId]);
    },

    // Reads one row from governance_proposals.
    // Moved here from src/Governance.js:912.
    async getGovernanceProposalParameterChange(proposalId) {
        return this.doQuery('SELECT parameter, current_value, proposed_value, activation_block FROM governance_proposals WHERE proposal_id = ? LIMIT 1', [proposalId]);
    },

    // Reads one row from governance_votes.
    // Moved here from src/Governance.js:427.
    async getGovernanceVote(proposalId, voterPubkey) {
        return this.doQuery('SELECT vote_seq FROM governance_votes WHERE proposal_id = ? AND voter_pubkey = ? LIMIT 1', [proposalId, voterPubkey]);
    },

    // Inserts or updates a row in governance_votes.
    // Moved here from src/Governance.js:733.
    async setGovernanceVote(proposalId, voterPubkey, vote, signature, seq) {
        return this.doQuery(`INSERT INTO governance_votes (proposal_id, voter_pubkey, vote, signature, vote_seq)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                 vote       = IF(VALUES(vote_seq) > COALESCE(vote_seq, 0), VALUES(vote), vote),
                 signature  = IF(VALUES(vote_seq) > COALESCE(vote_seq, 0), VALUES(signature), signature),
                 created_at = IF(VALUES(vote_seq) > COALESCE(vote_seq, 0), NOW(), created_at),
                 vote_seq   = GREATEST(COALESCE(vote_seq, 0), VALUES(vote_seq))`, [proposalId, voterPubkey, vote, signature, seq]);
    },

    // Updates governance_proposals.
    // Moved here from src/Governance.js:899, src/Governance.js:1034.
    async updateGovernanceProposal(applyStatus, proposalId) {
        return this.doQuery(`UPDATE governance_proposals SET status = ?, applied_at = NOW() WHERE proposal_id = ? AND status = 'voting'`, [applyStatus, proposalId]);
    },

    // Reads rows from governance_proposals, narrowed to whichever of status and
    // parameter the caller passed. The WHERE clauses are built from the filters
    // present; the limit is parsed and clamped to 1..500 before it reaches the
    // statement, so the interpolated LIMIT can never carry caller text.
    // Moved here from src/Governance.js:434.
    async findGovernanceProposalsFiltered(status, parameter, limit) {
        let query = "SELECT * FROM governance_proposals";
        let where = [];
        let args = [];
        if (status) {
            where.push("status = ?");
            args.push(status);
        }
        if (parameter) {
            where.push("parameter = ?");
            args.push(parameter);
        }
        if (where.length) query += " WHERE " + where.join(" AND ");
        let lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
        query += " ORDER BY created_at DESC LIMIT " + lim;
        return this.doQuery(query, args);
    },

    // Reads rows from governance_votes, narrowed to whichever of proposal and voter
    // the caller passed. Same clause-building and limit clamp as the proposal list
    // above; the signature column is left out on purpose (see the call site).
    // Moved here from src/Governance.js:456.
    async findGovernanceVotesFiltered({ proposalId, voterPubkey, limit } = {}) {
        let query = "SELECT id, proposal_id, voter_pubkey, vote, created_at FROM governance_votes";
        let where = [];
        let args = [];
        if (proposalId) {
            where.push("proposal_id = ?");
            args.push(proposalId);
        }
        if (voterPubkey) {
            where.push("voter_pubkey = ?");
            args.push(voterPubkey);
        }
        if (where.length) query += " WHERE " + where.join(" AND ");
        let lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
        query += " ORDER BY id DESC LIMIT " + lim;
        return this.doQuery(query, args);
    }
};
