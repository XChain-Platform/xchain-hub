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
 * XChain Hub - Governance and Reorgs
 *
 * The two engines a hub starts after consensus: reorg reporting and
 * parameter governance, plus the read and write surface the API serves over
 * proposals, votes and slash penalties.
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();

class Governance {

    async startReorgHandler(){
        if(!this.peerManager) return;
        const { ReorgHandler } = this.constructor.modules;
        this.reorgHandler = new ReorgHandler(this);
        let validators = await this._loadValidatorSet();
        this.reorgHandler.setValidatorSet(validators);
        await this.reorgHandler.start();
    }

    async reportReorg(chain, reorgHeight, timestamp, oldHash, newHash){
        if(!this.reorgHandler) throw new Error('Reorg handler not active');
        return await this.reorgHandler.reportReorg(chain, reorgHeight, timestamp, oldHash, newHash);
    }

    async getReorgHistory(limit){
        if(!this.reorgHandler) return [];
        return await this.reorgHandler.getReorgHistory(limit);
    }

    async startGovernance(){
        if(!this.peerManager) return;
        const { Governance, SlashGovernance } = this.constructor.modules;
        this.governance = new Governance(this);
        let validators = await this._loadValidatorSet();
        this.governance.setValidatorSet(validators);
        await this.governance.start();

        // Governance-mediated penalty execution over slash_proposals. 'proposal:finalized'
        // fires on the tally leader AND every follower's local re-tally of GOV_RESULT, so a
        // passed SLASH_PENALTY executes federation-wide with no new wire message.
        this.slashGovernance = new SlashGovernance(this);
        this.governance.on('proposal:finalized', (ev) => {
            this.slashGovernance.applyFinalized(ev).catch(e =>
                logger.error(nodeUtil.format('SlashGovernance: penalty execution failed for %s:',
                    (ev && ev.proposalId), e && e.message ? e.message : e)));
        });
    }

    // Create a SLASH_PENALTY governance proposal over the validator's pending
    // slash_proposals evidence. penalty: 'suspend' or 'dismiss'.
    async proposeSlashPenalty(validatorPubkey, penalty, rationale){
        if(!this.slashGovernance) throw new Error('Governance not active');
        return await this.slashGovernance.proposeSlashPenalty(validatorPubkey, penalty, rationale);
    }

    async propose(parameter, currentValue, proposedValue, rationale){
        if(!this.governance) throw new Error('Governance not active');
        return await this.governance.propose(parameter, currentValue, proposedValue, rationale);
    }

    async vote(proposalId, voteChoice){
        if(!this.governance) throw new Error('Governance not active');
        return await this.governance.vote(proposalId, voteChoice);
    }

    async getProposals(status, parameter, limit){
        if(!this.governance) return [];
        return await this.governance.getProposals(status, parameter, limit);
    }

    async getProposal(proposalId){
        if(!this.governance) return null;
        return await this.governance.getProposal(proposalId);
    }

    async getVotes({proposalId, voterPubkey, limit} = {}){
        if(!this.governance) return [];
        return await this.governance.getVotes({proposalId, voterPubkey, limit});
    }

    async getValidatorCapabilities({signingPubkey, capability, limit} = {}){
        if(!this.capabilityRegistry) return [];
        return await this.capabilityRegistry.listState({signingPubkey, capability, limit});
    }
}

module.exports = Governance;
