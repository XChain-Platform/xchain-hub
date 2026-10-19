'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const SNAPSHOT_SIGNED_MEMORY = 512;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;

function entryFrom(cp) {
    try {
        if(!cp || typeof cp !== 'object' || cp.chain !== 'BTC' ||
            typeof cp.network !== 'string' || cp.network.length === 0 ||
            !Number.isSafeInteger(cp.block_index) || cp.block_index < 0 ||
            typeof cp.block_hash !== 'string' || !HASH_PATTERN.test(cp.block_hash) ||
            typeof cp.state_root !== 'string' || !HASH_PATTERN.test(cp.state_root)) {
            return null;
        }
        return {
            key: cp.network + '|' + cp.block_index,
            payload: {
                block_hash: cp.block_hash.toLowerCase(),
                state_root: cp.state_root.toLowerCase(),
                state_root_version: Number(cp.state_root_version),
            },
        };
    } catch(e) {
        return null;
    }
}

function createSnapshotSignedRecord(memory = SNAPSHOT_SIGNED_MEMORY) {
    if(!Number.isSafeInteger(memory) || memory <= 0) {
        throw new TypeError('memory must be a positive safe integer');
    }

    const records = new Map();

    function claim(cp) {
        const entry = entryFrom(cp);
        if(entry === null) return false;

        const held = records.get(entry.key);
        if(held !== undefined) {
            return held.block_hash === entry.payload.block_hash &&
                held.state_root === entry.payload.state_root &&
                held.state_root_version === entry.payload.state_root_version;
        }

        records.set(entry.key, entry.payload);
        while(records.size > memory) records.delete(records.keys().next().value);
        return true;
    }

    function held(network, blockIndex) {
        if(typeof network !== 'string' || network.length === 0 ||
            !Number.isSafeInteger(blockIndex) || blockIndex < 0) return null;
        const payload = records.get(network + '|' + blockIndex);
        return payload === undefined ? null : Object.assign({}, payload);
    }

    function size() {
        return records.size;
    }

    return { claim, held, size };
}

module.exports = { SNAPSHOT_SIGNED_MEMORY, createSnapshotSignedRecord };
