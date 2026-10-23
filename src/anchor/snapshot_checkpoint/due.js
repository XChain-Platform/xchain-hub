'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const DUE_SCAN_LIMIT = 10;

function asSnapshotBlock(value) {
    if (value === null || value === undefined) return null;

    let block;
    try {
        block = Number(value);
    } catch (_) {
        return null;
    }
    return Number.isSafeInteger(block) && block >= 0 ? block : null;
}

function asFiniteNumber(value) {
    let number;
    try {
        number = Number(value);
    } catch (_) {
        return null;
    }
    return Number.isFinite(number) ? number : null;
}

function pickDueSnapshot(snapshotBlocks, view) {
    if (!Array.isArray(snapshotBlocks) || view.inFlight) return null;

    const newestFirst = snapshotBlocks.length >= DUE_SCAN_LIMIT;
    let snapshotBlock = null;
    for (const value of snapshotBlocks) {
        const candidate = asSnapshotBlock(value);
        if (candidate === null || !view.gateActive(candidate)) continue;
        const preferred = newestFirst
            ? candidate > snapshotBlock
            : candidate < snapshotBlock;
        if (snapshotBlock === null || preferred) snapshotBlock = candidate;
    }
    if (snapshotBlock === null) return null;

    const blockIndex = view.blockOf(snapshotBlock);
    if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) return null;

    const btcTip = asFiniteNumber(view.btcTip);
    const confirmations = asFiniteNumber(view.confirmations);
    if (btcTip === null || confirmations === null || btcTip < blockIndex + confirmations) return null;

    return { snapshot_block: snapshotBlock, block_index: blockIndex };
}

module.exports = { pickDueSnapshot };
