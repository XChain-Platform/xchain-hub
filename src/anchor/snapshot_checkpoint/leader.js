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

const SNAPSHOT_LEADER_SKIP = Object.freeze({
    INVALID_BLOCK: 'invalid_block',
    EMPTY_VALIDATOR_SET: 'empty_validator_set',
    INVALID_IDENTITY: 'invalid_identity',
    NOT_VALIDATOR: 'not_validator',
    MISSING_DEPTH: 'missing_depth',
    FALLBACK_WAIT: 'fallback_wait',
});

// The validator keys in rotation order: distinct, lowercased and sorted.
function rotationOrder(validators) {
    return [...new Set(validators.map(validator =>
        String(validator && validator.pubkey).toLowerCase()
    ).filter(Boolean))].sort();
}

// How many places after the turn hub this key sits for the block: 0 is the turn hub,
// 1 the first fallback. Null when the inputs are unusable or the key is not in the set.
function snapshotLeaderRank(blockIndex, validators, myPubkeyHex) {
    if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) return null;
    if (!Array.isArray(validators) || validators.length === 0) return null;
    if (typeof myPubkeyHex !== 'string' || myPubkeyHex.length === 0) return null;

    const pubkeys = rotationOrder(validators);
    const myIndex = pubkeys.indexOf(myPubkeyHex.toLowerCase());
    if (myIndex < 0) return null;
    return (myIndex - blockIndex % pubkeys.length + pubkeys.length) % pubkeys.length;
}

function leadsSnapshotSlot(blockIndex, validators, myPubkeyHex) {
    return snapshotLeaderRank(blockIndex, validators, myPubkeyHex) === 0;
}

// The full selection result lets the engine distinguish an invalid local view from a
// healthy fallback rank that has not unlocked yet. Co-sign policy keeps consuming the
// boolean wrapper below, so both paths still enforce this one threshold calculation.
function snapshotLeaderDecision(blockIndex, validators, myPubkeyHex, overdueBlocks) {
    if (!Number.isSafeInteger(blockIndex) || blockIndex < 0)
        return { leads: false, rank: null, reason: SNAPSHOT_LEADER_SKIP.INVALID_BLOCK };
    if (!Array.isArray(validators) || rotationOrder(validators).length === 0)
        return { leads: false, rank: null, reason: SNAPSHOT_LEADER_SKIP.EMPTY_VALIDATOR_SET };
    if (typeof myPubkeyHex !== 'string' || myPubkeyHex.length === 0)
        return { leads: false, rank: null, reason: SNAPSHOT_LEADER_SKIP.INVALID_IDENTITY };

    const rank = snapshotLeaderRank(blockIndex, validators, myPubkeyHex);
    if (rank === null)
        return { leads: false, rank: null, reason: SNAPSHOT_LEADER_SKIP.NOT_VALIDATOR };
    if (rank === 0) return { leads: true, rank, reason: null, waitBlocks: 0 };

    const unlockBlocks = rank * SNAPSHOT_FALLBACK_STEP_BLOCKS;
    if (!Number.isSafeInteger(overdueBlocks)) {
        return {
            leads: false,
            rank,
            reason: SNAPSHOT_LEADER_SKIP.MISSING_DEPTH,
            waitBlocks: unlockBlocks,
        };
    }
    if (overdueBlocks < unlockBlocks) {
        return {
            leads: false,
            rank,
            reason: SNAPSHOT_LEADER_SKIP.FALLBACK_WAIT,
            waitBlocks: unlockBlocks - overdueBlocks,
        };
    }
    return { leads: true, rank, reason: null, waitBlocks: 0 };
}

// Whether this key may lead the block's round now: the turn hub always, and the key k
// places after it once overdueBlocks (local BTC tip minus block minus confirmations)
// reaches k steps, so an offline turn hub cannot stall this snapshot and every later one.
function mayLeadSnapshotSlot(blockIndex, validators, myPubkeyHex, overdueBlocks) {
    return snapshotLeaderDecision(
        blockIndex, validators, myPubkeyHex, overdueBlocks
    ).leads;
}

module.exports = {
    SNAPSHOT_FALLBACK_STEP_BLOCKS,
    SNAPSHOT_LEADER_SKIP,
    leadsSnapshotSlot,
    mayLeadSnapshotSlot,
    snapshotLeaderDecision,
    snapshotLeaderRank,
};
