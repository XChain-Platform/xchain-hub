'use strict';

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

const MIRRORED_TABLES = Object.freeze([
    'price_snapshots',
    'oracle_prices',
    'cross_chain_matches',
    'capability_snapshots',
    'cross_chain_calls',
    'state_checkpoints',
    'anchor_reward_attestations',
    'attestation_responses',
    'bridge_transfers',
    'policy_snapshots',
    'list_snapshots'
]);

const mirroredTableSet = new Set(MIRRORED_TABLES);
const verifiers = new Map();
const { verifyStateCheckpointCatchupRow } = require('../../anchor/checkpoint_engine/catchup_verifier.js');
const { verifyAnchorRewardCatchupRow } = require('../../anchor/publisher/reward_catchup_verifier.js');

function registerCatchupVerifier(table, fn) {
    if (!mirroredTableSet.has(table)) {
        throw new Error('Unknown mirrored table: ' + table);
    }
    if (verifiers.has(table)) {
        throw new Error('Catch-up verifier already registered for table: ' + table);
    }
    if (typeof fn !== 'function') {
        throw new TypeError('Catch-up verifier must be a function');
    }
    verifiers.set(table, fn);
}

function getCatchupVerifier(table) {
    return verifiers.get(table);
}

registerCatchupVerifier('state_checkpoints', verifyStateCheckpointCatchupRow);
registerCatchupVerifier('anchor_reward_attestations', verifyAnchorRewardCatchupRow);
require('./cross_chain_catchup_verifiers.js')
    .registerCrossChainCatchupVerifiers(registerCatchupVerifier);

module.exports = {
    MIRRORED_TABLES,
    registerCatchupVerifier,
    getCatchupVerifier
};
