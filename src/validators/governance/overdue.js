/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Hub - overdue governance proposal accounting mixin.
 *
 ********************************************************************/

'use strict';

const hubConfig = require('../../config');
const { getLogger } = require('../../observability');
const logger = getLogger();

const DEFAULT_OVERDUE_MS = 2 * 60 * 60 * 1000;
const ERROR_REPEAT_MS = 60 * 60 * 1000;

function overdueRows(proposals, now, overdueMs) {
    return proposals.filter(proposal =>
        new Date(proposal.voting_end).getTime() < now - overdueMs
    );
}

function reportNewlyOverdue(subject, overdue, now) {
    if (!(subject._overdueProposalLastReports instanceof Map)) {
        subject._overdueProposalLastReports = new Map();
    }

    let overdueIds = new Set(overdue.map(proposal => proposal.proposal_id));
    for (let id of subject._overdueProposalLastReports.keys()) {
        if (!overdueIds.has(id)) subject._overdueProposalLastReports.delete(id);
    }

    for (let proposal of overdue) {
        let lastReport = subject._overdueProposalLastReports.get(proposal.proposal_id);
        if (lastReport !== undefined && now - lastReport < ERROR_REPEAT_MS) continue;
        subject._overdueProposalLastReports.set(proposal.proposal_id, now);
        logger.error('Governance: proposal ' + proposal.proposal_id +
            ' remains in voting after its overdue threshold');
    }
}

module.exports = {

    async countOverdueProposals(now = Date.now()) {
        let proposals;
        try {
            proposals = await this.db.findGovernanceProposalsByStatusAndVotingEnd();
        } catch (error) {
            logger.error('Governance: failed to count overdue proposals: ' +
                (error && error.message ? error.message : error));
            return this.overdueProposalCount || 0;
        }

        let overdueMs = parseInt(hubConfig.GOVERNANCE_OVERDUE_MS) || DEFAULT_OVERDUE_MS;
        let overdue = overdueRows(proposals, now, overdueMs);
        reportNewlyOverdue(this, overdue, now);
        this.overdueProposalCount = overdue.length;
        return this.overdueProposalCount;
    }
};
