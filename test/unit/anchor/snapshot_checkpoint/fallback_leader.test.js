'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const SnapshotCheckpointEngine = require(
    '../../../../src/anchor/snapshot_checkpoint/engine.js');
const {
    SNAPSHOT_FALLBACK_STEP_BLOCKS: STEP,
    snapshotLeaderRank,
} = require('../../../../src/anchor/snapshot_checkpoint/leader.js');
const { buildSnapshotSignRequest } = require(
    '../../../../src/anchor/snapshot_checkpoint/sign_request.js');
const { snapshotCheckpointBlock } = require(
    '../../../../src/consensus/snapshot_checkpoint/canonical.js');
const { snapshotCheckpointFromBlockHashes } = require(
    '../../../../src/anchor/snapshot_checkpoint/payload.js');
const { buildSnapshotMesh } = require('./support/snapshot_mesh.js');

// Without a fallback, one offline turn hub leaves its snapshot and every later one unproven,
// and every proof-gated mirror row holds; these cases prove the next hub takes over.
// The mesh runs five hubs, the testnet validator count, with the production confirmation floor.
const SNAPSHOT_BLOCK = 406;

async function flush(count = 24) {
    for (let i = 0; i < count; i++)
        await new Promise(resolve => setImmediate(resolve));
}

async function startMesh(seeds = [SNAPSHOT_BLOCK]) {
    const mesh = buildSnapshotMesh({ n: 5, timeoutMs: 40 });
    for (const node of mesh.nodes) {
        node.stateCheckpoints.handleMessage = () => {};
        node.stateCheckpoints.peerManager.on('message', envelope =>
            node.stateCheckpoints.handleMessage(envelope));
        node.engine = new SnapshotCheckpointEngine(node.stateCheckpoints);
        node.db.seedSnapshots(seeds);
        await node.engine.start();
    }
    return mesh;
}

async function stopMesh(mesh) {
    for (const node of mesh.nodes) await node.engine.stop();
}

// An offline hub neither ticks nor hears anything; the mesh skips a node with no receiver.
function takeOffline(node) {
    node.receive = null;
    node.offline = true;
}

async function tickOnline(mesh) {
    for (const node of mesh.nodes) {
        if (node.offline) continue;
        await node.engine.tick();
        await flush();
    }
}

function nodeAtRank(mesh, blockIndex, rank) {
    return mesh.nodes.find(node =>
        snapshotLeaderRank(blockIndex, mesh.validators, node.pubkey) === rank);
}

function requestSenders(mesh) {
    return mesh.sent.filter(row => row.type === 'XSNP_SIGN_REQ').map(row => row.sender);
}

async function storedRows(mesh, blockIndex) {
    return Promise.all(mesh.nodes.map(node =>
        node.db.getSnapshotCheckpoint('BTC', mesh.network, blockIndex)));
}

async function expectFallbackCheckpoint(mesh, blockIndex, turn, fallback) {
    const rows = await storedRows(mesh, blockIndex);
    const online = rows.filter((row, index) => !mesh.nodes[index].offline);
    expect(rows[mesh.nodes.indexOf(turn)]).to.equal(null);
    expect(online.every(Boolean)).to.equal(true);
    expect(online.slice(1)).to.deep.equal(online.slice(1).map(() => online[0]));
    const indexed = await fallback.stateCheckpoints.indexerCall(
        'BTC', 'getblockhashes', { block_index: blockIndex });
    expect(online[0]).to.include({
        chain: 'BTC', network: mesh.network, block_index: blockIndex,
        block_hash: indexed.block_hash, state_root: indexed.state_root,
    });
    const signers = JSON.parse(online[0].validator_signatures).map(row => row.pubkey);
    expect(signers).to.have.length(4);
    expect(signers).not.to.include(turn.pubkey);
}

describe('snapshot checkpoint fallback leader with the turn hub offline', function () {
    it('cuts the same payload while committed height is frozen and chain height unlocks rank 1', async function () {
        const mesh = await startMesh();
        try {
            const blockIndex = snapshotCheckpointBlock(SNAPSHOT_BLOCK, mesh.network);
            const dueHeight = blockIndex + mesh.confirmations;
            const turn = nodeAtRank(mesh, blockIndex, 0);
            const fallback = nodeAtRank(mesh, blockIndex, 1);
            takeOffline(turn);
            mesh.setHeights(dueHeight, dueHeight + STEP * mesh.nodes.length);

            const rankZeroBlock = await turn.stateCheckpoints.indexerCall(
                'BTC', 'getblockhashes', { block_index: blockIndex });
            const rankZeroPayload = snapshotCheckpointFromBlockHashes(
                mesh.network, rankZeroBlock, blockIndex);
            await fallback.engine.tick();
            await flush();

            expect(requestSenders(mesh)).to.deep.equal([fallback.pubkey]);
            const rows = await storedRows(mesh, blockIndex);
            const online = rows.filter((row, index) => !mesh.nodes[index].offline);
            expect(online.every(Boolean)).to.equal(true);
            for (const row of online) {
                expect(row).to.include(rankZeroPayload);
                const signers = JSON.parse(row.validator_signatures);
                expect(signers).to.have.length(4);
                expect(signers.map(entry => entry.pubkey)).not.to.include(turn.pubkey);
            }
        } finally {
            await stopMesh(mesh);
        }
    });
});

describe('snapshot checkpoint committed height guard', function () {
    it('never cuts or signs one block below committed confirmation depth', async function () {
        const mesh = await startMesh();
        try {
            const blockIndex = snapshotCheckpointBlock(SNAPSHOT_BLOCK, mesh.network);
            const dueHeight = blockIndex + mesh.confirmations;
            const turn = nodeAtRank(mesh, blockIndex, 0);
            const fallback = nodeAtRank(mesh, blockIndex, 1);
            takeOffline(turn);
            mesh.setHeights(dueHeight - 1, dueHeight + STEP * mesh.nodes.length);

            await tickOnline(mesh);
            expect(requestSenders(mesh)).to.deep.equal([]);

            const row = await fallback.stateCheckpoints.indexerCall(
                'BTC', 'getblockhashes', { block_index: blockIndex });
            fallback.hub.getPeerManager().broadcast('XSNP_SIGN_REQ',
                buildSnapshotSignRequest(fallback.identity, SNAPSHOT_BLOCK, {
                    chain: 'BTC', network: mesh.network, block_index: blockIndex,
                    block_hash: row.block_hash, state_root: row.state_root,
                    state_root_version: row.state_root_version,
                }));
            await flush();
            expect(mesh.sent.filter(entry => entry.type === 'XSNP_SIGN')).to.deep.equal([]);
        } finally {
            await stopMesh(mesh);
        }
    });
});

describe('snapshot checkpoint fallback leader with the turn hub offline', function () {
    it('lets the next hub checkpoint the snapshot only after the bounded wait', async function () {
        const mesh = await startMesh();
        try {
            const blockIndex = snapshotCheckpointBlock(SNAPSHOT_BLOCK, mesh.network);
            const dueHeight = blockIndex + mesh.confirmations;
            const turn = nodeAtRank(mesh, blockIndex, 0);
            const next = nodeAtRank(mesh, blockIndex, 1);
            takeOffline(turn);

            for (const chainHeight of [dueHeight, dueHeight + STEP - 1]) {
                mesh.setHeights(dueHeight, chainHeight);
                await tickOnline(mesh);
                expect(requestSenders(mesh), 'chain height ' + chainHeight).to.deep.equal([]);
            }

            mesh.setHeights(dueHeight, dueHeight + STEP);
            await tickOnline(mesh);
            expect(requestSenders(mesh)).to.deep.equal([next.pubkey]);

            await expectFallbackCheckpoint(mesh, blockIndex, turn, next);
        } finally {
            await stopMesh(mesh);
        }
    });

    it('frees the later snapshots for their own turn hubs once the stuck one clears', async function () {
        const mesh = await startMesh([SNAPSHOT_BLOCK, SNAPSHOT_BLOCK + 1]);
        try {
            const blockIndex = snapshotCheckpointBlock(SNAPSHOT_BLOCK, mesh.network);
            const dueHeight = blockIndex + mesh.confirmations;
            const laterTurn = nodeAtRank(mesh, blockIndex + 1, 0);
            takeOffline(nodeAtRank(mesh, blockIndex, 0));

            mesh.setHeights(dueHeight, dueHeight + STEP);
            await tickOnline(mesh);
            mesh.setHeights(dueHeight + 1, dueHeight + STEP);
            await tickOnline(mesh);

            expect(requestSenders(mesh)).to.deep.equal([
                nodeAtRank(mesh, blockIndex, 1).pubkey, laterTurn.pubkey,
            ]);
            const later = await storedRows(mesh, blockIndex + 1);
            expect(later.filter(Boolean)).to.have.length(4);
        } finally {
            await stopMesh(mesh);
        }
    });
});

describe('snapshot checkpoint fallback leader co-signing', function () {
    it('signs a fallback request only once its rank has waited out the step', async function () {
        const mesh = await startMesh();
        try {
            const blockIndex = snapshotCheckpointBlock(SNAPSHOT_BLOCK, mesh.network);
            const dueHeight = blockIndex + mesh.confirmations;
            const row = await mesh.nodes[0].stateCheckpoints.indexerCall(
                'BTC', 'getblockhashes', { block_index: blockIndex });
            const cp = {
                chain: 'BTC', network: mesh.network, block_index: blockIndex,
                block_hash: row.block_hash, state_root: row.state_root,
                state_root_version: row.state_root_version,
            };
            const ask = rank => nodeAtRank(mesh, blockIndex, rank).hub.getPeerManager()
                .broadcast('XSNP_SIGN_REQ', buildSnapshotSignRequest(
                    nodeAtRank(mesh, blockIndex, rank).identity, SNAPSHOT_BLOCK, cp));
            const replies = () => mesh.sent.filter(entry => entry.type === 'XSNP_SIGN').length;

            mesh.setHeights(dueHeight, dueHeight + STEP - 1);
            ask(1);
            await flush();
            expect(replies()).to.equal(0);

            mesh.setHeights(dueHeight, dueHeight + STEP);
            ask(2);
            await flush();
            expect(replies()).to.equal(0);

            ask(1);
            await flush();
            expect(replies()).to.equal(4);
        } finally {
            await stopMesh(mesh);
        }
    });
});

describe('snapshot checkpoint fallback leader with the turn hub live', function () {
    it('leaves the live turn hub the sole leader and never re-leads its checkpoint', async function () {
        const mesh = await startMesh();
        try {
            const blockIndex = snapshotCheckpointBlock(SNAPSHOT_BLOCK, mesh.network);
            const dueHeight = blockIndex + mesh.confirmations;
            const turn = nodeAtRank(mesh, blockIndex, 0);
            mesh.setHeights(dueHeight, dueHeight + STEP - 1);
            for (const node of mesh.nodes.filter(candidate => candidate !== turn)) {
                expect(await node.engine.checkpointNextDue()).to.equal(false);
            }
            expect(requestSenders(mesh)).to.deep.equal([]);

            await tickOnline(mesh);
            expect(requestSenders(mesh)).to.deep.equal([turn.pubkey]);
            expect((await storedRows(mesh, blockIndex)).every(Boolean)).to.equal(true);

            mesh.setHeights(dueHeight, dueHeight + STEP * mesh.nodes.length);
            await tickOnline(mesh);
            expect(requestSenders(mesh)).to.deep.equal([turn.pubkey]);
        } finally {
            await stopMesh(mesh);
        }
    });
});
