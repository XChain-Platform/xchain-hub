'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { mayLeadSnapshotSlot } = require('./leader.js');
const {
    snapshotCheckpointCanonical,
} = require('../../consensus/snapshot_checkpoint/canonical.js');

const HEX_64 = /^[0-9a-f]{64}$/i;
const HEX_128 = /^[0-9a-f]{128}$/i;
const SIGN_REQUEST_REFUSAL = Object.freeze({
    MALFORMED: 'malformed',
    NOT_LEADER: 'not_leader',
    BAD_LEADER_SIGNATURE: 'bad_leader_signature',
});

function signCheckpoint(identity, snapshotBlock, cp) {
    if (!identity || typeof identity.sign !== 'function' ||
        typeof identity.getPubkeyHex !== 'function') {
        throw new TypeError('identity must provide sign and getPubkeyHex functions');
    }
    if (!Number.isSafeInteger(snapshotBlock) || snapshotBlock < 0)
        throw new TypeError('snapshotBlock must be a non-negative safe integer');

    const canonical = snapshotCheckpointCanonical(cp);
    return {
        pubkey: identity.getPubkeyHex().toLowerCase(),
        sig: identity.sign(canonical),
    };
}

function buildSnapshotSignReply(identity, snapshotBlock, cp) {
    const signed = signCheckpoint(identity, snapshotBlock, cp);
    return {
        snapshot_block: snapshotBlock,
        block_index: cp.block_index,
        pubkey: signed.pubkey,
        sig: signed.sig,
    };
}

function buildSnapshotSignRequest(identity, snapshotBlock, cp) {
    const signed = signCheckpoint(identity, snapshotBlock, cp);
    return {
        snapshot_block: snapshotBlock,
        cp: {
            chain: cp.chain,
            network: cp.network,
            block_index: cp.block_index,
            block_hash: cp.block_hash,
            state_root: cp.state_root,
            state_root_version: cp.state_root_version,
        },
        pubkey: signed.pubkey,
        sig: signed.sig,
    };
}

// overdueBlocks is how far this co-signer's BTC tip sits past the request's due height;
// left out, only the turn hub may lead, as before the fallback existed.
function snapshotSignRequestRefusal(req, validators, verify, overdueBlocks) {
    let canonical;
    let blockIndex;
    let pubkey;
    let sig;
    try {
        if (!req) return SIGN_REQUEST_REFUSAL.MALFORMED;
        const cp = req.cp;
        const snapshotBlock = req.snapshot_block;
        const pubkeyValue = req.pubkey;
        sig = req.sig;
        if (!cp || !Number.isSafeInteger(snapshotBlock) || snapshotBlock < 0 ||
            typeof pubkeyValue !== 'string' || !HEX_64.test(pubkeyValue) ||
            typeof sig !== 'string' || !HEX_128.test(sig)) {
            return SIGN_REQUEST_REFUSAL.MALFORMED;
        }
        canonical = snapshotCheckpointCanonical(cp);
        blockIndex = cp.block_index;
        pubkey = pubkeyValue.toLowerCase();
    } catch (e) {
        return SIGN_REQUEST_REFUSAL.MALFORMED;
    }

    try {
        if (mayLeadSnapshotSlot(blockIndex, validators, pubkey, overdueBlocks) !== true)
            return SIGN_REQUEST_REFUSAL.NOT_LEADER;
    } catch (e) {
        return SIGN_REQUEST_REFUSAL.NOT_LEADER;
    }

    try {
        if (typeof verify !== 'function' || verify(canonical, sig, pubkey) !== true)
            return SIGN_REQUEST_REFUSAL.BAD_LEADER_SIGNATURE;
    } catch (e) {
        return SIGN_REQUEST_REFUSAL.BAD_LEADER_SIGNATURE;
    }
    return null;
}

module.exports = {
    SIGN_REQUEST_REFUSAL,
    buildSnapshotSignReply,
    buildSnapshotSignRequest,
    snapshotSignRequestRefusal,
};
