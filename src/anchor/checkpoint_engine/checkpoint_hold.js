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
 ********************************************************************/

'use strict';

const { replayWindowFor } = require('./supersede_fill.js');

const CHECKPOINT_HASH_FIELDS = [
    'ledger_hash',
    'actions_hash',
    'contract_hash',
];

function sameHash(left, right){
    return String(left).toLowerCase() === String(right).toLowerCase();
}

function supersedeWitnessDecline(rules){
    if(rules && rules.replay && rules.replay.witness === 'passed') return null;
    return 'supersede_unwitnessed';
}

// Bound the override by the strict window parser the leader uses, so a blank or missing bound covers nothing.
function witnessedReplayCovers(rules, blockIndex){
    const span = replayWindowFor(rules);
    if(!span) return false;
    const block = Number(blockIndex);
    return span.target <= block && block <= span.replay_to;
}

function checkpointHoldDecline(row, own, rules){
    if(!sameHash(row.block_hash, own.block_hash)) return 'checkpoint_reorged';

    const disagrees = CHECKPOINT_HASH_FIELDS.some((field) =>
        !sameHash(row[field], own[field]));
    const stateRootDisagrees = row.state_root != null && own.state_root != null &&
        !sameHash(row.state_root, own.state_root);

    if(!disagrees && !stateRootDisagrees) return null;
    if(witnessedReplayCovers(rules, row.block_index)) return null;
    return 'checkpoint_disagreement';
}

module.exports = { supersedeWitnessDecline, checkpointHoldDecline };
