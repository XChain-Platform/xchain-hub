'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const {
    buildSnapshotCosignView,
} = require('../../../../src/anchor/snapshot_checkpoint/cosign_view.js');
const {
    snapshotCheckpointBlock,
} = require('../../../../src/consensus/snapshot_checkpoint/canonical.js');
const {
    snapshotCheckpointFromBlockHashes,
} = require('../../../../src/anchor/snapshot_checkpoint/payload.js');
const {
    buildSnapshotSignRequest,
} = require('../../../../src/anchor/snapshot_checkpoint/sign_request.js');
const {
    snapshotCosignRefusal,
} = require('../../../../src/anchor/snapshot_checkpoint/cosign_policy.js');
const {
    buildSnapshotMesh,
} = require('./support/snapshot_mesh.js');

const SNAPSHOT_BLOCK = 400;
const NETWORK = 'regtest';

async function fixture() {
    const mesh = buildSnapshotMesh({ n: 3 });
    const blockIndex = snapshotCheckpointBlock(SNAPSHOT_BLOCK, NETWORK);
    const leader = mesh.leaderAt(blockIndex);
    const cosigner = mesh.nodes.find(node => node !== leader);
    const blockHashes = await leader.stateCheckpoints.indexerCall(
        'BTC', 'getblockhashes', { block_index: blockIndex }
    );
    const cp = snapshotCheckpointFromBlockHashes(NETWORK, blockHashes, blockIndex);
    const req = buildSnapshotSignRequest(leader.identity, SNAPSHOT_BLOCK, cp);
    const reads = { indexer: 0, stored: 0 };
    const indexerCall = cosigner.stateCheckpoints.indexerCall.bind(
        cosigner.stateCheckpoints
    );
    cosigner.stateCheckpoints.indexerCall = async(...args) => {
        reads.indexer += 1;
        return indexerCall(...args);
    };
    const getSnapshotCheckpoint = cosigner.db.getSnapshotCheckpoint.bind(cosigner.db);
    cosigner.db.getSnapshotCheckpoint = async(...args) => {
        reads.stored += 1;
        return getSnapshotCheckpoint(...args);
    };
    const context = changes => Object.assign({
        stateCheckpoints: cosigner.stateCheckpoints,
        db: cosigner.db,
        network: NETWORK,
        confirmations: mesh.confirmations,
        gateActive: true,
        expectedBlock: blockIndex,
    }, changes);
    return { mesh, blockIndex, cosigner, cp, req, reads, context };
}

describe('buildSnapshotCosignView accepted requests', function () {
    it('builds the clean local view consumed by snapshotCosignRefusal', async function () {
        const { blockIndex, cp, req, reads, context } = await fixture();
        const view = await buildSnapshotCosignView(req, context());

        expect(snapshotCosignRefusal(req, view)).to.equal(null);
        expect(view).to.deep.equal({
            network: NETWORK,
            gateActive: true,
            expectedBlock: blockIndex,
            committedHeight: 500,
            chainHeight: 500,
            confirmations: 6,
            local: cp,
            stored: null,
        });
        expect(view).not.to.have.property('signed');
        expect(reads).to.deep.equal({ indexer: 1, stored: 1 });
    });

    it('normalizes string checkpoint heights to numbers', async function () {
        const { cosigner, req, context } = await fixture();
        cosigner.committedTip = '500';
        cosigner.chainTip = '501';
        const view = await buildSnapshotCosignView(req, context());
        expect(view.committedHeight).to.equal(500);
        expect(view.chainHeight).to.equal(501);
        expect(snapshotCosignRefusal(req, view)).to.equal(null);
    });

    it('returns a stored row for conflict fencing', async function () {
        const { cosigner, cp, req, context } = await fixture();
        const stored = Object.assign({}, cp, {
            block_hash: 'c'.repeat(64),
            validator_signatures: '[]',
        });
        await cosigner.db.insertSnapshotCheckpoint(stored);
        const view = await buildSnapshotCosignView(req, context());
        expect(view.stored).to.deep.equal(stored);
        expect(snapshotCosignRefusal(req, view)).to.equal('conflicting_payload');
    });
});

describe('buildSnapshotCosignView early refusals', function () {
    it('returns an inactive gate view without reading', async function () {
        const { req, reads, context } = await fixture();
        const view = await buildSnapshotCosignView(req, context({ gateActive: false }));
        expect(snapshotCosignRefusal(req, view)).to.equal('gate_inactive');
        expect(reads).to.deep.equal({ indexer: 0, stored: 0 });
    });

    it('returns a wrong block view without reading', async function () {
        const { req, reads, context, blockIndex } = await fixture();
        const view = await buildSnapshotCosignView(req, context({
            expectedBlock: blockIndex + 1,
        }));
        expect(snapshotCosignRefusal(req, view)).to.equal('wrong_block');
        expect(reads).to.deep.equal({ indexer: 0, stored: 0 });
    });

    it('returns a shallow view without indexer or stored reads', async function () {
        const { mesh, cosigner, req, reads, context, blockIndex } = await fixture();
        cosigner.committedTip = blockIndex + mesh.confirmations - 1;
        cosigner.chainTip = blockIndex + 100;
        const view = await buildSnapshotCosignView(req, context());
        expect(snapshotCosignRefusal(req, view)).to.equal('shallow');
        expect(reads).to.deep.equal({ indexer: 0, stored: 0 });
    });

    it('treats a failing tip read as shallow and stops', async function () {
        const { cosigner, req, reads, context } = await fixture();
        cosigner.hub.resolveBtcCheckpointHeights = async() => {
            throw new Error('unavailable');
        };
        const view = await buildSnapshotCosignView(req, context());
        expect(snapshotCosignRefusal(req, view)).to.equal('shallow');
        expect(reads).to.deep.equal({ indexer: 0, stored: 0 });
    });
});

describe('buildSnapshotCosignView local and stored reads', function () {
    it('returns a missing local payload when the indexer is down', async function () {
        const { cosigner, req, reads, context } = await fixture();
        cosigner.indexerDown = true;
        const view = await buildSnapshotCosignView(req, context());
        expect(view.local).to.equal(null);
        expect(snapshotCosignRefusal(req, view)).to.equal('local_mismatch');
        expect(reads).to.deep.equal({ indexer: 1, stored: 1 });
    });

    it('returns a different local payload for a tampered block', async function () {
        const { cosigner, req, context, blockIndex } = await fixture();
        cosigner.tamper(blockIndex, { state_root: 'e'.repeat(64) });
        const view = await buildSnapshotCosignView(req, context());
        expect(snapshotCosignRefusal(req, view)).to.equal('local_mismatch');
    });

    it('returns null when the stored-row read fails', async function () {
        const { cosigner, req, context } = await fixture();
        cosigner.db.getSnapshotCheckpoint = async() => {
            throw new Error('unavailable');
        };
        expect(await buildSnapshotCosignView(req, context())).to.equal(null);
    });
});

describe('buildSnapshotCosignView malformed inputs', function () {
    it('returns null for invalid contexts without rejecting', async function () {
        const { req, context, cosigner } = await fixture();
        const cases = [
            null,
            context({ network: '' }),
            context({ stateCheckpoints: { hub: cosigner.hub } }),
            context({ db: {} }),
        ];
        for(const ctx of cases) {
            expect(await buildSnapshotCosignView(req, ctx)).to.equal(null);
        }
    });

    it('returns a malformed view without reading for bad requests', async function () {
        const { reads, context } = await fixture();
        const requests = [
            null,
            {},
            { snapshot_block: SNAPSHOT_BLOCK, cp: null },
            { snapshot_block: SNAPSHOT_BLOCK, cp: { block_index: -1 } },
            { snapshot_block: SNAPSHOT_BLOCK, cp: { block_index: '0' } },
        ];
        for(const req of requests) {
            const view = await buildSnapshotCosignView(req, context());
            expect(snapshotCosignRefusal(req, view)).to.equal('malformed');
        }
        expect(reads).to.deep.equal({ indexer: 0, stored: 0 });
    });

    it('returns null when a dependency accessor throws', async function () {
        const { req, context } = await fixture();
        const ctx = context();
        Object.defineProperty(ctx, 'network', {
            get() { throw new Error('unavailable'); },
        });
        expect(await buildSnapshotCosignView(req, ctx)).to.equal(null);
    });
});
