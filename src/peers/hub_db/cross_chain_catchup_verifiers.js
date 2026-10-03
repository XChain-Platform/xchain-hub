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

const ValidatorIdentity = require('../../validators/identity.js');
const swq = require('../../consensus/stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const CrossChainDexEngine = require('../../cross_chain/dex_engine.js');
const CrossChainCallEngine = require('../../cross_chain/call_engine.js');
const CrossChainBridgeEngine = require('../../cross_chain/bridge_engine.js');
const { listSnapshotCanonical } = require('../../cross_chain/list/canonical.js');

const FALLBACK_ENGINES = Object.freeze({
    cross_chain_matches: Object.create(CrossChainDexEngine.prototype),
    cross_chain_calls: Object.create(CrossChainCallEngine.prototype),
    bridge_transfers: Object.create(CrossChainBridgeEngine.prototype),
    policy_snapshots: Object.create(CrossChainBridgeEngine.prototype),
    list_snapshots: { canonicalMatch: listSnapshotCanonical }
});

const HUB_ENGINE_FIELDS = Object.freeze({
    cross_chain_matches: 'crossChainDex',
    cross_chain_calls: 'crossChainCalls',
    bridge_transfers: 'crossChainBridge',
    policy_snapshots: 'crossChainBridge',
    list_snapshots: 'listShare'
});

function hubFromContext(context) {
    if (!context) return null;
    if (context.hub) return context.hub;
    return context.crossChainDex || context.crossChainCalls || context.crossChainBridge ||
        context.listShare ? context : null;
}

function engineFor(table, context) {
    const hub = hubFromContext(context);
    return (hub && hub[HUB_ENGINE_FIELDS[table]]) || FALLBACK_ENGINES[table];
}

function parseSignatures(value) {
    let signatures = value;
    if (!Array.isArray(signatures)) {
        try { signatures = JSON.parse(value || '[]'); }
        catch (_err) { return []; }
    }
    return Array.isArray(signatures) ? signatures : [];
}

function normalizeValidators(rows, weighted) {
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

async function validatorsFromDb(db, snapshotBlock) {
    if (!db || typeof db.findCapabilitySnapshotsBySnapshotBlock !== 'function') return [];
    return db.findCapabilitySnapshotsBySnapshotBlock(snapshotBlock, 'cross_chain');
}

async function resolveValidators(table, row, context, weighted) {
    const engine = engineFor(table, context);
    let rows;
    if (context && typeof context.resolveCapabilityValidators === 'function') {
        rows = await context.resolveCapabilityValidators('cross_chain', Number(row.snapshot_block), row.network);
    } else if (engine && typeof engine.resolveCapabilityValidators === 'function' &&
               engine !== FALLBACK_ENGINES[table]) {
        rows = await engine.resolveCapabilityValidators('cross_chain', Number(row.snapshot_block), row.network);
    } else {
        const hub = hubFromContext(context);
        const db = (context && context.db) ||
            (context && typeof context.findCapabilitySnapshotsBySnapshotBlock === 'function' && context) ||
            (hub && hub.db) || null;
        rows = await validatorsFromDb(db, Number(row.snapshot_block));
    }
    return normalizeValidators(rows, weighted);
}

function collectValidSigners(validators, signatures, canonical) {
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

function canonicalFor(table, row, context) {
    const engine = engineFor(table, context);
    return engine.canonicalMatch(row, row.finalizing_view != null ? row.finalizing_view : 0);
}

async function verifyFinalizedRow(table, row, context) {
    if (!row || String(row.status) !== 'finalized') return false;
    try {
        const snapshotBlock = Number(row.snapshot_block);
        if (!Number.isSafeInteger(snapshotBlock) || snapshotBlock < 0) return false;
        const weighted = swq.isStakeWeightedQuorumActive(snapshotBlock, row.network);
        const validators = await resolveValidators(table, row, context, weighted);
        if (validators.length === 0 || validators.truncated === true) return false;
        const signatures = parseSignatures(row.validator_signatures);
        const canonical = canonicalFor(table, row, context);
        const valid = collectValidSigners(validators, signatures, canonical);
        return weighted
            ? swq.meetsStakeThreshold(validators, valid)
            : valid.length >= bftQuorumOrSingle(validators.length, 1);
    } catch (_err) {
        return false;
    }
}

function registerCrossChainCatchupVerifiers(registerCatchupVerifier) {
    registerCatchupVerifier('cross_chain_matches', createVerifier('cross_chain_matches'));
    registerCatchupVerifier('cross_chain_calls', createVerifier('cross_chain_calls'));
    registerCatchupVerifier('bridge_transfers', createVerifier('bridge_transfers'));
    registerCatchupVerifier('policy_snapshots', createVerifier('policy_snapshots'));
    registerCatchupVerifier('list_snapshots', createVerifier('list_snapshots'));
}

function createVerifier(table) {
    return function verifyCatchupRow(row, context) {
        return verifyFinalizedRow(table, row, context || this);
    };
}

module.exports = {
    registerCrossChainCatchupVerifiers,
    verifyFinalizedRow
};
