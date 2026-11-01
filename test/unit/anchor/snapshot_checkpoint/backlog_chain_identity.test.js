'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// A hub that learns the BTC chain id late holds a backlog of capability sets written
// with btc_chain_id NULL. Stamping them all made every old slot due, and the hub spent
// over an hour clearing them oldest first before it led its own. These cases run a
// 100-set backlog through the engine and check the current slot is led on the first tick.

const sinon = require('sinon');
const { expect } = require('chai');
const capabilityDb = require('../../../../src/db/snapshots/capability_snapshots.js');
const SnapshotCheckpointEngine = require('../../../../src/anchor/snapshot_checkpoint/engine.js');

const CHAIN_ID = 'a'.repeat(64);
const PUBKEY = '1'.repeat(64);
const BACKLOG = 100;
const FIRST_SET = 400;
const SNAPSHOT_BLOCK = FIRST_SET + BACKLOG - 1;
const CONFIRMATIONS = 6;

// The newest-only stamp as the SQL applies it: the NULL rows at the highest NULL block.
function stampNewest(rows, chainId) {
    const nulls = rows.filter(r => r.btc_chain_id === null);
    if (!nulls.length) return;
    const newest = Math.max(...nulls.map(r => r.snapshot_block));
    for (const r of nulls) if (r.snapshot_block === newest) r.btc_chain_id = chainId;
}

// Uncheckpointed blocks on the stored chain id, lowest first, as the scan's SQL returns them.
function listDue(state, from, burial, limit) {
    const blocks = new Set(state.rows
        .filter(r => r.snapshot_block >= from && r.btc_chain_id === state.chainId)
        .filter(r => !state.checkpoints.has(r.snapshot_block - burial))
        .map(r => r.snapshot_block));
    return [...blocks].sort((a, b) => a - b).slice(0, limit)
        .map(snapshot_block => ({ snapshot_block }));
}

function backlogDb() {
    const state = {
        chainId: null,
        checkpoints: new Map(),
        rows: Array.from({ length: BACKLOG }, (_, i) => ({ snapshot_block: FIRST_SET + i, btc_chain_id: null })),
    };
    return Object.assign(state, {
        async getChainId() { return state.chainId; },
        async setChainId(coin, network, value) { state.chainId = value; },
        stampNewestNullCapabilitySnapshotChainId: sinon.spy(async id => stampNewest(state.rows, id)),
        stampNullCapabilitySnapshotChainId: sinon.spy(async () => {}),
        async listUncheckpointedSnapshotBlocks(network, from, burial, limit) {
            return listDue(state, from, burial, limit);
        },
        async getSnapshotCheckpoint(chain, network, blockIndex) {
            return state.checkpoints.get(blockIndex) || null;
        },
        async insertSnapshotCheckpoint(cp) {
            state.checkpoints.set(cp.block_index, cp);
            return true;
        },
    });
}

function indexerReply(params) {
    if (params.block_index === 1)
        return { coin: 'BTC', network: 'regtest', block_index: 1, block_hash: CHAIN_ID };
    return { block_index: params.block_index, block_hash: 'b'.repeat(64), state_root: 'c'.repeat(64), state_root_version: 1 };
}

function backlogEngine(db) {
    return new SnapshotCheckpointEngine({
        db,
        network: 'regtest',
        confirmations: CONFIRMATIONS,
        identity: { getPubkeyHex: () => PUBKEY, sign: () => 'f'.repeat(128) },
        resolveSnapshotBlock: async () => SNAPSHOT_BLOCK,
        resolveCapabilityValidators: async () => [{ pubkey: PUBKEY }],
        indexerCall: async (chain, method, params) => indexerReply(params),
    });
}

describe('snapshot checkpoint: a late chain id with a 100-set backlog', function () {
    it('leads the current slot at its first eligible block', async function () {
        const db = backlogDb();
        await backlogEngine(db).tick();
        expect([...db.checkpoints.keys()]).to.deep.equal([SNAPSHOT_BLOCK - CONFIRMATIONS]);
        expect(db.rows.filter(r => r.btc_chain_id === CHAIN_ID)).to.have.length(1);
        expect(db.stampNullCapabilitySnapshotChainId.called).to.equal(false);
    });

    it('stamps the backlog once per learned id, not on every tick', async function () {
        const db = backlogDb();
        const engine = backlogEngine(db);
        await engine.tick();
        engine.chainIdReadAt = undefined;
        await engine.tick();
        expect(db.stampNewestNullCapabilitySnapshotChainId.calledOnceWithExactly(CHAIN_ID)).to.equal(true);
    });

    it('binds the chain id in an UPDATE limited to the newest NULL block', async function () {
        const doQuery = sinon.stub().resolves();
        await capabilityDb.stampNewestNullCapabilitySnapshotChainId.call({ doQuery }, CHAIN_ID);
        const [sql, args] = doQuery.getCall(0).args;
        expect(sql).to.match(/^UPDATE capability_snapshots cs JOIN \(SELECT MAX\(snapshot_block\)/);
        expect(sql).to.match(/WHERE btc_chain_id IS NULL\) newest ON newest.snapshot_block = cs.snapshot_block/);
        expect(sql).to.match(/SET cs.btc_chain_id = \? WHERE cs.btc_chain_id IS NULL$/);
        expect(args).to.deep.equal([CHAIN_ID]);
    });
});
