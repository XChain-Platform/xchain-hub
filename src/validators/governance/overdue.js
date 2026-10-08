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

'use strict';

const nodeUtil = require('node:util');
const hubConfig = require('../../config');
const { getLogger } = require('../../observability');
const logger = getLogger();

const DEFAULT_OVERDUE_MS = 7200000;
const LOG_INTERVAL_MS = 3600000;

function getOverdueMs(subject) {
    if (Number.isInteger(subject.overdueMs) && subject.overdueMs > 0) {
        return subject.overdueMs;
    }
    let configured = parseInt(hubConfig.GOVERNANCE_OVERDUE_MS, 10);
    return Number.isInteger(configured) && configured > 0
        ? configured
        : DEFAULT_OVERDUE_MS;
}

function overdueRows(proposals, now, overdueMs) {
    return proposals.filter(proposal =>
        now - new Date(proposal.voting_end).getTime() >= overdueMs);
}

function reportOverdue(subject, overdue, now) {
    if (!(subject._overdueLogged instanceof Map)) subject._overdueLogged = new Map();
    let overdueIds = new Set(overdue.map(proposal => proposal.proposal_id));
    for (let id of subject._overdueLogged.keys()) {
        if (!overdueIds.has(id)) subject._overdueLogged.delete(id);
    }
    for (let proposal of overdue) {
        let lastLogged = subject._overdueLogged.get(proposal.proposal_id);
        if (lastLogged !== undefined && now - lastLogged < LOG_INTERVAL_MS) continue;
        logger.error('Governance: Proposal ' + proposal.proposal_id + ' is overdue');
        subject._overdueLogged.set(proposal.proposal_id, now);
    }
}

module.exports = {

    async countOverdueProposals(now = Date.now()) {
        let proposals;
        try {
            proposals = await this.db.findGovernanceProposalsByStatusAndVotingEnd();
        } catch (e) {
            logger.error(nodeUtil.format('Governance overdue count error:', e.message, e));
            return this._overdueCount || 0;
        }

        let overdue = overdueRows(proposals, now, getOverdueMs(this));
        reportOverdue(this, overdue, now);
        this._overdueCount = overdue.length;
        return this._overdueCount;
    }

};
