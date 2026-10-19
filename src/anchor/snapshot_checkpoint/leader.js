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
 * Snapshot checkpoint leader selection
 *
 ********************************************************************/

'use strict';

// Each fallback rank waits this many BTC blocks past the snapshot's due height before it
// may lead. Leader and co-signers both judge it from their own BTC tip, so every hub
// must run the same value or a stricter co-signer refuses every fallback round.
const SNAPSHOT_FALLBACK_STEP_BLOCKS = 2;

// The validator keys in rotation order: distinct, lowercased and sorted.
function rotationOrder(validators) {
    return [...new Set(validators.map(validator =>
        String(validator && validator.pubkey).toLowerCase()
    ))].sort();
}

// How many places after the turn hub this key sits for the block: 0 is the turn hub,
// 1 the first fallback. Null when the inputs are unusable or the key is not in the set.
function snapshotLeaderRank(blockIndex, validators, myPubkeyHex) {
    if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) return null;
    if (!Array.isArray(validators) || validators.length === 0) return null;
    if (typeof myPubkeyHex !== 'string' || myPubkeyHex.length === 0) return null;

    let pubkeys = rotationOrder(validators);
    let myIndex = pubkeys.indexOf(myPubkeyHex.toLowerCase());
    if (myIndex < 0) return null;
    return (myIndex - blockIndex % pubkeys.length + pubkeys.length) % pubkeys.length;
}

function leadsSnapshotSlot(blockIndex, validators, myPubkeyHex) {
    return snapshotLeaderRank(blockIndex, validators, myPubkeyHex) === 0;
}

// Whether this key may lead the block's round now: the turn hub always, and the key k
// places after it once overdueBlocks (local BTC tip minus block minus confirmations)
// reaches k steps, so an offline turn hub cannot stall this snapshot and every later one.
function mayLeadSnapshotSlot(blockIndex, validators, myPubkeyHex, overdueBlocks) {
    const rank = snapshotLeaderRank(blockIndex, validators, myPubkeyHex);
    if (rank === null) return false;
    if (rank === 0) return true;
    return Number.isSafeInteger(overdueBlocks) &&
        overdueBlocks >= rank * SNAPSHOT_FALLBACK_STEP_BLOCKS;
}

module.exports = {
    SNAPSHOT_FALLBACK_STEP_BLOCKS,
    leadsSnapshotSlot,
    mayLeadSnapshotSlot,
    snapshotLeaderRank,
};
