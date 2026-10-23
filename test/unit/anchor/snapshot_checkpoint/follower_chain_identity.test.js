'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The BTC indexer pushes its chain tip, and with it the chain id (the hash of its block 1),
// to one hub only. The other hubs (hub-b and hub-c on the rail) never stored a chain id,
// so every capability set they wrote carried btc_chain_id NULL, the uncheckpointed-snapshot
// scan joins on that id, and they never saw a snapshot as due: their turn slots always
// waited out the fallback ladder. These cases run a hub that gets no tip push through the
// real config methods and the real capability row writer, over an in-memory table whose
// scan applies the same join as the SQL.

const sinon = require('sinon');
const { expect } = require('chai');
const configsDb = require('../../../../src/db/configs.js');
const snapWrite = require('../../../../src/lib/capability_snapshot_write.js');
const SnapshotCheckpointEngine = require('../../../../src/anchor/snapshot_checkpoint/engine.js');
const { snapshotLeaderRank } = require('../../../../src/anchor/snapshot_checkpoint/leader.js');
const { snapshotCheckpointBlock } = require(
    '../../../../src/consensus/snapshot_checkpoint/canonical.js');

const CHAIN_ID = '0b'.repeat(32);
const DEAD_CHAIN_ID = '0c'.repeat(32);
const CONFIRMATIONS = 6;
const VALIDATORS = ['1', '2', '3'].map(c => ({ pubkey: c.repeat(64) }));
const FOLLOWER = VALIDATORS[1].pubkey;

// An in-memory hub database: the configs table under the real configs methods, the
// capability rows, and listUncheckpointedSnapshotBlocks with the SQL's join (a configs
// row on this network, coin bitcoin or btc in any case, module chain_tips, param chain_id,
// equal to the row's btc_chain_id).
function followerDb() {
    const configs = [];
    const capabilityRows = [];
    const checkpoints = new Map();
    const upsert = (coin, network, module, paramName, paramValue) => {
        const row = configs.find(r => r.coin === coin && r.network === network &&
            r.module === module && r.param_name === paramName);
        if (row) row.param_value = paramValue;
        else configs.push({ coin, network, module, param_name: paramName, param_value: paramValue });
    };
    return Object.assign({}, configsDb, {
        configs,
        capabilityRows,
        checkpoints,
        async getConfig(coin, network, module) {
            const config = {};
            for (const r of configs) {
                if (r.coin === coin && r.network === network && r.module === module)
                    config[r.param_name] = r.param_value;
            }
            return config;
        },
        setParam: sinon.spy(async (coin, network, module, paramName, paramValue) =>
            upsert(coin, network, module, paramName, paramValue)),
        setParams: sinon.spy(async rows => {
            for (const r of rows) upsert(r.coin, r.network, r.module, r.paramName, r.paramValue);
            return rows.length;
        }),
        async createCapabilitySnapshots(rows, btcChainId) {
            for (const r of rows)
                capabilityRows.push(Object.assign({}, r, { btc_chain_id: btcChainId }));
        },
        stampNullCapabilitySnapshotChainId: sinon.spy(async chainId => {
            for (const r of capabilityRows) if (r.btc_chain_id === null) r.btc_chain_id = chainId;
        }),
        deleteCrossChainMatchesByNetwork: sinon.spy(async () => {}),
        deleteCrossChainCallsByNetwork: sinon.spy(async () => {}),
        deleteAllCapabilitySnapshots: sinon.spy(async () => { capabilityRows.length = 0; }),
        listUncheckpointedSnapshotBlocks: sinon.spy(async (network, from, burial, limit) => {
            const ids = configs.filter(r => r.network === network && r.module === 'chain_tips' &&
                r.param_name === 'chain_id' && ['bitcoin', 'btc'].includes(r.coin.toLowerCase()))
                .map(r => r.param_value);
            const blocks = new Set();
            for (const r of capabilityRows) {
                if (r.snapshot_block < from || !ids.includes(r.btc_chain_id)) continue;
                if (!checkpoints.has(r.snapshot_block - burial)) blocks.add(r.snapshot_block);
            }
            return [...blocks].sort((a, b) => a - b).slice(0, limit)
                .map(snapshot_block => ({ snapshot_block }));
        }),
        async getSnapshotCheckpoint(chain, network, blockIndex) {
            return checkpoints.get(blockIndex) || null;
        },
        async insertSnapshotCheckpoint(cp) {
            if (checkpoints.has(cp.block_index)) return false;
            checkpoints.set(cp.block_index, Object.assign({}, cp));
            return true;
        },
    });
}

// A hub whose BTC indexer answers block 1 with `chainId` (or with `blockOne` when given)
// and every other block with a checkpointable row. It has no feed: nothing pushes a tip.
function followerHub(network, options = {}) {
    const db = followerDb();
    let tip = 0;
    let chainId = options.chainId || CHAIN_ID;
    const indexerCall = sinon.spy(async (chain, method, params) => {
        expect(chain).to.equal('BTC');
        expect(method).to.equal('getblockhashes');
        if (params.block_index === 1) {
            if (options.blockOne) return options.blockOne();
            return { coin: 'BTC', network, block_index: 1, block_hash: chainId };
        }
        return {
            coin: 'BTC', network, block_index: params.block_index,
            block_hash: 'a'.repeat(64), state_root: 'b'.repeat(64), state_root_version: 1,
        };
    });
    const peerManager = { broadcast: sinon.spy() };
    const engine = new SnapshotCheckpointEngine({
        db,
        network,
        identity: { getPubkeyHex: () => FOLLOWER, sign: () => 'f'.repeat(128) },
        peerManager,
        confirmations: CONFIRMATIONS,
        pollMs: 60000,
        roundTimeoutMs: 50,
        resolveSnapshotBlock: async () => tip,
        resolveCapabilityValidators: async () => VALIDATORS,
        indexerCall,
    });
    return {
        db, engine, indexerCall, peerManager,
        setTip(value) { tip = value; },
        setChainId(value) { chainId = value; },
        blockOneReads: () => indexerCall.getCalls().filter(c => c.args[2].block_index === 1).length,
    };
}

// The first snapshot block at or above `from` whose checkpoint block is the follower's turn.
function followerTurn(network, from) {
    for (let snapshotBlock = from; ; snapshotBlock++) {
        const blockIndex = snapshotCheckpointBlock(snapshotBlock, network);
        if (snapshotLeaderRank(blockIndex, VALIDATORS, FOLLOWER) === 0)
            return { snapshotBlock, blockIndex };
    }
}

function signRequests(hub) {
    return hub.peerManager.broadcast.getCalls()
        .filter(c => c.args[0] === SnapshotCheckpointEngine.XSNP_SIGN_REQ)
        .map(c => c.args[1]);
}

async function lastScan(hub) {
    return (await hub.db.listUncheckpointedSnapshotBlocks.lastCall.returnValue)
        .map(row => row.snapshot_block);
}

function writeSet(hub, snapshotBlock) {
    return snapWrite.writeCapabilitySnapshotRows(hub.db, 'oracle_publish', snapshotBlock,
        VALIDATORS.map(v => ({ pubkey: v.pubkey, source: 'seed:' + v.pubkey, weight: '1', amount: '1' })));
}

// Registers the hooks a suite needs and returns its hub factory: HUB_NETWORK is what the
// capability row writer reads the hub's own network from, so it is set per hub and restored.
function useFollowerHubs() {
    let savedNetwork;
    let hubs = [];

    beforeEach(function () {
        savedNetwork = process.env.HUB_NETWORK;
        hubs = [];
    });

    afterEach(async function () {
        for (const hub of hubs) await hub.engine.stop();
        if (savedNetwork === undefined) delete process.env.HUB_NETWORK;
        else process.env.HUB_NETWORK = savedNetwork;
    });

    return function start(network, options) {
        process.env.HUB_NETWORK = network;
        const hub = followerHub(network, options);
        hubs.push(hub);
        return hub;
    };
}

describe('snapshot checkpoint leadership on a hub that gets no BTC tip push', function () {
    const start = useFollowerHubs();

    it('learns the regtest chain id from its BTC indexer, sees the snapshot due at its due height and leads its rank-0 slot', async function () {
        const hub = start('regtest');
        const { snapshotBlock, blockIndex } = followerTurn('regtest', 400);
        // Written before the hub knows its chain, as on the rail: stamped NULL.
        await writeSet(hub, snapshotBlock);
        expect(hub.db.capabilityRows.map(r => r.btc_chain_id)).to.deep.equal([null, null, null]);

        hub.setTip(blockIndex + CONFIRMATIONS - 1);
        await hub.engine.tick();
        expect(await hub.db.getChainId('BTC', 'regtest')).to.equal(CHAIN_ID);
        expect(hub.db.capabilityRows.map(r => r.btc_chain_id))
            .to.deep.equal([CHAIN_ID, CHAIN_ID, CHAIN_ID]);
        expect(await lastScan(hub)).to.deep.equal([snapshotBlock]);
        expect(signRequests(hub)).to.deep.equal([]);

        hub.setTip(blockIndex + CONFIRMATIONS);
        await hub.engine.tick();
        const requests = signRequests(hub);
        expect(requests).to.have.length(1);
        expect(requests[0]).to.include({ snapshot_block: snapshotBlock, pubkey: FOLLOWER });
        expect(requests[0].cp).to.include({ chain: 'BTC', network: 'regtest', block_index: blockIndex });
        // The id is stored on its own: no tip height appears, so staleness gates are untouched.
        expect(await hub.db.getChainTip('BTC', 'regtest')).to.equal(null);
    });

    it('stamps every testnet set written after it learns the id and leads its due rank-0 slot', async function () {
        const hub = start('testnet');
        const { snapshotBlock, blockIndex } = followerTurn('testnet', 160000);
        hub.setTip(blockIndex + CONFIRMATIONS);
        await hub.engine.tick();
        expect(await hub.db.getChainId('BTC', 'testnet')).to.equal(CHAIN_ID);

        await writeSet(hub, snapshotBlock);
        expect(hub.db.capabilityRows.map(r => r.btc_chain_id))
            .to.deep.equal([CHAIN_ID, CHAIN_ID, CHAIN_ID]);
        await hub.engine.tick();
        expect(hub.db.stampNullCapabilitySnapshotChainId.called).to.equal(false);
        expect(await lastScan(hub)).to.deep.equal([snapshotBlock]);
        const requests = signRequests(hub);
        expect(requests).to.have.length(1);
        expect(requests[0].cp).to.include({ network: 'testnet', block_index: blockIndex });
    });
});

describe('snapshot checkpoint chain identity reads from the BTC indexer', function () {
    const start = useFollowerHubs();

    it('reads block 1 at most once a minute and keeps the stored id when the read fails', async function () {
        let failing = false;
        const hub = start('regtest', {
            blockOne: async () => {
                if (failing) throw new Error('indexer down');
                return { coin: 'BTC', network: 'regtest', block_index: 1, block_hash: CHAIN_ID };
            },
        });
        const clock = sinon.useFakeTimers({ now: 1700000000000, toFake: ['Date'] });
        try {
            await hub.engine.tick();
            await hub.engine.tick();
            expect(hub.blockOneReads()).to.equal(1);

            failing = true;
            clock.tick(60000);
            await hub.engine.tick();
            expect(hub.blockOneReads()).to.equal(2);
            expect(await hub.db.getChainId('BTC', 'regtest')).to.equal(CHAIN_ID);
        } finally {
            clock.restore();
        }
    });

    for (const [label, reply] of [
        ['another block', { coin: 'BTC', network: 'regtest', block_index: 2, block_hash: CHAIN_ID }],
        ['another coin', { coin: 'DOGE', network: 'regtest', block_index: 1, block_hash: CHAIN_ID }],
        ['another network', { coin: 'BTC', network: 'testnet', block_index: 1, block_hash: CHAIN_ID }],
        ['a malformed hash', { coin: 'BTC', network: 'regtest', block_index: 1, block_hash: 'zz' }],
        ['an indexer error reply', { error: 'block not indexed: 1' }],
    ]) {
        it('stores nothing from ' + label, async function () {
            const hub = start('regtest', { blockOne: async () => reply });
            await hub.engine.tick();
            expect(await hub.db.getChainId('BTC', 'regtest')).to.equal(null);
            expect(hub.db.setParam.called).to.equal(false);
            expect(hub.db.setParams.called).to.equal(false);
        });
    }
});

describe('snapshot checkpoint chain identity changes', function () {
    const start = useFollowerHubs();

    it('purges the dead chain rows when a regtest re-genesis changes the id, as a tip push does', async function () {
        const hub = start('regtest', { chainId: DEAD_CHAIN_ID });
        const clock = sinon.useFakeTimers({ now: 1700000000000, toFake: ['Date'] });
        try {
            await hub.engine.tick();
            await writeSet(hub, 400);
            expect(hub.db.capabilityRows.map(r => r.btc_chain_id)[0]).to.equal(DEAD_CHAIN_ID);

            hub.setChainId(CHAIN_ID);
            clock.tick(60000);
            await hub.engine.tick();
            expect(hub.db.deleteCrossChainMatchesByNetwork.calledOnceWithExactly('regtest')).to.equal(true);
            expect(hub.db.deleteCrossChainCallsByNetwork.calledOnceWithExactly('regtest')).to.equal(true);
            expect(hub.db.deleteAllCapabilitySnapshots.calledOnce).to.equal(true);
            expect(hub.db.capabilityRows).to.deep.equal([]);
            expect(await hub.db.getChainId('BTC', 'regtest')).to.equal(CHAIN_ID);
        } finally {
            clock.restore();
        }
    });

    it('never purges off regtest when the id changes', async function () {
        const hub = start('testnet', { chainId: DEAD_CHAIN_ID });
        const clock = sinon.useFakeTimers({ now: 1700000000000, toFake: ['Date'] });
        try {
            await hub.engine.tick();
            hub.setChainId(CHAIN_ID);
            clock.tick(60000);
            await hub.engine.tick();
            expect(hub.db.deleteAllCapabilitySnapshots.called).to.equal(false);
            expect(hub.db.deleteCrossChainMatchesByNetwork.called).to.equal(false);
            expect(await hub.db.getChainId('BTC', 'testnet')).to.equal(CHAIN_ID);
        } finally {
            clock.restore();
        }
    });

    it('binds the id-only write and read to the chain_tips chain_id param', async function () {
        const doQuery = sinon.stub().resolves([{ param_name: 'chain_id', param_value: CHAIN_ID }]);
        const db = Object.assign({ doQuery }, configsDb);
        await db.setChainId('BTC', 'regtest', CHAIN_ID);
        expect(doQuery.firstCall.args[1]).to.deep.equal(
            ['bitcoin', 'regtest', 'chain_tips', 'chain_id', CHAIN_ID, CHAIN_ID]);
        expect(await db.getChainId('BTC', 'regtest')).to.equal(CHAIN_ID);
        expect(doQuery.secondCall.args[1]).to.deep.equal(['bitcoin', 'regtest', 'chain_tips']);
    });
});
