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
 * XChain Hub - Governance Takeover Rank
 *
 * Pure, unwired helpers for ordering a locked electorate and opening its
 * takeover windows. This module is not a Governance.prototype mixin.
 *
 ********************************************************************/

'use strict';

function rankedElectorate(electorate, leaderAddr) {
    if (!Array.isArray(electorate) || electorate.length === 0 || typeof leaderAddr !== 'string') return null;
    let leaderIndex = -1;
    for (let i = 0; i < electorate.length; i++) {
        if (electorate[i] && electorate[i].addr === leaderAddr) {
            if (leaderIndex !== -1) return null;
            leaderIndex = i;
        }
    }
    if (leaderIndex === -1) return null;
    return electorate.slice(leaderIndex).concat(electorate.slice(0, leaderIndex))
        .map(entry => ({ pubkey: entry.pubkey, addr: entry.addr }));
}

function takeoverRank(ranked, addr) {
    if (!Array.isArray(ranked)) return -1;
    return ranked.findIndex(entry => entry && entry.addr === addr);
}

function rankOpensAt(votingEnd, rank, stepMs) {
    if (votingEnd === null || votingEnd === undefined) return null;
    if (!Number.isInteger(rank) || rank < 0 || !Number.isInteger(stepMs) || stepMs <= 0) return null;
    if (!(votingEnd instanceof Date) && typeof votingEnd !== 'number' && typeof votingEnd !== 'string') return null;
    const votingEndMs = new Date(votingEnd).getTime();
    if (!Number.isFinite(votingEndMs)) return null;
    return votingEndMs + rank * stepMs;
}

function resultSenderEntitled(ranked, senderAddr, votingEnd, now, stepMs, failoverActive) {
    const rank = takeoverRank(ranked, senderAddr);
    const nowMs = now instanceof Date ? now.getTime() : now;
    if (rank < 0 || typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return false;
    if (rank === 0) return true;
    if (failoverActive !== true) return false;
    const opensAt = rankOpensAt(votingEnd, rank, stepMs);
    return opensAt !== null && nowMs >= opensAt;
}

module.exports = { rankedElectorate, takeoverRank, rankOpensAt, resultSenderEntitled };
