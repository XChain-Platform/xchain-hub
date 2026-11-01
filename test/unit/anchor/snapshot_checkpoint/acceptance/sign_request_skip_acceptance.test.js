'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const { getLogger } = require('../../../../../src/observability');
const { snapshotCheckpointBlock } = require(
    '../../../../../src/consensus/snapshot_checkpoint/canonical.js');
const { XSNP_SIGN_REQ } = require('../../../../../src/anchor/snapshot_checkpoint/constants.js');
const SnapshotCheckpointEngine = require('../../../../../src/anchor/snapshot_checkpoint/engine.js');
const { snapshotLeaderRank } = require('../../../../../src/anchor/snapshot_checkpoint/leader.js');
const { snapshotCheckpointFromBlockHashes } = require('../../../../../src/anchor/snapshot_checkpoint/payload.js');
const snapshotRound = require('../../../../../src/anchor/snapshot_checkpoint/round.js');
const { buildSnapshotSignRequest } = require('../../../../../src/anchor/snapshot_checkpoint/sign_request.js');
const { buildSnapshotMesh } = require(
    '../support/snapshot_mesh.js');

const SNAPSHOT_BLOCK = 406;
const hash = character => character.repeat(64);

function nodeAtRank(mesh, blockIndex, rank) {
    return mesh.nodes.find(node =>
        snapshotLeaderRank(blockIndex, mesh.validators, node.pubkey) === rank);
}

async function requestAt(mesh, blockIndex, rank = 0) {
    const sender = nodeAtRank(mesh, blockIndex, rank);
    const row = await sender.stateCheckpoints.indexerCall(
        'BTC', 'getblockhashes', { block_index: blockIndex });
    const cp = snapshotCheckpointFromBlockHashes(mesh.network, row, blockIndex);
    return {
        request: buildSnapshotSignRequest(sender.identity, SNAPSHOT_BLOCK, cp),
        sender,
    };
}

function targetFor(mesh, sender) {
    const target = mesh.nodes.find(node => node !== sender);
    target.engine = new SnapshotCheckpointEngine(target.stateCheckpoints);
    return target;
}

async function malformedEnvelope(mesh) {
    const target = mesh.nodes[0];
    target.engine = new SnapshotCheckpointEngine(target.stateCheckpoints);
    return { target, sender: hash('9'), request: {} };
}

async function malformedRequest(mesh, blockIndex) {
    const testCase = await requestAt(mesh, blockIndex);
    testCase.target = targetFor(mesh, testCase.sender);
    testCase.request.sig = '0';
    return testCase;
}

async function nonLeaderRequest(mesh, blockIndex) {
    const dueHeight = blockIndex + mesh.confirmations;
    mesh.setHeights(dueHeight, dueHeight);
    const testCase = await requestAt(mesh, blockIndex, 1);
    testCase.target = targetFor(mesh, testCase.sender);
    return testCase;
}

async function badSignatureRequest(mesh, blockIndex) {
    const testCase = await requestAt(mesh, blockIndex);
    testCase.target = targetFor(mesh, testCase.sender);
    testCase.request.sig = hash('0') + hash('0');
    return testCase;
}

async function inactiveGateRequest(mesh, blockIndex) {
    const testCase = await requestAt(mesh, blockIndex);
    testCase.target = targetFor(mesh, testCase.sender);
    sinon.stub(testCase.target.engine, 'gateActive').returns(false);
    return testCase;
}

async function wrongBlockRequest(mesh, blockIndex) {
    const testCase = await requestAt(mesh, blockIndex + 1);
    testCase.target = targetFor(mesh, testCase.sender);
    return testCase;
}

async function shallowRequest(mesh, blockIndex) {
    const dueHeight = blockIndex + mesh.confirmations;
    mesh.setHeights(dueHeight - 1, dueHeight + 100);
    const testCase = await requestAt(mesh, blockIndex);
    testCase.target = targetFor(mesh, testCase.sender);
    return testCase;
}

async function localMismatchRequest(mesh, blockIndex) {
    const testCase = await requestAt(mesh, blockIndex);
    testCase.target = targetFor(mesh, testCase.sender);
    testCase.target.tamper(blockIndex, { state_root: hash('f') });
    return testCase;
}

async function conflictingPayloadRequest(mesh, blockIndex) {
    const testCase = await requestAt(mesh, blockIndex);
    testCase.target = targetFor(mesh, testCase.sender);
    testCase.target.engine.signedRecord.claim(Object.assign({}, testCase.request.cp, {
        state_root: hash('f'),
    }));
    return testCase;
}

const refusalCases = [
    ['malformed envelope', 'sign_request_malformed', malformedEnvelope],
    ['malformed request', 'sign_request_malformed', malformedRequest],
    ['non-leader request', 'sign_request_not_leader', nonLeaderRequest],
    ['bad signature', 'sign_request_bad_leader_signature', badSignatureRequest],
    ['inactive gate', 'sign_request_gate_inactive', inactiveGateRequest],
    ['wrong block', 'sign_request_wrong_block', wrongBlockRequest],
    ['shallow checkpoint', 'sign_request_shallow', shallowRequest],
    ['local mismatch', 'sign_request_local_mismatch', localMismatchRequest],
    ['conflicting payload', 'sign_request_conflicting_payload', conflictingPayloadRequest],
];

describe('snapshot checkpoint sign-request skip acceptance', function () {
    let info;

    beforeEach(function () {
        info = sinon.stub(getLogger(), 'info');
    });

    afterEach(function () {
        sinon.restore();
    });

    for (const [name, reason, setup] of refusalCases) {
        it('logs ' + name + ' once from repeated peer messages', async function () {
            const mesh = buildSnapshotMesh({ n: 3 });
            const blockIndex = snapshotCheckpointBlock(SNAPSHOT_BLOCK, mesh.network);
            const testCase = await setup(mesh, blockIndex);
            const envelope = {
                type: XSNP_SIGN_REQ,
                sender: testCase.sender.pubkey || testCase.sender,
                data: testCase.request,
            };

            await snapshotRound.handleMessage(testCase.target.engine, envelope);
            await snapshotRound.handleMessage(testCase.target.engine, envelope);

            const lines = info.args.map(args => String(args[0]));
            expect(lines.filter(line => line.includes(': ' + reason))).to.have.length(1);
            expect(mesh.sent).to.deep.equal([]);
        });
    }
});
