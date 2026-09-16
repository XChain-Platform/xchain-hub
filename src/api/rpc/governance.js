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
 * XChain Hub - JSON-RPC governance family: proposals, slash penalties and votes.
 *
 ********************************************************************/

const { validateLimit } = require('../validate');

function buildGovernanceRpc(ctx) {
    return Object.assign({}, proposalWritesRpc(ctx), slashReadsRpc(ctx), proposalReadsRpc(ctx));
}

function proposalWritesRpc(ctx) {
    const { hub } = ctx;
    return {
        async propose({parameter, current_value, proposed_value, rationale}){
            if(!parameter || !proposed_value)
                return {error: "parameter and proposed_value are required"};
            try {
                return await hub.propose(parameter, current_value || '', proposed_value, rationale);
            } catch (err) {
                return {error: err.message || "error creating proposal"};
            }
        },

        // Create a SLASH_PENALTY governance proposal over a validator's
        // pending slash_proposals evidence. penalty: 'suspend' | 'dismiss'. The
        // evidence hash is computed hub-side; the vote executes the penalty.
        async proposeslashpenalty({validator_pubkey, penalty, rationale}){
            if(!validator_pubkey || !penalty)
                return {error: "validator_pubkey and penalty (suspend/dismiss) are required"};
            try {
                return await hub.proposeSlashPenalty(validator_pubkey, penalty, rationale);
            } catch (err) {
                return {error: err.message || "error creating slash penalty proposal"};
            }
        },

        async vote({proposal_id, vote}){
            if(!proposal_id || !vote)
                return {error: "proposal_id and vote (approve/reject) are required"};
            try {
                return await hub.vote(proposal_id, vote);
            } catch (err) {
                return {error: err.message || "error casting vote"};
            }
        },
    };
}

function slashReadsRpc(ctx) {
    const { hub } = ctx;
    return {
        // List recorded slash proposals (all statuses), optionally filtered by
        // status and/or validator pubkey. Read-only companion to
        // proposeslashpenalty above: that method acts on the evidence, this one
        // publishes that it exists.
        //
        // PUBLIC READ TIER on purpose (not in WRITE_METHODS, not in
        // SENSITIVE_READ_METHODS): the rows carry no credential and no
        // mesh-internal connection state, only who was accused of what and
        // whether governance has ruled. Rows with status 'pending' are
        // UNADJUDICATED accusations, never findings; the status field is on
        // every row so a consumer can say so.
        //
        // The `evidence` blob is NOT served. SlashDetector.getSlashProposals
        // replaces it with evidence_hash before returning, because this POST
        // surface answers any caller: redacting downstream in one consumer
        // would leave the verbatim text readable straight off the hub.
        async getslashproposals({status, validator_pubkey, limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            if(!hub.slashDetector) return {error: "slash detector not active"};
            try {
                return await hub.slashDetector.getSlashProposals({
                    status, validatorPubkey: validator_pubkey, limit
                });
            } catch (err) {
                // Surface the argument-validation messages (bad status, malformed
                // pubkey) the way proposeslashpenalty does, so a caller can fix its
                // request; the generic fallback covers DB failures.
                return {error: err.message || "error fetching slash proposals"};
            }
        },

        async getproposal({proposal_id}){
            if(!proposal_id) return {error: "proposal_id is required"};
            try {
                let result = await hub.getProposal(proposal_id);
                return result || {error: "proposal not found"};
            } catch (err) {
                return {error: "error fetching proposal"};
            }
        },
    };
}

function proposalReadsRpc(ctx) {
    const { hub } = ctx;
    return {
        async getproposals({status, parameter, limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            try {
                return await hub.getProposals(status, parameter, limit);
            } catch (err) {
                return {error: "error fetching proposals"};
            }
        },

        // List individual governance votes by proposal and/or voter. Complements
        // getproposal (which bundles one proposal's votes): the explorer's
        // governance pages also need list-by-voter across proposals.
        async getvotes({proposal_id, voter_pubkey, limit}){
            let limErr = validateLimit(limit);
            if (limErr) return limErr;
            try {
                return await hub.getVotes({proposalId: proposal_id, voterPubkey: voter_pubkey, limit});
            } catch (err) {
                return {error: "error fetching votes"};
            }
        },
    };
}

module.exports = { buildGovernanceRpc };
