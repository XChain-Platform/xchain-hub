'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const SnapshotCheckpointEngine = require(
    '../../../../src/anchor/snapshot_checkpoint/engine.js');
const {
    snapshotCheckpointBlock,
    snapshotCheckpointCanonical,
} = require('../../../../src/consensus/snapshot_checkpoint/canonical.js');
const { buildSnapshotFinalized } = require(
    '../../../../src/anchor/snapshot_checkpoint/finalized_message.js');
const { buildSnapshotSignRequest } = require(
    '../../../../src/anchor/snapshot_checkpoint/sign_request.js');
const { buildSnapshotMesh } = require('./support/snapshot_mesh.js');

const SNAPSHOT_BLOCK = 406;

async function flush(count = 16) {
    for (let i = 0; i < count; i++)
        await new Promise(resolve => setImmediate(resolve));
}

async function startMesh(options = {}) {
    const mesh = buildSnapshotMesh(options);
    for (const node of mesh.nodes) {
        node.stateCheckpoints.handleMessage = () => {};
        node.stateCheckpoints.peerManager.on('message', envelope =>
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

async function checkpoint(mesh, blockIndex = snapshotCheckpointBlock(
    SNAPSHOT_BLOCK, mesh.network)) {
    const row = await mesh.nodes[0].stateCheckpoints.indexerCall(
        'BTC', 'getblockhashes', { block_index: blockIndex });
    return {
        chain: 'BTC',
        network: mesh.network,
        block_index: blockIndex,
        block_hash: row.block_hash,
        state_root: row.state_root,
        state_root_version: row.state_root_version,
    };
}

function repliesFrom(mesh, node) {
    return mesh.sent.filter(row => row.type === 'XSNP_SIGN' && row.sender === node.pubkey);
}

function expectNoCadenceMessages(mesh) {
    expect(mesh.sent.filter(row => /^XCHK_/.test(row.type))).to.deep.equal([]);
}

describe('snapshot checkpoint co-sign round', function () {
    for (const n of [3, 4]) {
        it('persists the same quorum row across ' + n + ' honest hubs', async function () {
            const mesh = await startMesh({ n, timeoutMs: 40 });
            try {
                const blockIndex = snapshotCheckpointBlock(SNAPSHOT_BLOCK, mesh.network);
                await mesh.leaderAt(blockIndex).engine.tick();
                await flush();

                const rows = await Promise.all(mesh.nodes.map(node => node.db
                    .getSnapshotCheckpoint('BTC', mesh.network, blockIndex)));
                expect(rows.every(Boolean)).to.equal(true);
                expect(rows.slice(1)).to.deep.equal(rows.slice(1).map(() => rows[0]));
                expect(JSON.parse(rows[0].validator_signatures).length).to.be.within(3, n);
                expect(mesh.sent.filter(row => row.type === 'XSNP_SIGN_REQ')).to.have.length(1);
                expect(mesh.sent.filter(row => row.type === 'XSNP_FINALIZED')).to.have.length(1);
                expectNoCadenceMessages(mesh);
            } finally {
                await stopMesh(mesh);
            }
        });
    }

    it('drops a timed-out round and re-leads it on the next tick', async function () {
        const mesh = await startMesh({ n: 3, timeoutMs: 12 });
        // Only the round timer is faked, so flush() still drains setImmediate.
        const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            mesh.drop = envelope => envelope.type === 'XSNP_SIGN';
            const blockIndex = snapshotCheckpointBlock(SNAPSHOT_BLOCK, mesh.network);
            const leader = mesh.leaderAt(blockIndex);
            await leader.engine.tick();
            await flush();
            expect(leader.engine.snapshotRounds.size).to.equal(1);
            clock.tick(13);
            expect(leader.engine.snapshotRounds.size).to.equal(0);

            await leader.engine.tick();
            await flush();
            expect(mesh.sent.filter(row => row.type === 'XSNP_SIGN_REQ')).to.have.length(2);
            expectNoCadenceMessages(mesh);
        } finally {
            clock.restore();
            await stopMesh(mesh);
        }
    });
});

describe('snapshot checkpoint co-sign refusals', function () {
    for (const field of ['block_hash', 'state_root']) {
        it('refuses a local ' + field + ' mismatch', async function () {
            const mesh = await startMesh({ n: 3 });
            try {
                const cp = await checkpoint(mesh);
                const leader = mesh.leaderAt(cp.block_index);
                const target = mesh.nodes.find(node => node !== leader);
                target.tamper(cp.block_index, { [field]: 'e'.repeat(64) });
                leader.hub.getPeerManager().broadcast(
                    'XSNP_SIGN_REQ', buildSnapshotSignRequest(
                        leader.identity, SNAPSHOT_BLOCK, cp));
                await flush();
                expect(repliesFrom(mesh, target)).to.have.length(0);
                expectNoCadenceMessages(mesh);
            } finally {
                await stopMesh(mesh);
            }
        });
    }
});

describe('snapshot checkpoint co-sign refusals', function () {
    it('refuses a checkpoint shallower than the local confirmation floor', async function () {
        const mesh = await startMesh({ n: 3 });
        try {
            const cp = await checkpoint(mesh);
            const leader = mesh.leaderAt(cp.block_index);
            const target = mesh.nodes.find(node => node !== leader);
            target.engine.confirmations = 6;
            target.btcTip = cp.block_index + 5;
            leader.hub.getPeerManager().broadcast(
                'XSNP_SIGN_REQ', buildSnapshotSignRequest(
                    leader.identity, SNAPSHOT_BLOCK, cp));
            await flush();
            expect(repliesFrom(mesh, target)).to.have.length(0);
            expectNoCadenceMessages(mesh);
        } finally {
            await stopMesh(mesh);
        }
    });

    it('refuses a block other than the burial of the snapshot block', async function () {
        const mesh = await startMesh({ n: 3 });
        try {
            const expected = snapshotCheckpointBlock(SNAPSHOT_BLOCK, mesh.network);
            const cp = await checkpoint(mesh, expected + 1);
            const leader = mesh.leaderAt(cp.block_index);
            leader.hub.getPeerManager().broadcast(
                'XSNP_SIGN_REQ', buildSnapshotSignRequest(
                    leader.identity, SNAPSHOT_BLOCK, cp));
            await flush();
            expect(mesh.sent.filter(row => row.type === 'XSNP_SIGN')).to.have.length(0);
            expectNoCadenceMessages(mesh);
        } finally {
            await stopMesh(mesh);
        }
    });
});

describe('snapshot checkpoint co-sign refusals', function () {
    it('refuses a request while the local gate is inactive', async function () {
        const mesh = await startMesh({ n: 3 });
        try {
            const cp = await checkpoint(mesh);
            const leader = mesh.leaderAt(cp.block_index);
            const target = mesh.nodes.find(node => node !== leader);
            target.engine.gateActive = () => false;
            leader.hub.getPeerManager().broadcast(
                'XSNP_SIGN_REQ', buildSnapshotSignRequest(
                    leader.identity, SNAPSHOT_BLOCK, cp));
            await flush();
            expect(repliesFrom(mesh, target)).to.have.length(0);
            expectNoCadenceMessages(mesh);
        } finally {
            await stopMesh(mesh);
        }
    });

    it('refuses a second payload for the same checkpoint block', async function () {
        const mesh = await startMesh({ n: 3 });
        try {
            const first = await checkpoint(mesh);
            const leader = mesh.leaderAt(first.block_index);
            const target = mesh.nodes.find(node => node !== leader);
            leader.hub.getPeerManager().broadcast(
                'XSNP_SIGN_REQ', buildSnapshotSignRequest(
                    leader.identity, SNAPSHOT_BLOCK, first));
            await flush();
            expect(repliesFrom(mesh, target)).to.have.length(1);

            mesh.sent.length = 0;
            const second = { ...first, state_root: 'd'.repeat(64) };
            target.tamper(first.block_index, { state_root: second.state_root });
            leader.hub.getPeerManager().broadcast(
                'XSNP_SIGN_REQ', buildSnapshotSignRequest(
                    leader.identity, SNAPSHOT_BLOCK, second));
            await flush();
            expect(repliesFrom(mesh, target)).to.have.length(0);
            expect(target.engine.signedRecord.held(mesh.network, first.block_index)
                .state_root).to.equal(first.state_root);
            expectNoCadenceMessages(mesh);
        } finally {
            await stopMesh(mesh);
        }
    });
});

describe('snapshot checkpoint finalized refusal', function () {
    async function finalizedFixture() {
        const mesh = await startMesh({ n: 4 });
        const cp = await checkpoint(mesh);
        const signatures = mesh.nodes.map(node => ({
            pubkey: node.pubkey,
            sig: node.identity.sign(snapshotCheckpointCanonical(cp)),
        }));
        return { mesh, cp, signatures };
    }

    it('does not persist a below-quorum FINALIZED message', async function () {
        const { mesh, cp, signatures } = await finalizedFixture();
        try {
            const target = mesh.nodes[1];
            mesh.nodes[0].hub.getPeerManager().broadcast('XSNP_FINALIZED',
                buildSnapshotFinalized(SNAPSHOT_BLOCK, cp, signatures.slice(0, 2)));
            await flush();
            expect(await target.db.getSnapshotCheckpoint(
                'BTC', mesh.network, cp.block_index)).to.equal(null);
            expectNoCadenceMessages(mesh);
        } finally {
            await stopMesh(mesh);
        }
    });

    it('does not persist a FINALIZED message with a forged quorum member', async function () {
        const { mesh, cp, signatures } = await finalizedFixture();
        try {
            signatures[2].sig = '0'.repeat(128);
            const target = mesh.nodes[1];
            mesh.nodes[0].hub.getPeerManager().broadcast('XSNP_FINALIZED',
                buildSnapshotFinalized(SNAPSHOT_BLOCK, cp, signatures.slice(0, 3)));
            await flush();
            expect(await target.db.getSnapshotCheckpoint(
                'BTC', mesh.network, cp.block_index)).to.equal(null);
            expectNoCadenceMessages(mesh);
        } finally {
            await stopMesh(mesh);
        }
    });
});
