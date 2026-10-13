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
    'list_snapshots',
    'remote_token_snapshots'
]);

const mirroredTableSet = new Set(MIRRORED_TABLES);
const verifiers = new Map();
const { verifyStateCheckpointCatchupRow } = require('../../anchor/checkpoint_engine/catchup_verifier.js');
const { verifyAnchorRewardCatchupRow } = require('../../anchor/publisher/reward_catchup_verifier.js');
const ValidatorIdentity = require('../../validators/identity.js');
const swq = require('../../consensus/stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const {
    canonicalRemoteTokenSnapshot,
    remoteTokenRowShapeOk
} = require('../../cross_chain/remote_token_snapshots.js');

function parseRemoteTokenSignatures(value) {
    if (Array.isArray(value)) return value;
    try {
        const signatures = JSON.parse(value || '[]');
        return Array.isArray(signatures) ? signatures : [];
    } catch (_err) {
        return [];
    }
}

function normalizeRemoteTokenValidators(rows, weighted) {
    const validators = [];
    const seen = new Set();
    for (const row of (rows || [])) {
        const pubkey = String(row && (row.pubkey || row.signing_pubkey) || '').toLowerCase();
        if (!weighted && seen.has(pubkey)) continue;
        seen.add(pubkey);
        validators.push({
            pubkey,
            source: String(row.source != null ? row.source : ''),
            weight: String(row.weight != null ? row.weight : row.amount)
        });
    }
    if (rows && rows.truncated === true) validators.truncated = true;
    return validators;
}

async function resolveRemoteTokenValidators(row, context, weighted) {
    const hub = context && context.hub ? context.hub : context;
    const engine = hub && hub.crossChainDex;
    let rows;
    if (context && typeof context.resolveCapabilityValidators === 'function') {
        rows = await context.resolveCapabilityValidators(
            'cross_chain', Number(row.snapshot_block), row.network);
    } else if (engine && typeof engine.resolveCapabilityValidators === 'function') {
        rows = await engine.resolveCapabilityValidators(
            'cross_chain', Number(row.snapshot_block), row.network);
    } else {
        const db = (context && context.db) ||
            (context && typeof context.findCapabilitySnapshotsBySnapshotBlock === 'function' && context) ||
            (hub && hub.db);
        if (!db || typeof db.findCapabilitySnapshotsBySnapshotBlock !== 'function') return [];
        rows = await db.findCapabilitySnapshotsBySnapshotBlock(
            Number(row.snapshot_block), 'cross_chain');
    }
    return normalizeRemoteTokenValidators(rows, weighted);
}

function validRemoteTokenSigners(validators, signatures, canonical) {
    const allowed = new Set(validators.map(validator => validator.pubkey));
    const valid = [];
    const seen = new Set();
    for (const item of signatures) {
        const pubkey = String(item && item.pubkey || '').toLowerCase();
        const signature = String(item && item.sig || '').toLowerCase();
        if (seen.has(pubkey) || !allowed.has(pubkey)) continue;
        if (!/^[0-9a-f]{64}$/.test(pubkey) || !/^[0-9a-f]{128}$/.test(signature)) continue;
        if (!ValidatorIdentity.verify(canonical, signature, pubkey)) continue;
        seen.add(pubkey);
        valid.push(pubkey);
    }
    return valid;
}

async function verifyRemoteTokenSnapshotCatchupRow(row, context) {
    if (!row || String(row.status) !== 'finalized' || !remoteTokenRowShapeOk(row)) return false;
    try {
        context = context || this;
        const snapshotBlock = Number(row.snapshot_block);
        const weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, row.network);
        const validators = await resolveRemoteTokenValidators(row, context, weighted);
        if (validators.length === 0 || validators.truncated === true) return false;
        const signatures = parseRemoteTokenSignatures(row.validator_signatures);
        const canonical = canonicalRemoteTokenSnapshot(
            row, row.finalizing_view != null ? row.finalizing_view : 0);
        const valid = validRemoteTokenSigners(validators, signatures, canonical);
        return weighted
            ? swq.meetsStakeThreshold(validators, valid)
            : valid.length >= bftQuorumOrSingle(validators.length, 1);
    } catch (_err) {
        return false;
    }
}

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
registerCatchupVerifier('remote_token_snapshots', verifyRemoteTokenSnapshotCatchupRow);
require('./cross_chain_catchup_verifiers.js')
    .registerCrossChainCatchupVerifiers(registerCatchupVerifier);

module.exports = {
    MIRRORED_TABLES,
    registerCatchupVerifier,
    getCatchupVerifier
};
