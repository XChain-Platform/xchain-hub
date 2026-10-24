'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const COSIGN_REFUSAL = Object.freeze({
    MALFORMED: 'malformed',
    GATE_INACTIVE: 'gate_inactive',
    WRONG_BLOCK: 'wrong_block',
    SHALLOW: 'shallow',
    LOCAL_MISMATCH: 'local_mismatch',
    CONFLICTING_PAYLOAD: 'conflicting_payload'
});

const HASH_PATTERN = /^[0-9a-f]{64}$/i;

function validRequest(req, view) {
    if(!req || !req.cp) return false;
    const cp = req.cp;
    return Number.isSafeInteger(req.snapshot_block) && req.snapshot_block >= 0 &&
        cp.chain === 'BTC' && cp.network === view.network &&
        Number.isSafeInteger(cp.block_index) && cp.block_index >= 0 &&
        typeof cp.block_hash === 'string' && HASH_PATTERN.test(cp.block_hash) &&
        typeof cp.state_root === 'string' && HASH_PATTERN.test(cp.state_root);
}

function payloadDiffers(payload, cp) {
    if(!payload) return true;
    return typeof payload.block_hash !== 'string' ||
        payload.block_hash.toLowerCase() !== cp.block_hash.toLowerCase() ||
        typeof payload.state_root !== 'string' ||
        payload.state_root.toLowerCase() !== cp.state_root.toLowerCase() ||
        Number(payload.state_root_version) !== Number(cp.state_root_version);
}

function snapshotCosignRefusal(req, view) {
    view = view || {};
    if(!validRequest(req, view)) return COSIGN_REFUSAL.MALFORMED;

    const cp = req.cp;
    if(view.gateActive === false) return COSIGN_REFUSAL.GATE_INACTIVE;
    if(cp.block_index !== view.expectedBlock) return COSIGN_REFUSAL.WRONG_BLOCK;
    if(!(Number(view.committedHeight) >= cp.block_index + Number(view.confirmations)) ||
        !(Number(view.chainHeight) >= cp.block_index + Number(view.confirmations))) {
        return COSIGN_REFUSAL.SHALLOW;
    }
    if(payloadDiffers(view.local, cp)) return COSIGN_REFUSAL.LOCAL_MISMATCH;
    if(view.signed != null && payloadDiffers(view.signed, cp)) {
        return COSIGN_REFUSAL.CONFLICTING_PAYLOAD;
    }
    if(view.stored != null && payloadDiffers(view.stored, cp)) {
        return COSIGN_REFUSAL.CONFLICTING_PAYLOAD;
    }
    return null;
}

module.exports = { COSIGN_REFUSAL, snapshotCosignRefusal };
