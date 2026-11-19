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
 * XChain Hub - observed archive reward membership keys
 *
 ********************************************************************/

'use strict';

const { ARCHIVE_REWARD_TYPE, rewardRoundQualifier } = require('../../../anchor_reward_key.js');

function rewardBaseKey(r){
    return String(r.reward_type) + '|' + String(Number(r.round_number)) + '|' +
           String(r.validator_pubkey).toLowerCase();
}

// Archive-body rewards carry block_index, from which their ledger qualifier
// is derived. This key is local membership bookkeeping, not wire bytes.
function archiveBodyRewardKey(r){
    return rewardBaseKey(r) + '|' + String(rewardRoundQualifier(r.reward_type, r.block_index));
}

// FINALIZED rewards carry the qualifier directly. Invalid qualified entries
// cannot prove membership in the observed body and return no key.
function finalizedRewardKey(r){
    let present = r.round_qualifier !== null && r.round_qualifier !== undefined;
    if(!present && String(r.reward_type) === ARCHIVE_REWARD_TYPE) return null;
    let qualifier = present ? Number(r.round_qualifier) : 0;
    if(!Number.isSafeInteger(qualifier) || qualifier < 0) return null;
    if(String(r.reward_type) !== ARCHIVE_REWARD_TYPE && qualifier !== 0) return null;
    return rewardBaseKey(r) + '|' + String(qualifier);
}

module.exports = { archiveBodyRewardKey, finalizedRewardKey };
