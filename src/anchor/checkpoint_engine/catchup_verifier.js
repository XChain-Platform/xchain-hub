'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const ValidatorIdentity = require('../../validators/identity.js');
const swq = require('../../consensus/stake_weighted_quorum.js');
const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');
const canonicalForms = require('./canonical_forms.js');
const checkpointMethods = require('./sign.js');
const { refusal, validatorLookupFailure } = require('../../peers/hub_db/catchup_verdicts.js');

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

// The verified, deduplicated member signatures in wire order, shaped exactly as the
// finalize path persists them.
function verifiedSignatures(signatures, validators, canonical){
    const members = new Set(validators.map(v => String(v.pubkey).toLowerCase()));
    const seen = new Set();
    const verified = [];
    for(const signature of signatures){
        const pubkey = String(signature && signature.pubkey || '').toLowerCase();
        if(!pubkey || seen.has(pubkey) || !members.has(pubkey)) continue;
        if(!ValidatorIdentity.verify(canonical, String(signature.sig || ''), pubkey)) continue;
        seen.add(pubkey);
        verified.push({ pubkey, sig: String(signature.sig) });
    }
    return verified;
}

// The row to persist uses the normalized checkpoint and only verified signatures.
// Commitment roots below their gate remain unsigned wire values; archive comparison
// ignores those columns there while retaining the fixed DB shape.
function canonicalRow(row, checkpoint, verified){
    return Object.assign({}, row, checkpoint, {
        state_root: checkpoint.state_root || null,
        block_merkle_root: checkpoint.block_merkle_root || null,
        rules_digest: checkpoint.rules_digest || null,
        validator_signatures: JSON.stringify(verified)
    });
}

function hubFromContext(context){
    if(!context) return null;
    if(context.hub) return context.hub;
    return context.stateCheckpoints ? context : null;
}

function checkpointEngine(context){
    const hub = hubFromContext(context);
    return hub && hub.stateCheckpoints;
}

function normalizeValidators(rows){
    const validators = (rows || []).map(row => ({
        pubkey: String(row && (row.pubkey || row.signing_pubkey) || '').toLowerCase(),
        source: String(row && row.source != null ? row.source : ''),
        weight: String(row && row.weight != null ? row.weight : row && row.amount)
    }));
    if(rows && rows.truncated === true) validators.truncated = true;
    return validators;
}

async function resolveValidators(context, engine, snapshotBlock){
    if(context && typeof context.resolveCapabilityValidators === 'function')
        return normalizeValidators(await context.resolveCapabilityValidators('oracle_publish', snapshotBlock));
    if(engine && typeof engine.resolveCapabilityValidators === 'function')
        return normalizeValidators(await engine.resolveCapabilityValidators('oracle_publish', snapshotBlock));
    const hub = hubFromContext(context);
    const db = (context && context.db) || (hub && hub.db);
    if(!db || typeof db.findCapabilitySnapshotsBySnapshotBlock !== 'function') return [];
    return normalizeValidators(await db.findCapabilitySnapshotsBySnapshotBlock(snapshotBlock, 'oracle_publish'));
}

async function verifyStateCheckpointCatchupRow(row, context){
    if(!row) return refusal('malformed state checkpoint row');
    try {
        const engine = checkpointEngine(context);
        const deploymentNetwork = context && context.network != null ? String(context.network) : '';
        const normalize = engine && typeof engine.normalizeCheckpoint === 'function'
            ? engine.normalizeCheckpoint : checkpointMethods.normalizeCheckpoint;
        const normalized = normalize.call(engine || {}, row);
        const signatures = parseSignatures(row.validator_signatures);
        if(!normalized) return refusal('malformed state checkpoint row');
        if(!signatures) return refusal('malformed state checkpoint signatures');
        const checkpoint = Object.assign({}, normalized, {
            supersedes_from: row.supersedes_from == null ? null : Number(row.supersedes_from),
            rules_digest: row.rules_digest == null ? null : String(row.rules_digest).toLowerCase()
        });
        if(engine && typeof engine.assertCheckpointNetwork === 'function')
            engine.assertCheckpointNetwork(checkpoint, 'catch-up');
        else if(deploymentNetwork && checkpoint.network !== deploymentNetwork)
            return refusal('checkpoint network does not match deployment network');
        if(Number(checkpoint.checkpoint_seq) !== canonicalForms.deriveCheckpointSeq(checkpoint.snapshot_block))
            return refusal('checkpoint sequence does not match snapshot block');
        if(canonicalForms.isRootless(checkpoint))
            return refusal('checkpoint has no required light-client roots');
        let validators;
        try {
            validators = await resolveValidators(context, engine, checkpoint.snapshot_block);
        } catch(error){
            return validatorLookupFailure(checkpoint.snapshot_block, error);
        }
        if(!Array.isArray(validators) || validators.length === 0)
            return refusal('no local validator set for snapshot_block ' + Number(checkpoint.snapshot_block));
        if(validators.truncated === true)
            return refusal('local validator set is truncated');
        const verified = verifiedSignatures(signatures, validators, canonicalForms.canonicalCheckpoint(checkpoint));
        const signers = new Set(verified.map(entry => entry.pubkey));
        // Catch-up gates quorum on the record's network when the hub has none, the rule the indexer
        // applies; the engine only supplies the network guard and the validator set here.
        const quorumNetwork = (engine ? String(engine.network || '') : deploymentNetwork) || checkpoint.network;
        const quorumMet = swq.isStakeWeightedQuorumActive(checkpoint.snapshot_block, quorumNetwork)
            ? swq.meetsStakeThreshold(validators, signers)
            : signers.size >= bftQuorumOrSingle(validators.length, 1);
        return quorumMet ? { ok: true, row: canonicalRow(row, checkpoint, verified) } : refusal('checkpoint signatures do not meet quorum');
    } catch(error){
        return refusal(error && error.message ? error.message : String(error));
    }
}

module.exports = { verifyStateCheckpointCatchupRow };
