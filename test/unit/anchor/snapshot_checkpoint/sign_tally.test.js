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
    snapshotFinalizedRefusal,
} = require('../../../../src/anchor/snapshot_checkpoint/finalize_policy.js');
const {
    SIGN_TALLY_DROP,
    createSnapshotSignTally,
} = require('../../../../src/anchor/snapshot_checkpoint/sign_tally.js');

const hash = (character) => character.repeat(64);

function signer() {
    const pair = crypto.generateKeyPairSync('ed25519');
    return {
        privateKey: pair.privateKey,
        pubkey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex'),
    };
}

function sign(key, cp) {
    const payload = Buffer.from(snapshotCheckpointCanonical(cp), 'utf8');
    return crypto.sign(null, payload, key.privateKey).toString('hex');
}

let keys;
let trustSet;
let checkpoint;

function reply(key, overrides = {}) {
    return Object.assign({
        snapshot_block: 106,
        block_index: checkpoint.block_index,
        pubkey: key.pubkey,
        sig: sign(key, checkpoint),
    }, overrides);
}

function tally(overrides = {}) {
    return createSnapshotSignTally(
        106,
        checkpoint,
        Object.prototype.hasOwnProperty.call(overrides, 'trustSet') ? overrides.trustSet : trustSet,
        Object.prototype.hasOwnProperty.call(overrides, 'verify') ? overrides.verify : ValidatorIdentity.verify
    );
}

beforeEach(function () {
    keys = [signer(), signer(), signer(), signer(), signer()];
    trustSet = keys.slice(0, 4).map((key, index) => ({
        pubkey: key.pubkey,
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

describe('snapshot checkpoint sign tally', function () {
    it('exports its frozen drop vocabulary', function () {
        expect(SIGN_TALLY_DROP).to.deep.equal({
            MALFORMED: 'malformed',
            OTHER_ROUND: 'other_round',
            UNTRUSTED: 'untrusted',
            DUPLICATE: 'duplicate',
            BAD_SIGNATURE: 'bad_signature',
        });
        expect(Object.isFrozen(SIGN_TALLY_DROP)).to.equal(true);
    });

    it('keeps valid signatures in arrival order and returns fresh rows', function () {
        const subject = tally();
        expect(subject.add(reply(keys[1]))).to.equal(null);
        expect(subject.add(reply(keys[0]))).to.equal(null);

        const rows = subject.signatures();
        expect(rows).to.deep.equal([
            { pubkey: keys[1].pubkey, sig: sign(keys[1], checkpoint) },
            { pubkey: keys[0].pubkey, sig: sign(keys[0], checkpoint) },
        ]);
        rows[0].pubkey = 'changed';
        rows.push({ pubkey: 'extra', sig: 'extra' });
        expect(subject.signatures()).to.have.length(2);
        expect(subject.signatures()[0].pubkey).to.equal(keys[1].pubkey);
    });

    it('normalizes uppercase pubkeys before verification and storage', function () {
        const subject = tally();
        const uppercase = keys[0].pubkey.toUpperCase();
        expect(subject.add(reply(keys[0], { pubkey: uppercase }))).to.equal(null);
        expect(subject.signatures()[0].pubkey).to.equal(keys[0].pubkey);
    });
});

describe('snapshot checkpoint sign tally drops', function () {
    it('drops malformed replies first and never throws on hostile input', function () {
        const subject = tally();
        const hostile = {};
        Object.defineProperty(hostile, 'pubkey', { get() { throw new Error('hostile'); } });
        expect(subject.add(null)).to.equal('malformed');
        expect(subject.add(reply(keys[0], { pubkey: 1 }))).to.equal('malformed');
        expect(subject.add(reply(keys[0], { pubkey: 'a'.repeat(63) }))).to.equal('malformed');
        expect(subject.add(reply(keys[0], { sig: null }))).to.equal('malformed');
        expect(subject.add(reply(keys[0], { sig: 'a'.repeat(127) }))).to.equal('malformed');
        expect(subject.add(hostile)).to.equal('malformed');
    });

    it('drops replies for another round before checking trust', function () {
        const subject = tally({ trustSet: [] });
        expect(subject.add(reply(keys[0], { snapshot_block: 107 }))).to.equal('other_round');
        expect(subject.add(reply(keys[0], { block_index: 101 }))).to.equal('other_round');
    });

    it('drops keys outside a missing or empty trust set', function () {
        expect(tally().add(reply(keys[4]))).to.equal('untrusted');
        expect(tally({ trustSet: [] }).add(reply(keys[0]))).to.equal('untrusted');
        expect(tally({ trustSet: null }).add(reply(keys[0]))).to.equal('untrusted');
    });

    it('drops duplicate pubkeys without testing their second signature', function () {
        const subject = tally();
        expect(subject.add(reply(keys[0]))).to.equal(null);
        expect(subject.add(reply(keys[0], { sig: '0'.repeat(128) }))).to.equal('duplicate');
        expect(subject.add(reply(keys[0], { pubkey: keys[0].pubkey.toUpperCase() })))
            .to.equal('duplicate');
    });

    it('drops bad signatures without reserving their pubkey', function () {
        const subject = tally();
        const other = Object.assign({}, checkpoint, { state_root: hash('c') });
        expect(subject.add(reply(keys[0], { sig: sign(keys[0], other) })))
            .to.equal('bad_signature');
        expect(subject.signatures()).to.deep.equal([]);
        expect(subject.add(reply(keys[0]))).to.equal(null);
    });

    it('turns a throwing verifier into a bad_signature drop', function () {
        const subject = tally({ verify() { throw new Error('boom'); } });
        expect(subject.add(reply(keys[0]))).to.equal('bad_signature');
        expect(subject.signatures()).to.deep.equal([]);
    });
});

describe('snapshot checkpoint sign tally integration', function () {
    it('computes canonical input at construction and rejects an invalid checkpoint', function () {
        const invalid = Object.assign({}, checkpoint, { chain: 'LTC' });
        expect(() => createSnapshotSignTally(106, invalid, trustSet, ValidatorIdentity.verify))
            .to.throw('snapshot checkpoint chain must be BTC');
    });

    it('feeds finalize_policy with below-quorum and quorum signature rows', function () {
        const subject = tally();
        const view = {
            network: 'testnet',
            gateActive: true,
            expectedBlock: 100,
            trustSet,
            verify: ValidatorIdentity.verify,
            stored: null,
        };
        expect(subject.add(reply(keys[0]))).to.equal(null);
        expect(subject.add(reply(keys[1]))).to.equal(null);
        expect(snapshotFinalizedRefusal({
            snapshot_block: 106,
            cp: checkpoint,
            signatures: subject.signatures(),
        }, view)).to.equal('below_quorum');

        expect(subject.add(reply(keys[2]))).to.equal(null);
        expect(snapshotFinalizedRefusal({
            snapshot_block: 106,
            cp: checkpoint,
            signatures: subject.signatures(),
        }, view)).to.equal(null);
    });
});
