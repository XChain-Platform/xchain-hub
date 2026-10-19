'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const { snapshotCheckpointFromBlockHashes } = require('../../../../src/anchor/snapshot_checkpoint/payload.js');

const hex = (character) => character.repeat(64);

function blockHashes(overrides) {
    return Object.assign({
        block_index: 100,
        block_hash: hex('A'),
        state_root: hex('B'),
        state_root_version: '2',
        ledger_hash: hex('c'),
        actions_hash: hex('d'),
    }, overrides);
}

function registerPayloadShapeTests() {
    it('builds only the six signed fields from a rooted block', function () {
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes(), 100)).to.deep.equal({
            chain: 'BTC',
            network: 'testnet',
            block_index: 100,
            block_hash: hex('a'),
            state_root: hex('b'),
            state_root_version: 2,
        });
    });

    it('accepts a string block_index when it identifies the requested block', function () {
        expect(snapshotCheckpointFromBlockHashes('regtest', blockHashes({ block_index: '7' }), 7))
            .to.deep.equal({
                chain: 'BTC',
                network: 'regtest',
                block_index: 7,
                block_hash: hex('a'),
                state_root: hex('b'),
                state_root_version: 2,
            });
    });
}

function registerInputRefusalTests() {
    it('refuses a missing or non-object block-hashes answer without throwing', function () {
        expect(snapshotCheckpointFromBlockHashes('testnet', null, 100)).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes('testnet', 'block', 100)).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes('testnet', [], 100)).to.equal(null);
    });

    it('refuses a rootless block or an invalid state root', function () {
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes({ state_root: null }), 100)).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes({ state_root: undefined }), 100)).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes({ state_root: hex('b').slice(1) }), 100)).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes({ state_root: hex('z') }), 100)).to.equal(null);
    });

    it('refuses a missing or invalid block hash', function () {
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes({ block_hash: null }), 100)).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes({ block_hash: hex('a').slice(1) }), 100)).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes({ block_hash: hex('z') }), 100)).to.equal(null);
    });

    it('refuses a missing or invalid state_root_version', function () {
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes({ state_root_version: null }), 100)).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes({ state_root_version: undefined }), 100)).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes({ state_root_version: 1.5 }), 100)).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes({ state_root_version: -1 }), 100)).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes({ state_root_version: Number.MAX_SAFE_INTEGER + 1 }), 100)).to.equal(null);
    });

    it('refuses an invalid or mismatched requested block', function () {
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes(), 99)).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes(), '100')).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes({ block_index: 100.5 }), 100.5)).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes({ block_index: -1 }), -1)).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes('testnet', blockHashes({ block_index: Number.MAX_SAFE_INTEGER + 1 }), Number.MAX_SAFE_INTEGER + 1)).to.equal(null);
    });

    it('refuses a network that is not a non-empty string', function () {
        expect(snapshotCheckpointFromBlockHashes('', blockHashes(), 100)).to.equal(null);
        expect(snapshotCheckpointFromBlockHashes(null, blockHashes(), 100)).to.equal(null);
    });

    it('returns null when an input accessor throws', function () {
        const bh = blockHashes();
        Object.defineProperty(bh, 'block_hash', { get() { throw new Error('unavailable'); } });
        expect(snapshotCheckpointFromBlockHashes('testnet', bh, 100)).to.equal(null);
    });
}

describe('snapshotCheckpointFromBlockHashes', function () {
    registerPayloadShapeTests();
    registerInputRefusalTests();
});
