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
const STAMP_NEWEST_NULL_SNAPSHOT =
    'UPDATE capability_snapshots cs JOIN (' +
    'SELECT MAX(snapshot_block) AS snapshot_block FROM capability_snapshots ' +
    'WHERE btc_chain_id IS NULL' +
    ') newest ON newest.snapshot_block = cs.snapshot_block ' +
    'SET cs.btc_chain_id = ? WHERE cs.btc_chain_id IS NULL';
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

async function stampNewestNullSnapshot(db, chainId) {
    if (typeof db.doQuery === 'function')
        return db.doQuery(STAMP_NEWEST_NULL_SNAPSHOT, [chainId]);
    if (typeof db.stampNullCapabilitySnapshotChainId === 'function')
        return db.stampNullCapabilitySnapshotChainId(chainId);
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
    if (regtest && engine.chainIdBackfill !== resolved) {
        await stampNewestNullSnapshot(db, resolved);
        engine.chainIdBackfill = resolved;
    }
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

if (require.main === module) {
    const assert = require('node:assert/strict');
    const test = require('node:test');
    const SnapshotCheckpointEngine = require('./engine.js');

    test('leads the current slot at its first eligible block with a 100-slot backlog', async () => {
        const chainId = 'a'.repeat(64);
        const pubkey = '1'.repeat(64);
        const capabilityRows = Array.from({ length: 100 }, (_, offset) => ({
            snapshot_block: 400 + offset,
            btc_chain_id: null,
        }));
        const checkpoints = new Map();
        let storedChainId = null;
        const db = {
            async getChainId() { return storedChainId; },
            async setChainId(coin, network, value) {
                assert.equal(coin, 'BTC');
                assert.equal(network, 'regtest');
                storedChainId = value;
            },
            async doQuery(sql, args) {
                assert.match(sql, /MAX\(snapshot_block\)/);
                const newest = Math.max(...capabilityRows
                    .filter(row => row.btc_chain_id === null)
                    .map(row => row.snapshot_block));
                for (const row of capabilityRows) {
                    if (row.snapshot_block === newest && row.btc_chain_id === null)
                        row.btc_chain_id = args[0];
                }
            },
            async listUncheckpointedSnapshotBlocks(network, from, burial, limit) {
                assert.equal(network, 'regtest');
                return [...new Set(capabilityRows
                    .filter(row => row.snapshot_block >= from && row.btc_chain_id === storedChainId)
                    .filter(row => !checkpoints.has(row.snapshot_block - burial))
                    .map(row => row.snapshot_block))]
                    .sort((left, right) => left - right)
                    .slice(0, limit)
                    .map(snapshotBlock => ({ snapshot_block: snapshotBlock }));
            },
            async getSnapshotCheckpoint(chain, network, blockIndex) {
                assert.equal(chain, 'BTC');
                assert.equal(network, 'regtest');
                return checkpoints.get(blockIndex) || null;
            },
            async insertSnapshotCheckpoint(checkpoint) {
                checkpoints.set(checkpoint.block_index, checkpoint);
                return true;
            },
        };
        const engine = new SnapshotCheckpointEngine({
            db,
            network: 'regtest',
            confirmations: 6,
            identity: {
                getPubkeyHex: () => pubkey,
                sign: () => 'f'.repeat(128),
            },
            resolveSnapshotBlock: async () => 499,
            resolveCapabilityValidators: async () => [{ pubkey }],
            indexerCall: async (chain, method, params) => {
                assert.equal(chain, 'BTC');
                assert.equal(method, 'getblockhashes');
                return params.block_index === 1
                    ? { coin: 'BTC', network: 'regtest', block_index: 1, block_hash: chainId }
                    : {
                        block_index: params.block_index,
                        block_hash: 'b'.repeat(64),
                        state_root: 'c'.repeat(64),
                        state_root_version: 1,
                    };
            },
        });

        await engine.tick();

        assert.deepEqual([...checkpoints.keys()], [493]);
        assert.equal(capabilityRows.filter(row => row.btc_chain_id === chainId).length, 1);
    });
}
