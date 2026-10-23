'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The BTC chain identity (the hash of block 1 on the chain this hub's BTC indexer follows)
// learned from that indexer directly. The indexer pushes the same value with its chain tip,
// but only to one hub; every other hub never stored it, so every capability set it wrote
// carried btc_chain_id NULL, the uncheckpointed-snapshot scan (which joins on the id) found
// nothing due, and the hub never led its own checkpoint slots. Reading it here gives every
// hub with a BTC indexer the id the pushed hub has, whether or not anything pushes to it.

const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');

const logger = getLogger();
const HEX_64 = /^[0-9a-f]{64}$/;
// Block 1 only changes when a regtest chain is re-genesised, so a minute between reads
// keeps a stuck or absent indexer to one call a minute however often the engine ticks.
const REREAD_MS = 60000;

// The id the indexer reports for block 1, lowercased, or null on any fault or on a reply
// for another block, coin or network (an indexer that does not hold block 1 answers with
// an error object, which also lands here as null).
async function readIndexerChainId(engine) {
    let block;
    try {
        block = await engine.indexerCall('getblockhashes', { block_index: 1 });
    } catch (_) {
        return null;
    }
    if (!block || typeof block !== 'object' || Number(block.block_index) !== 1) return null;
    if (block.coin && String(block.coin).toUpperCase() !== 'BTC') return null;
    if (block.network && block.network !== engine.network) return null;
    const hash = typeof block.block_hash === 'string' ? block.block_hash.toLowerCase() : '';
    return HEX_64.test(hash) ? hash : null;
}

// A regtest chain re-genesised under the same network name leaves the dead chain's rows
// behind; drop them before storing the new id, exactly as pushchaintip does on the hub
// the indexer pushes to (src/api/rpc/feed.js). Testnet and mainnet never purge.
async function purgeDeadChainRows(db, network) {
    if (typeof db.deleteCrossChainMatchesByNetwork === 'function')
        await db.deleteCrossChainMatchesByNetwork(network);
    if (typeof db.deleteCrossChainCallsByNetwork === 'function')
        await db.deleteCrossChainCallsByNetwork(network);
    if (typeof db.deleteAllCapabilitySnapshots === 'function')
        await db.deleteAllCapabilitySnapshots();
}

async function adoptChainId(engine, stored, resolved) {
    const db = engine.db;
    const regtest = engine.network === 'regtest';
    if (resolved !== stored) {
        if (stored && regtest) await purgeDeadChainRows(db, engine.network);
        await db.setChainId('BTC', engine.network, resolved);
        logger.info('SnapshotCheckpointEngine: BTC/' + engine.network + ' chain id ' +
            resolved.slice(0, 12) + ' read from the BTC indexer' +
            (stored ? ' (was ' + stored.slice(0, 12) + ')' : ''));
    }
    // Regtest only, as on the pushed hub: a set written before the id was known is this
    // chain's, and left NULL its snapshot would never be checkpointed.
    if (regtest && typeof db.stampNullCapabilitySnapshotChainId === 'function')
        await db.stampNullCapabilitySnapshotChainId(resolved);
}

// Resolves the id used on cross-chain rows and snapshot envelopes. A pushed tip is the
// first source for compatibility with existing hubs; followers that receive no tip use
// the standalone chain id learned from their own BTC indexer.
async function resolveBtcChainId(db, network) {
    if (!db) return null;
    if (typeof db.getChainTip === 'function') {
        try {
            const tip = await db.getChainTip('bitcoin', network);
            if (tip && tip.chainId) return tip.chainId;
        } catch (_) { /* the standalone id can still be readable */ }
    }
    if (typeof db.getChainId === 'function') {
        try {
            return (await db.getChainId('bitcoin', network)) || null;
        } catch (_) { /* an unreadable identity remains unknown */ }
    }
    return null;
}

// Stores the indexer's id when it is new or changed and returns the id now in force (the
// stored one when the read fails or is not due yet). Never throws: an unknown id only
// leaves the scan as it was. A db without the id methods is left alone.
async function learnBtcChainId(engine) {
    const db = engine && engine.db;
    if (!db || typeof db.getChainId !== 'function' || typeof db.setChainId !== 'function')
        return null;
    try {
        const stored = await db.getChainId('BTC', engine.network);
        const now = Date.now();
        if (engine.chainIdReadAt !== undefined && now - engine.chainIdReadAt < REREAD_MS)
            return stored;
        engine.chainIdReadAt = now;
        const resolved = await readIndexerChainId(engine);
        if (!resolved) return stored;
        await adoptChainId(engine, stored, resolved);
        return resolved;
    } catch (error) {
        logger.warn(nodeUtil.format(
            'SnapshotCheckpointEngine: could not store the BTC chain id:', error && error.message));
        return null;
    }
}

module.exports = { learnBtcChainId, readIndexerChainId, resolveBtcChainId, REREAD_MS };
