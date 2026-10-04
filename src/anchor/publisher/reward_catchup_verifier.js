'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const ValidatorIdentity = require('../../validators/identity.js');
const ar = require('../../consensus/gates/anchor_reward_gate.js');
const { resolveQuorumNetwork } = require('../quorum_network.js');
const attestMethods = require('./attest_round.js');
const archiveAttestMethods = require('./archive/attest.js');
const rewardMethods = require('./reward.js');

function parseSignatures(value){
    if(Array.isArray(value)) return value;
    if(typeof value !== 'string') return null;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : null;
    } catch(_e){
        return null;
    }
}

function rewardShape(row){
    const rewardType = String(row.reward_type || '');
    const snapshotBlock = Number(row.snapshot_block);
    const roundReference = Number(row.round_reference);
    const publisher = String(row.publisher || '').toLowerCase();
    if(!Number.isSafeInteger(snapshotBlock) || snapshotBlock < 0 ||
       !Number.isSafeInteger(roundReference) || roundReference < 0 || !publisher) return null;
    if(rewardType !== 'anchor_bundle' && rewardType !== 'anchor_archive') return null;
    if(rewardType === 'anchor_bundle' && roundReference !== snapshotBlock) return null;
    const expectedAmount = rewardType === 'anchor_archive' ? ar.ARCHIVE_REWARD_AMOUNT : ar.ANCHOR_REWARD_AMOUNT;
    if(String(row.reward_amount) !== String(expectedAmount)) return null;
    return { rewardType, snapshotBlock, roundReference, publisher };
}

function verifiedSigners(signatures, pubkeys, canonical){
    const seen = new Set();
    for(const signature of signatures){
        const pubkey = String(signature && signature.pubkey || '').toLowerCase();
        if(!pubkey || seen.has(pubkey) || !pubkeys.has(pubkey)) continue;
        if(ValidatorIdentity.verify(canonical, String(signature.sig || ''), pubkey)) seen.add(pubkey);
    }
    return [...seen];
}

function hubFromContext(context){
    if(!context) return null;
    if(context.hub) return context.hub;
    return context.stateAnchorPublisher ? context : null;
}

function anchorPublisher(context){
    const hub = hubFromContext(context);
    return hub && hub.stateAnchorPublisher;
}

function normalizeSigningSet(rows){
    const set = (rows || []).map(row => ({
        pubkey: String(row && (row.pubkey || row.signing_pubkey) || '').toLowerCase(),
        source: String(row && row.source != null ? row.source : ''),
        amount: String(row && row.amount != null ? row.amount : row && row.weight)
    }));
    if(rows && rows.truncated === true) set.truncated = true;
    return set;
}

async function resolveSigningSet(context, publisher, snapshotBlock, network){
    if(context && typeof context.resolveCapabilitySet === 'function')
        return normalizeSigningSet(await context.resolveCapabilitySet('oracle_publish', snapshotBlock, network));
    if(publisher && typeof publisher.resolveCapabilitySet === 'function')
        return normalizeSigningSet(await publisher.resolveCapabilitySet('oracle_publish', snapshotBlock, network));
    const hub = hubFromContext(context);
    const db = (context && context.db) || (hub && hub.db);
    if(!db || typeof db.findCapabilitySnapshotsBySnapshotBlock !== 'function') return [];
    return normalizeSigningSet(await db.findCapabilitySnapshotsBySnapshotBlock(snapshotBlock, 'oracle_publish'));
}

async function verifyAnchorRewardCatchupRow(row, context){
    if(!row) return false;
    try {
        const publisher = anchorPublisher(context);
        const shape = rewardShape(row);
        const signatures = parseSignatures(row.publisher_attestations);
        if(!shape || !signatures) return false;
        const network = String(row.network || '');
        if(!network) return false;
        const quorumNetwork = resolveQuorumNetwork(row, publisher && publisher.network);
        const set = await resolveSigningSet(context, publisher, shape.snapshotBlock, quorumNetwork);
        const pubkeys = new Set((set || []).map(v => String(v.pubkey).toLowerCase()));
        if(pubkeys.size === 0 || !pubkeys.has(shape.publisher)) return false;
        const identity = { network, snapshot_block: shape.snapshotBlock };
        const canonical = shape.rewardType === 'anchor_archive'
            ? archiveAttestMethods.archiveAttestationCanonical(identity, shape.roundReference, shape.publisher)
            : attestMethods.attestationCanonical(identity, shape.publisher);
        const signers = verifiedSigners(signatures, pubkeys, canonical);
        return rewardMethods.federationQuorumMet(
            set, pubkeys, signers, network, shape.snapshotBlock);
    } catch(_e){
        return false;
    }
}

module.exports = { verifyAnchorRewardCatchupRow };
