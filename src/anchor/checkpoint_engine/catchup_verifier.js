'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const ValidatorIdentity = require('../../validators/identity.js');
const swq = require('../../consensus/stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const canonicalForms = require('./canonical_forms.js');

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

function validSigners(signatures, validators, canonical){
    const members = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
    const seen = new Set();
    for(const signature of signatures){
        const pubkey = String(signature && signature.pubkey || '').toLowerCase();
        if(!pubkey || seen.has(pubkey) || !members.has(pubkey)) continue;
        if(!ValidatorIdentity.verify(canonical, String(signature.sig || ''), pubkey)) continue;
        seen.add(pubkey);
    }
    return seen;
}

async function verifyStateCheckpointCatchupRow(row, hub){
    const engine = hub && hub.stateCheckpoints;
    if(!engine || !row) return false;
    try {
        const checkpoint = engine.normalizeCheckpoint(row);
        const signatures = parseSignatures(row.validator_signatures);
        if(!checkpoint || !signatures) return false;
        engine.assertCheckpointNetwork(checkpoint, 'catch-up');
        if(Number(checkpoint.checkpoint_seq) !== canonicalForms.deriveCheckpointSeq(checkpoint.snapshot_block)) return false;
        if(canonicalForms.isRootless(checkpoint)) return false;
        const validators = await engine.resolveCapabilityValidators('oracle_publish', checkpoint.snapshot_block);
        if(!Array.isArray(validators) || validators.length === 0) return false;
        const signers = validSigners(signatures, validators, canonicalForms.canonicalCheckpoint(checkpoint));
        if(swq.isStakeWeightedQuorumActive(checkpoint.snapshot_block, engine.network))
            return swq.meetsStakeThreshold(validators, signers);
        return signers.size >= bftQuorumOrSingle(validators.length, 1);
    } catch(_e){
        return false;
    }
}

module.exports = { verifyStateCheckpointCatchupRow };
