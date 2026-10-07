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
 **********************************************************************
 *
 * Reorg handler - snapshot-lock activation and pure snapshot helpers
 *
 * The new wire stamp stays dark on deployed networks until a coordinated
 * height is assigned. Regtest exercises the locked protocol from genesis.
 *
 ********************************************************************/

'use strict';

const { bftQuorumOrSingle } = require('../../lib/bft_quorum.js');

const PUBKEY_RE = /^[0-9a-f]{64}$/;
const UNARMED_HEIGHT = 9999999999;

const REORG_SNAPSHOT_ACTIVATION = Object.freeze({
    mainnet: UNARMED_HEIGHT,
    testnet: UNARMED_HEIGHT,
    regtest: 0
});

const REORG_SNAPSHOT_TOLERANCE_BLOCKS = 144;

function readHeight(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        let parsed = Number(value.trim());
        if (Number.isSafeInteger(parsed)) return parsed;
    }
    return null;
}

function isReorgSnapshotActive(blockHeight, network) {
    let height = readHeight(blockHeight);
    let threshold = REORG_SNAPSHOT_ACTIVATION[String(network || '').toLowerCase()];
    return height !== null && Number.isSafeInteger(threshold) && height >= threshold;
}

function isReorgSnapshotRatified(network) {
    let threshold = REORG_SNAPSHOT_ACTIVATION[String(network || '').toLowerCase()];
    return Number.isSafeInteger(threshold) && threshold < UNARMED_HEIGHT;
}

function snapshotMemberPubkeys(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.validators)) return null;
    let members = new Set();
    for (let validator of snapshot.validators) {
        let pubkey = String(validator && validator.pubkey || '').toLowerCase();
        if (!PUBKEY_RE.test(pubkey)) return null;
        members.add(pubkey);
    }
    return members;
}

function snapshotQuorum(members) {
    if (!(members instanceof Set)) return null;
    return bftQuorumOrSingle(members.size, 0);
}

function isPubkey(value) {
    return PUBKEY_RE.test(String(value || '').toLowerCase());
}

module.exports = {
    REORG_SNAPSHOT_ACTIVATION,
    REORG_SNAPSHOT_TOLERANCE_BLOCKS,
    readHeight,
    isReorgSnapshotActive,
    isReorgSnapshotRatified,
    snapshotMemberPubkeys,
    snapshotQuorum,
    isPubkey
};
