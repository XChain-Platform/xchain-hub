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
 *********************************************************************/

'use strict';

const { snapshotCheckpointQuorum } = require('../../consensus/snapshot_checkpoint/canonical.js');

const HEX_64 = /^[0-9a-f]{64}$/i;
const FINALIZE_REFUSAL = Object.freeze({
    MALFORMED: 'malformed',
    GATE_INACTIVE: 'gate_inactive',
    WRONG_BLOCK: 'wrong_block',
    BELOW_QUORUM: 'below_quorum',
    CONFLICTING_PAYLOAD: 'conflicting_payload',
});

function nonnegativeSafeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function malformed(msg, view) {
    if (!msg || !msg.cp || !view) return true;
    const cp = msg.cp;
    const version = Number(cp.state_root_version);
    return !nonnegativeSafeInteger(msg.snapshot_block) ||
        cp.chain !== 'BTC' ||
        cp.network !== view.network ||
        !nonnegativeSafeInteger(cp.block_index) ||
        !HEX_64.test(cp.block_hash) ||
        !HEX_64.test(cp.state_root) ||
        !nonnegativeSafeInteger(version) ||
        !Array.isArray(msg.signatures);
}

function storedPayloadDiffers(stored, cp) {
    return String(stored.block_hash).toLowerCase() !== cp.block_hash.toLowerCase() ||
        String(stored.state_root).toLowerCase() !== cp.state_root.toLowerCase() ||
        Number(stored.state_root_version) !== Number(cp.state_root_version);
}

// Return the first reason this finalized snapshot checkpoint must not persist.
function snapshotFinalizedRefusal(msg, view) {
    try {
        if (malformed(msg, view)) return FINALIZE_REFUSAL.MALFORMED;
        if (view.gateActive !== true) return FINALIZE_REFUSAL.GATE_INACTIVE;
        if (msg.cp.block_index !== view.expectedBlock) return FINALIZE_REFUSAL.WRONG_BLOCK;

        const signedCheckpoint = Object.assign({}, msg.cp, { validator_signatures: msg.signatures });
        if (!snapshotCheckpointQuorum(signedCheckpoint, view.trustSet, view.verify))
            return FINALIZE_REFUSAL.BELOW_QUORUM;
        if (view.stored && storedPayloadDiffers(view.stored, msg.cp))
            return FINALIZE_REFUSAL.CONFLICTING_PAYLOAD;
        return null;
    } catch (e) {
        return FINALIZE_REFUSAL.MALFORMED;
    }
}

module.exports = { FINALIZE_REFUSAL, snapshotFinalizedRefusal };
