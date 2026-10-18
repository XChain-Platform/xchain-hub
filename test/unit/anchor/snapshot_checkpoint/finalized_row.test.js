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
const {
    snapshotCheckpointCanonical,
    snapshotCheckpointQuorum,
} = require('../../../../src/consensus/snapshot_checkpoint/canonical.js');
const {
    snapshotCheckpointRow,
} = require('../../../../src/anchor/snapshot_checkpoint/finalized_row.js');

const hash = character => character.repeat(64);
const signature = character => character.repeat(128);

function checkpoint(changes = {}) {
    return Object.assign({
        chain: 'BTC',
        network: 'testnet',
        block_index: 100,
        block_hash: hash('A'),
        state_root: hash('B'),
        state_root_version: '2',
    }, changes);
}

describe('snapshot checkpoint finalized row', function () {
    it('shapes the insert columns and normalizes the checkpoint', function () {
        const cp = checkpoint();
        const row = snapshotCheckpointRow(cp, [{
            pubkey: hash('A'),
            sig: signature('B'),
        }]);

        expect(Object.keys(row)).to.deep.equal([
            'chain',
            'network',
            'block_index',
            'block_hash',
            'state_root',
            'state_root_version',
            'validator_signatures',
        ]);
        expect(row).to.include({
            chain: 'BTC',
            network: 'testnet',
            block_index: 100,
            block_hash: hash('a'),
            state_root: hash('b'),
            state_root_version: 2,
        });
        expect(row.state_root_version).to.be.a('number');
        expect(row.validator_signatures).to.be.a('string');
    });

    it('filters malformed signatures, keeps the first pubkey, and sorts normalized rows', function () {
        const first = { pubkey: hash('B'), sig: signature('C') };
        const duplicate = { pubkey: hash('b'), sig: signature('D') };
        const rows = JSON.parse(snapshotCheckpointRow(checkpoint(), [
            first,
            { pubkey: 'bad', sig: signature('e') },
            { pubkey: hash('c'), sig: 'bad' },
            { pubkey: hash('A'), sig: signature('F') },
            duplicate,
            null,
        ]).validator_signatures);

        expect(rows).to.deep.equal([
            { pubkey: hash('a'), sig: signature('f') },
            { pubkey: hash('b'), sig: signature('c') },
        ]);
    });

    it('stores byte-identical signature text regardless of reply order', function () {
        const first = { pubkey: hash('a'), sig: signature('c') };
        const second = { pubkey: hash('b'), sig: signature('d') };
        const forward = snapshotCheckpointRow(checkpoint(), [first, second]);
        const reverse = snapshotCheckpointRow(checkpoint(), [second, first]);
        expect(reverse.validator_signatures).to.equal(forward.validator_signatures);
    });

    it('preserves canonical bytes and supplies signers to snapshotCheckpointQuorum', function () {
        const cp = checkpoint();
        const signatures = [
            { pubkey: hash('a'), sig: signature('c') },
            { pubkey: hash('b'), sig: signature('d') },
        ];
        const row = snapshotCheckpointRow(cp, signatures);
        const trustSet = [
            { pubkey: hash('a'), weight: '1', source: 'first' },
            { pubkey: hash('b'), weight: '1', source: 'second' },
        ];

        expect(snapshotCheckpointCanonical(row)).to.equal(snapshotCheckpointCanonical(cp));
        expect(snapshotCheckpointQuorum(row, trustSet, () => true)).to.equal(true);
    });

    it('does not mutate the checkpoint or signatures and returns fresh data', function () {
        const cp = checkpoint();
        const signatures = [{ pubkey: hash('A'), sig: signature('B') }];
        const originalCp = Object.assign({}, cp);
        const originalSignatures = signatures.map(row => Object.assign({}, row));
        const first = snapshotCheckpointRow(cp, signatures);
        const second = snapshotCheckpointRow(cp, signatures);

        expect(cp).to.deep.equal(originalCp);
        expect(signatures).to.deep.equal(originalSignatures);
        expect(first).not.to.equal(second);
    });
});

describe('snapshot checkpoint finalized row validation', function () {
    it('uses canonical checkpoint validation first', function () {
        const validSignature = [{ pubkey: hash('a'), sig: signature('b') }];
        expect(() => snapshotCheckpointRow(null, 'bad'))
            .to.throw('snapshot checkpoint chain must be BTC');
        expect(() => snapshotCheckpointRow(checkpoint({ chain: 'LTC' }), validSignature))
            .to.throw('snapshot checkpoint chain must be BTC');
        expect(() => snapshotCheckpointRow(checkpoint({ block_index: 1.5 }), validSignature))
            .to.throw('snapshot checkpoint block_index must be a safe integer');
        expect(() => snapshotCheckpointRow(checkpoint({ block_hash: 'bad' }), validSignature))
            .to.throw('snapshot checkpoint hashes must be 64-hex');
    });

    it('throws TypeError for an invalid converted state root version', function () {
        const validSignature = [{ pubkey: hash('a'), sig: signature('b') }];
        for (const value of ['bad', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => snapshotCheckpointRow(
                checkpoint({ state_root_version: value }), validSignature
            )).to.throw(TypeError);
        }
    });

    it('throws TypeError unless at least one well-formed signature is supplied', function () {
        const cp = checkpoint();
        expect(() => snapshotCheckpointRow(cp, null)).to.throw(TypeError);
        expect(() => snapshotCheckpointRow(cp, [])).to.throw(TypeError);
        expect(() => snapshotCheckpointRow(cp, [null, { pubkey: 'bad', sig: 'bad' }]))
            .to.throw(TypeError);
    });
});
