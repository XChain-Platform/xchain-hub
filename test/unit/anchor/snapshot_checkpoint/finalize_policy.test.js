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
const crypto = require('crypto');
const {
    snapshotCheckpointCanonical,
} = require('../../../../src/consensus/snapshot_checkpoint/canonical.js');
const ValidatorIdentity = require('../../../../src/validators/identity.js');
const {
    FINALIZE_REFUSAL,
    snapshotFinalizedRefusal,
} = require('../../../../src/anchor/snapshot_checkpoint/finalize_policy.js');

const hash = (character) => character.repeat(64);

function signer() {
    const pair = crypto.generateKeyPairSync('ed25519');
    return {
        privateKey: pair.privateKey,
        pubkey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex'),
    };
}

describe('snapshot checkpoint finalize policy', function () {
    let keys;
    let trustSet;
    let checkpoint;

    function signatures(signers, signedCheckpoint = checkpoint) {
        const payload = Buffer.from(snapshotCheckpointCanonical(signedCheckpoint), 'utf8');
        return signers.map((entry) => ({
            pubkey: entry.pubkey,
            sig: crypto.sign(null, payload, entry.privateKey).toString('hex'),
        }));
    }

    function message(overrides = {}, signers = keys.slice(0, 3)) {
        const cp = Object.assign({}, checkpoint, overrides);
        return { snapshot_block: 106, cp, signatures: signatures(signers, cp) };
    }

    function malformedCheckpoint(overrides) {
        const msg = message();
        Object.assign(msg.cp, overrides);
        return msg;
    }

    function view(overrides = {}) {
        return Object.assign({
            network: 'testnet',
            gateActive: true,
            expectedBlock: 100,
            trustSet,
            verify: ValidatorIdentity.verify,
            stored: null,
        }, overrides);
    }

    beforeEach(function () {
        keys = [signer(), signer(), signer(), signer(), signer()];
        trustSet = keys.slice(0, 4).map((entry, index) => ({
            pubkey: entry.pubkey,
            weight: '1',
            source: 'source-' + index,
        }));
        checkpoint = {
            chain: 'BTC',
            network: 'testnet',
            block_index: 100,
            block_hash: hash('a'),
            state_root: hash('b'),
            state_root_version: 2,
        };
    });

    it('exports its frozen refusal vocabulary', function () {
        expect(FINALIZE_REFUSAL).to.deep.equal({
            MALFORMED: 'malformed',
            GATE_INACTIVE: 'gate_inactive',
            WRONG_BLOCK: 'wrong_block',
            BELOW_QUORUM: 'below_quorum',
            CONFLICTING_PAYLOAD: 'conflicting_payload',
        });
        expect(Object.isFrozen(FINALIZE_REFUSAL)).to.equal(true);
    });

    it('accepts three of four equal-stake sources', function () {
        expect(snapshotFinalizedRefusal(message(), view())).to.equal(null);
    });

    it('accepts uppercase hashes and an identical stored payload', function () {
        const msg = message({ block_hash: hash('A'), state_root: hash('B') });
        const stored = {
            block_hash: hash('a'),
            state_root: hash('b'),
            state_root_version: '2',
        };
        expect(snapshotFinalizedRefusal(msg, view({ stored }))).to.equal(null);
    });

    it('validates message signatures and ignores checkpoint signatures', function () {
        const msg = message();
        msg.cp.validator_signatures = signatures(keys.slice(0, 4), msg.cp);
        msg.signatures = [];
        expect(snapshotFinalizedRefusal(msg, view())).to.equal('below_quorum');
    });

    it('refuses malformed envelope fields', function () {
        const cases = [
            null,
            { snapshot_block: 106, signatures: [] },
            Object.assign(message(), { snapshot_block: -1 }),
            Object.assign(message(), { snapshot_block: 1.5 }),
            Object.assign(message(), { signatures: 'not-an-array' }),
            malformedCheckpoint({ chain: 'LTC' }),
            malformedCheckpoint({ network: 'mainnet' }),
            malformedCheckpoint({ block_index: -1 }),
            malformedCheckpoint({ block_index: 100.5 }),
            malformedCheckpoint({ block_hash: hash('a').slice(1) }),
            malformedCheckpoint({ state_root: hash('z') }),
            malformedCheckpoint({ state_root_version: 'not-a-number' }),
            malformedCheckpoint({ state_root_version: -1 }),
        ];
        for (const msg of cases)
            expect(snapshotFinalizedRefusal(msg, view())).to.equal('malformed');
    });

    it('never throws on absent or hostile inputs', function () {
        const hostile = {};
        Object.defineProperty(hostile, 'cp', { get() { throw new Error('hostile'); } });
        expect(snapshotFinalizedRefusal(message(), null)).to.equal('malformed');
        expect(snapshotFinalizedRefusal(hostile, view())).to.equal('malformed');
    });

    it('checks the gate before the expected block', function () {
        expect(snapshotFinalizedRefusal(message(), view({ gateActive: false })))
            .to.equal('gate_inactive');
        expect(snapshotFinalizedRefusal(message({ block_index: 99 }), view({ gateActive: false })))
            .to.equal('gate_inactive');
    });

    it('refuses a block other than the expected burial', function () {
        expect(snapshotFinalizedRefusal(message({ block_index: 99 }), view()))
            .to.equal('wrong_block');
    });

    it('requires more than two-thirds of source stake', function () {
        expect(snapshotFinalizedRefusal(message({}, keys.slice(0, 2)), view()))
            .to.equal('below_quorum');
    });

    it('counts a duplicated signer once', function () {
        expect(snapshotFinalizedRefusal(message({}, [keys[0], keys[0], keys[1]]), view()))
            .to.equal('below_quorum');
    });

    it('does not count a signer outside the trust set', function () {
        expect(snapshotFinalizedRefusal(message({}, [keys[0], keys[1], keys[4]]), view()))
            .to.equal('below_quorum');
    });

    it('does not count a forged signature', function () {
        const msg = message({}, keys.slice(0, 2));
        msg.signatures.push({ pubkey: keys[2].pubkey, sig: '0'.repeat(128) });
        expect(snapshotFinalizedRefusal(msg, view())).to.equal('below_quorum');
    });

    it('does not count signatures over another payload', function () {
        const msg = message();
        msg.signatures = signatures(keys.slice(0, 3), Object.assign({}, checkpoint, {
            state_root: hash('c'),
        }));
        expect(snapshotFinalizedRefusal(msg, view())).to.equal('below_quorum');
    });

    it('holds an empty trust set or missing verifier', function () {
        expect(snapshotFinalizedRefusal(message(), view({ trustSet: [] })))
            .to.equal('below_quorum');
        expect(snapshotFinalizedRefusal(message(), view({ verify: null })))
            .to.equal('below_quorum');
    });

    it('checks quorum before a stored conflict', function () {
        const stored = Object.assign({}, checkpoint, { block_hash: hash('d') });
        expect(snapshotFinalizedRefusal(message({}, keys.slice(0, 2)), view({ stored })))
            .to.equal('below_quorum');
    });

    it('refuses each kind of stored payload conflict', function () {
        const differences = [
            { block_hash: hash('d') },
            { state_root: hash('d') },
            { state_root_version: 1 },
        ];
        for (const difference of differences) {
            const stored = Object.assign({}, checkpoint, difference);
            expect(snapshotFinalizedRefusal(message(), view({ stored })))
                .to.equal('conflicting_payload');
        }
    });
});
