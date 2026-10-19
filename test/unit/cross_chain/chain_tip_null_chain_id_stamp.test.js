'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// A regtest hub can write its first capability snapshot while its BTC indexer is still
// catching up and has not pushed a chain tip, so the row is stamped btc_chain_id NULL.
// The snapshot checkpoint search joins on btc_chain_id, so that block was never
// checkpointed, its proof stayed unavailable, and every proof-gated LTC and DOGE mirror
// held the row (and its own block loop) forever. The first tip push carrying the id now
// stamps those rows, and the block checkpoints on the next tick.

const sinon = require('sinon');
const { expect } = require('chai');
const { buildFeedRpc } = require('../../../src/api/rpc/feed');
const capabilityDb = require('../../../src/db/snapshots/capability_snapshots');
const snapWrite = require('../../../src/lib/capability_snapshot_write.js');
const SnapshotCheckpointEngine = require('../../../src/anchor/snapshot_checkpoint/engine.js');

const CHAIN_ID = '0a'.repeat(32);
const HUB_KEY = '1'.repeat(64);

// An in-memory hub database with the three behaviours the path depends on: the row
// writer, the chain tip, and listUncheckpointedSnapshotBlocks' join on the chain id.
function memoryHub(network = 'regtest') {
    const rows = [];
    const checkpoints = new Map();
    let tip = null;
    const db = {
        rows,
        checkpoints,
        getChainTip: sinon.spy(async () => tip),
        setChainTip: sinon.spy(async (coin, net, height, time, chainId) => {
            tip = { blockHeight: height, blockTime: time, chainId: chainId || (tip && tip.chainId) || null };
        }),
        createCapabilitySnapshots: async (newRows, btcChainId) => {
            for (const r of newRows) rows.push(Object.assign({}, r, { btc_chain_id: btcChainId }));
        },
        stampNullCapabilitySnapshotChainId: sinon.spy(async chainId => {
            for (const r of rows) if (r.btc_chain_id === null) r.btc_chain_id = chainId;
        }),
        listUncheckpointedSnapshotBlocks: async (net, from, burial) => {
            const known = tip && tip.chainId;
            const blocks = new Set();
            for (const r of rows) {
                if (r.snapshot_block < from || !known || r.btc_chain_id !== known) continue;
                if (!checkpoints.has(r.snapshot_block - burial)) blocks.add(r.snapshot_block);
            }
            return [...blocks].sort((a, b) => a - b).map(snapshot_block => ({ snapshot_block }));
        },
        getSnapshotCheckpoint: async (chain, net, blockIndex) => checkpoints.get(blockIndex) || null,
        insertSnapshotCheckpoint: async cp => {
            if (checkpoints.has(cp.block_index)) return false;
            checkpoints.set(cp.block_index, Object.assign({}, cp));
            return true;
        },
    };
    const engine = new SnapshotCheckpointEngine({
        db,
        network,
        identity: { getPubkeyHex: () => HUB_KEY, sign: () => 'f'.repeat(128) },
        peerManager: { broadcast: sinon.spy() },
        confirmations: 0,
        pollMs: 60000,
        resolveSnapshotBlock: async () => 1000,
        resolveCapabilityValidators: async () => [{ pubkey: HUB_KEY }],
        indexerCall: async (chain, method, params) => ({
            block_index: params.block_index, block_hash: 'a'.repeat(64),
            state_root: 'b'.repeat(64), state_root_version: 1,
        }),
    });
    const rpc = buildFeedRpc({ hub: { db, network } });
    return { db, engine, rpc };
}

function seedRow() {
    return [{ pubkey: HUB_KEY, source: 'seed:' + HUB_KEY, weight: '1', amount: '1' }];
}

describe('regtest NULL btc_chain_id capability snapshot stamp', function () {
    it('checkpoints a snapshot written before the first chain-tip push once the id arrives', async function () {
        const h = memoryHub();
        // Written while the hub knows no chain tip: stamped NULL.
        await snapWrite.writeCapabilitySnapshotRows(h.db, 'oracle_publish', 34, seedRow());
        expect(h.db.rows.map(r => r.btc_chain_id)).to.deep.equal([null]);

        // The tip arrives without the id first (a chain whose block 1 is unread): nothing to stamp.
        await h.rpc.pushchaintip({ coin: 'BTC', network: 'regtest', block_height: 34, block_time: 1700000000 });
        await h.engine.tick();
        expect(h.db.checkpoints.size).to.equal(0);

        // The push carrying the id stamps the NULL row, and the next tick checkpoints it.
        expect(await h.rpc.pushchaintip({ coin: 'BTC', network: 'regtest', block_height: 35,
            block_time: 1700000010, chain_id: CHAIN_ID })).to.deep.equal({ status: 'success' });
        expect(h.db.rows.map(r => r.btc_chain_id)).to.deep.equal([CHAIN_ID]);
        await h.engine.tick();
        expect([...h.db.checkpoints.keys()]).to.deep.equal([34 - 6]);
    });

    it('stamps after storing the tip and still succeeds when the stamp fails', async function () {
        const h = memoryHub();
        h.db.stampNullCapabilitySnapshotChainId = sinon.stub().rejects(new Error('lock wait'));
        expect(await h.rpc.pushchaintip({ coin: 'BTC', network: 'regtest', block_height: 35,
            block_time: 1700000010, chain_id: CHAIN_ID })).to.deep.equal({ status: 'success' });
        expect(h.db.setChainTip.calledBefore(h.db.stampNullCapabilitySnapshotChainId)).to.equal(true);
        expect(h.db.stampNullCapabilitySnapshotChainId.calledOnceWithExactly(CHAIN_ID)).to.equal(true);
    });

    for (const [label, params, hubNetwork] of [
        ['a testnet hub', { network: 'testnet' }, 'testnet'],
        ['a mainnet hub', { network: 'mainnet' }, 'mainnet'],
        ['a regtest caller on a testnet hub', {}, 'testnet'],
        ['a non-BTC tip', { coin: 'DOGE' }, 'regtest'],
        ['a push without a chain id', { chain_id: undefined }, 'regtest'],
    ]) {
        it('never stamps for ' + label, async function () {
            const h = memoryHub(hubNetwork);
            await snapWrite.writeCapabilitySnapshotRows(h.db, 'oracle_publish', 34, seedRow());
            const push = Object.assign({ coin: 'BTC', network: 'regtest', block_height: 35,
                block_time: 1700000010, chain_id: CHAIN_ID }, params);
            if (push.chain_id === undefined) delete push.chain_id;
            expect(await h.rpc.pushchaintip(push)).to.deep.equal({ status: 'success' });
            expect(h.db.stampNullCapabilitySnapshotChainId.called).to.equal(false);
            expect(h.db.rows.map(r => r.btc_chain_id)).to.deep.equal([null]);
        });
    }

    it('binds the chain id in a NULL-only UPDATE and counts the NULL rows of one block', async function () {
        const doQuery = sinon.stub().resolves();
        await capabilityDb.stampNullCapabilitySnapshotChainId.call({ doQuery }, CHAIN_ID);
        await capabilityDb.countCapabilitySnapshotChainIdStamps.call({ doQuery }, 34);
        expect(doQuery.getCall(0).args).to.deep.equal([
            'UPDATE capability_snapshots SET btc_chain_id = ? WHERE btc_chain_id IS NULL', [CHAIN_ID]]);
        expect(doQuery.getCall(1).args).to.deep.equal([
            'SELECT COUNT(*) AS rows_total, SUM(btc_chain_id IS NULL) AS rows_null FROM capability_snapshots' +
            ' WHERE snapshot_block = ?', [34]]);
    });
});
