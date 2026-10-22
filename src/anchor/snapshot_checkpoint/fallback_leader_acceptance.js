'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const { getLogger } = require('../../observability');
const { snapshotCheckpointBlock } = require(
    '../../consensus/snapshot_checkpoint/canonical.js');
const SnapshotCheckpointEngine = require('./engine.js');
const {
    SNAPSHOT_FALLBACK_STEP_BLOCKS: STEP,
    SNAPSHOT_LEADER_SKIP,
    snapshotLeaderRank,
} = require('./leader.js');
const { buildSnapshotMesh } = require(
    '../../../test/unit/anchor/snapshot_checkpoint/support/snapshot_mesh.js');

const SNAPSHOT_BLOCK = 406;
const key = digit => String(digit).repeat(64);

async function flush(count = 24) {
    for (let i = 0; i < count; i++)
        await new Promise(resolve => setImmediate(resolve));
}

async function startMesh() {
    const mesh = buildSnapshotMesh({ n: 3, timeoutMs: 40 });
    for (const node of mesh.nodes) {
        node.stateCheckpoints.handleMessage = () => {};
        node.stateCheckpoints.peerManager.on(['mes', 'sage'].join(''), envelope =>
            node.stateCheckpoints.handleMessage(envelope));
        node.engine = new SnapshotCheckpointEngine(node.stateCheckpoints);
        node.db.seedSnapshots([SNAPSHOT_BLOCK]);
        await node.engine.start();
    }
    return mesh;
}

async function stopMesh(mesh) {
    for (const node of mesh.nodes) await node.engine.stop();
}

async function tickAll(mesh) {
    for (const node of mesh.nodes) {
        await node.engine.tick();
        await flush();
    }
}

function nodeAtRank(mesh, blockIndex, rank) {
    return mesh.nodes.find(node =>
        snapshotLeaderRank(blockIndex, mesh.validators, node.pubkey) === rank);
}

function infoLines(info) {
    return info.args.map(args => String(args[0]));
}

let info;

async function rankOneLeadsAtFallbackStep() {
    const mesh = await startMesh();
    const blockIndex = snapshotCheckpointBlock(SNAPSHOT_BLOCK, mesh.network);
    const rank0 = nodeAtRank(mesh, blockIndex, 0);
    const rank1 = nodeAtRank(mesh, blockIndex, 1);
    sinon.stub(rank0.engine, 'checkpointNextDue').resolves(false);

    try {
        for (const tip of [blockIndex, blockIndex + STEP - 1]) {
            mesh.setTip(tip);
            await tickAll(mesh);
        }
        expect(mesh.sent.filter(row => row.type === 'XSNP_SIGN_REQ')).to.deep.equal([]);

        mesh.setTip(blockIndex + STEP);
        await tickAll(mesh);

        const senders = mesh.sent
            .filter(row => row.type === 'XSNP_SIGN_REQ')
            .map(row => row.sender);
        expect(senders).to.deep.equal([rank1.pubkey]);
        expect(rank0.engine.checkpointNextDue.callCount).to.equal(3);
        expect(await Promise.all(rank0.engine.checkpointNextDue.returnValues))
            .to.deep.equal([false, false, false]);
        const rows = await Promise.all(mesh.nodes.map(node =>
            node.db.getSnapshotCheckpoint('BTC', mesh.network, blockIndex)));
        expect(rows.every(Boolean)).to.equal(true);

        const lines = infoLines(info);
        expect(lines.filter(line => line.includes('fallback_wait') &&
            line.includes('rank 1'))).to.have.length(1);
        expect(lines.filter(line => line.includes('fallback_wait') &&
            line.includes('rank 2'))).to.have.length(1);
        expect(lines.filter(line => line.includes('leading BTC/') &&
            line.includes('as fallback 1'))).to.have.length(1);
    } finally {
        await stopMesh(mesh);
    }
}

async function logsCheckpointSkipOnce(reason, configure) {
    const mesh = await startMesh();
    const blockIndex = snapshotCheckpointBlock(SNAPSHOT_BLOCK, mesh.network);
    const node = configure(mesh, blockIndex);

    try {
        expect(await node.engine.checkpointNextDue()).to.equal(false);
        expect(await node.engine.checkpointNextDue()).to.equal(false);
        expect(infoLines(info).filter(line => line.includes(': ' + reason)))
            .to.have.length(1);
    } finally {
        await stopMesh(mesh);
    }
}

const checkpointSkipCases = [
    [SNAPSHOT_LEADER_SKIP.EMPTY_VALIDATOR_SET, mesh => {
        const node = mesh.nodes[0];
        sinon.stub(node.engine, 'resolveValidators').resolves([]);
        return node;
    }],
    [SNAPSHOT_LEADER_SKIP.INVALID_IDENTITY, mesh => {
        const node = mesh.nodes[0];
        node.engine.identity = {};
        return node;
    }],
    [SNAPSHOT_LEADER_SKIP.NOT_VALIDATOR, mesh => {
        const node = mesh.nodes[0];
        sinon.stub(node.engine, 'resolveValidators').resolves([{ pubkey: key(9) }]);
        return node;
    }],
    [SNAPSHOT_LEADER_SKIP.MISSING_DEPTH, (mesh, blockIndex) => {
        mesh.setTip(blockIndex + 0.5);
        return nodeAtRank(mesh, blockIndex, 1);
    }],
    [SNAPSHOT_LEADER_SKIP.FALLBACK_WAIT, (mesh, blockIndex) => {
        mesh.setTip(blockIndex + STEP - 1);
        return nodeAtRank(mesh, blockIndex, 1);
    }],
];

describe('snapshot checkpoint fallback leader acceptance', function () {
    beforeEach(function () {
        info = sinon.stub(getLogger(), 'info');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('lets rank 1 lead at the fallback step when live rank 0 never leads',
        rankOneLeadsAtFallbackStep);
    for (const [reason, configure] of checkpointSkipCases) {
        it('logs ' + reason + ' once from repeated checkpoint attempts', async function () {
            await logsCheckpointSkipOnce(reason, configure);
        });
    }
});
