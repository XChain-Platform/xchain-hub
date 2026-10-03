'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const ValidatorIdentity = require('../../validators/identity.js');
const ar = require('../../consensus/gates/anchor_reward_gate.js');
const { resolveQuorumNetwork } = require('../quorum_network.js');

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
    if(!Number.isFinite(snapshotBlock) || !Number.isFinite(roundReference) || !publisher) return null;
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

async function verifyAnchorRewardCatchupRow(row, hub){
    const publisher = hub && hub.stateAnchorPublisher;
    if(!publisher || !row) return false;
    try {
        const shape = rewardShape(row);
        const signatures = parseSignatures(row.publisher_attestations);
        if(!shape || !signatures) return false;
        const network = String(row.network || '');
        if(!network) return false;
        const set = await publisher.resolveCapabilitySet(
            'oracle_publish', shape.snapshotBlock, resolveQuorumNetwork(row, publisher.network));
        const pubkeys = new Set((set || []).map(v => String(v.pubkey).toLowerCase()));
        if(pubkeys.size === 0 || !pubkeys.has(shape.publisher)) return false;
        const identity = { network, snapshot_block: shape.snapshotBlock };
        const canonical = shape.rewardType === 'anchor_archive'
            ? publisher.archiveAttestationCanonical(identity, shape.roundReference, shape.publisher)
            : publisher.attestationCanonical(identity, shape.publisher);
        const signers = verifiedSigners(signatures, pubkeys, canonical);
        return publisher.federationQuorumMet(
            set, pubkeys, signers, network, shape.snapshotBlock);
    } catch(_e){
        return false;
    }
}

module.exports = { verifyAnchorRewardCatchupRow };
