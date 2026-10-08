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
 * XChain Hub - the OVERDUE counter, as a Governance.prototype mixin.
 *
 * Counts voting proposals that remain open after their voting window and
 * rate-limits the error line for each proposal to once per hour.
 *
 ********************************************************************/

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

const DEFAULT_OVERDUE_MS = 7200000;
const LOG_INTERVAL_MS = 3600000;

module.exports = {

    async countOverdueProposals(now = Date.now()) {
        let proposals;
        try {
            proposals = await this.db.findGovernanceProposalsByStatusAndVotingEnd();
        } catch (e) {
            logger.error(nodeUtil.format('Governance overdue count error:', e.message, e));
            return this._overdueCount || 0;
        }

        let overdueMs = Number.isInteger(this.overdueMs) && this.overdueMs > 0
            ? this.overdueMs
            : DEFAULT_OVERDUE_MS;
        let overdue = proposals.filter(proposal =>
            now - new Date(proposal.voting_end).getTime() >= overdueMs);

        if (!(this._overdueLogged instanceof Map)) this._overdueLogged = new Map();
        let overdueIds = new Set(overdue.map(proposal => proposal.proposal_id));
        for (let id of this._overdueLogged.keys()) {
            if (!overdueIds.has(id)) this._overdueLogged.delete(id);
        }
        for (let proposal of overdue) {
            let lastLogged = this._overdueLogged.get(proposal.proposal_id);
            if (lastLogged !== undefined && now - lastLogged < LOG_INTERVAL_MS) continue;
            logger.error('Governance: Proposal ' + proposal.proposal_id + ' is overdue');
            this._overdueLogged.set(proposal.proposal_id, now);
        }

        this._overdueCount = overdue.length;
        return this._overdueCount;
    }

};
