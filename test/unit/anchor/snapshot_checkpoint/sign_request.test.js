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

const assert = require('assert');
const crypto = require('crypto');
const ValidatorIdentity = require('../../../../src/validators/identity.js');
const { leadsSnapshotSlot } = require('../../../../src/anchor/snapshot_checkpoint/leader.js');
const {
    createSnapshotSignTally,
} = require('../../../../src/anchor/snapshot_checkpoint/sign_tally.js');
const {
    snapshotCosignRefusal,
} = require('../../../../src/anchor/snapshot_checkpoint/cosign_policy.js');
const {
    SIGN_REQUEST_REFUSAL,
    buildSnapshotSignReply,
    buildSnapshotSignRequest,
    snapshotSignRequestRefusal,
} = require('../../../../src/anchor/snapshot_checkpoint/sign_request.js');

const hash = character => character.repeat(64);

let identities;
let validators;
let checkpoint;
let leader;
let other;

function identity() {
    return new ValidatorIdentity(crypto.randomBytes(32).toString('hex'));
}

function refusal(req, set = validators, verify = ValidatorIdentity.verify) {
    return snapshotSignRequestRefusal(req, set, verify);
}

beforeEach(function () {
    identities = [identity(), identity(), identity()];
    validators = identities.map((signer, index) => ({
        pubkey: signer.getPubkeyHex(),
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
    leader = identities.find(signer =>
        leadsSnapshotSlot(checkpoint.block_index, validators, signer.getPubkeyHex()));
    other = identities.find(signer => signer !== leader);
});

describe('snapshot sign request builders', function () {
    it('exports its frozen refusal vocabulary', function () {
        assert.deepStrictEqual(SIGN_REQUEST_REFUSAL, {
            MALFORMED: 'malformed',
            NOT_LEADER: 'not_leader',
            BAD_LEADER_SIGNATURE: 'bad_leader_signature',
        });
        assert.strictEqual(Object.isFrozen(SIGN_REQUEST_REFUSAL), true);
    });

    it('builds a fresh request accepted by authorship and co-sign policy', function () {
        const request = buildSnapshotSignRequest(leader, 106, checkpoint);
        assert.strictEqual(request.snapshot_block, 106);
        assert.strictEqual(request.pubkey, leader.getPubkeyHex().toLowerCase());
        assert.notStrictEqual(request.cp, checkpoint);
        assert.deepStrictEqual(request.cp, checkpoint);
        assert.strictEqual(refusal(request), null);
        assert.strictEqual(snapshotCosignRefusal(request, {
            network: 'testnet',
            gateActive: true,
            expectedBlock: 100,
            btcTip: 106,
            confirmations: 6,
            local: {
                block_hash: hash('a'),
                state_root: hash('b'),
                state_root_version: 2,
            },
            signed: null,
            stored: null,
        }), null);
    });

    it('uses the same signature for the request and leader reply', function () {
        const request = buildSnapshotSignRequest(leader, 106, checkpoint);
        const reply = buildSnapshotSignReply(leader, 106, checkpoint);
        assert.strictEqual(request.sig, reply.sig);
        assert.deepStrictEqual(reply, {
            snapshot_block: 106,
            block_index: 100,
            pubkey: leader.getPubkeyHex().toLowerCase(),
            sig: request.sig,
        });
    });
});

describe('snapshot sign request builders', function () {
    it('builds replies retained by createSnapshotSignTally', function () {
        const tally = createSnapshotSignTally(
            106, checkpoint, validators, ValidatorIdentity.verify
        );
        assert.strictEqual(tally.add(buildSnapshotSignReply(leader, 106, checkpoint)), null);
        assert.strictEqual(tally.add(buildSnapshotSignReply(other, 106, checkpoint)), null);
        assert.strictEqual(tally.signatures().length, 2);
    });

    it('throws for invalid builder inputs and canonical-refused checkpoints', function () {
        const invalidIdentity = { sign() {} };
        const invalidCheckpoint = Object.assign({}, checkpoint, { chain: 'LTC' });
        assert.throws(() => buildSnapshotSignRequest(null, 106, checkpoint));
        assert.throws(() => buildSnapshotSignReply(invalidIdentity, 106, checkpoint));
        for (const block of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(() => buildSnapshotSignRequest(leader, block, checkpoint));
            assert.throws(() => buildSnapshotSignReply(leader, block, checkpoint));
        }
        assert.throws(
            () => buildSnapshotSignRequest(leader, 106, invalidCheckpoint),
            /snapshot checkpoint chain must be BTC/
        );
        assert.throws(
            () => buildSnapshotSignReply(leader, 106, invalidCheckpoint),
            /snapshot checkpoint chain must be BTC/
        );
    });
});

describe('snapshotSignRequestRefusal', function () {
    it('accepts the selected leader and an upper-case leader pubkey', function () {
        const request = buildSnapshotSignRequest(leader, 106, checkpoint);
        assert.strictEqual(refusal(request), null);
        assert.strictEqual(refusal(Object.assign({}, request, {
            pubkey: request.pubkey.toUpperCase(),
        })), null);
    });

    it('refuses a non-leader and a signer outside the set', function () {
        assert.strictEqual(
            refusal(buildSnapshotSignRequest(other, 106, checkpoint)),
            SIGN_REQUEST_REFUSAL.NOT_LEADER
        );
        assert.strictEqual(
            refusal(buildSnapshotSignRequest(identity(), 106, checkpoint)),
            SIGN_REQUEST_REFUSAL.NOT_LEADER
        );
    });

    it('refuses forged signatures and signatures over another payload', function () {
        const request = buildSnapshotSignRequest(leader, 106, checkpoint);
        const forged = buildSnapshotSignRequest(other, 106, checkpoint).sig;
        const changed = Object.assign({}, request, {
            cp: Object.assign({}, checkpoint, { state_root: hash('c') }),
        });
        assert.strictEqual(
            refusal(Object.assign({}, request, { sig: forged })),
            SIGN_REQUEST_REFUSAL.BAD_LEADER_SIGNATURE
        );
        assert.strictEqual(refusal(changed), SIGN_REQUEST_REFUSAL.BAD_LEADER_SIGNATURE);
    });
});

describe('snapshotSignRequestRefusal', function () {
    it('turns a throwing verifier into bad_leader_signature', function () {
        const request = buildSnapshotSignRequest(leader, 106, checkpoint);
        assert.strictEqual(refusal(request, validators, () => {
            throw new Error('boom');
        }), SIGN_REQUEST_REFUSAL.BAD_LEADER_SIGNATURE);
    });

    it('refuses every malformed request before leader selection', function () {
        const request = buildSnapshotSignRequest(leader, 106, checkpoint);
        const cases = [
            null,
            Object.assign({}, request, { cp: null }),
            Object.assign({}, request, { snapshot_block: 106.5 }),
            Object.assign({}, request, { snapshot_block: -1 }),
            Object.assign({}, request, { pubkey: request.pubkey.slice(1) }),
            Object.assign({}, request, { sig: request.sig.slice(1) }),
            Object.assign({}, request, {
                cp: Object.assign({}, checkpoint, { chain: 'LTC' }),
            }),
        ];
        for (const malformed of cases)
            assert.strictEqual(refusal(malformed), SIGN_REQUEST_REFUSAL.MALFORMED);
    });

    it('never throws while judging hostile request dependencies', function () {
        const request = buildSnapshotSignRequest(leader, 106, checkpoint);
        const hostile = {};
        Object.defineProperty(hostile, 'cp', { get() { throw new Error('hostile'); } });
        assert.strictEqual(refusal(hostile), SIGN_REQUEST_REFUSAL.MALFORMED);
        assert.strictEqual(refusal(request, {
            [Symbol.iterator]() { throw new Error('hostile'); },
        }), SIGN_REQUEST_REFUSAL.NOT_LEADER);
        assert.strictEqual(
            refusal(request, validators, null),
            SIGN_REQUEST_REFUSAL.BAD_LEADER_SIGNATURE
        );
    });
});
