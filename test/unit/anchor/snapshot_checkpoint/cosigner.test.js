'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const crypto = require('crypto');
const {
    answerSnapshotSignRequest,
} = require('../../../../src/anchor/snapshot_checkpoint/cosigner.js');
const {
    buildSnapshotSignRequest,
} = require('../../../../src/anchor/snapshot_checkpoint/sign_request.js');
const {
    createSnapshotSignedRecord,
} = require('../../../../src/anchor/snapshot_checkpoint/signed_record.js');
const {
    SNAPSHOT_FALLBACK_STEP_BLOCKS: STEP,
    snapshotLeaderDecision,
} = require('../../../../src/anchor/snapshot_checkpoint/leader.js');

const hash = character => character.repeat(64);
const LEADER = hash('1');
const COSIGNER = hash('2');
const validators = [{ pubkey: LEADER }, { pubkey: COSIGNER }];

function fakeSignature(pubkey, message) {
    return crypto.createHash('sha512').update(pubkey + '/' + message).digest('hex');
}

function identity(pubkey, onSign) {
    return {
        getPubkeyHex: () => pubkey,
        sign(message) {
            if(onSign) onSign();
            return fakeSignature(pubkey, message);
        },
    };
}

function checkpoint(changes = {}) {
    return Object.assign({
        chain: 'BTC',
        network: 'testnet',
        block_index: 100,
        block_hash: hash('a'),
        state_root: hash('b'),
        state_root_version: 2,
    }, changes);
}

function request(cp = checkpoint(), pubkey = LEADER) {
    return buildSnapshotSignRequest(identity(pubkey), 106, cp);
}

function view(changes = {}) {
    return Object.assign({
        network: 'testnet',
        gateActive: true,
        expectedBlock: 100,
        committedHeight: 106,
        chainHeight: 106,
        confirmations: 6,
        local: {
            block_hash: hash('a'),
            state_root: hash('b'),
            state_root_version: 2,
        },
        stored: null,
    }, changes);
}

function context(record, changes = {}) {
    return Object.assign({
        identity: identity(COSIGNER),
        validators,
        verify: (message, signature, pubkey) =>
            signature === fakeSignature(pubkey.toLowerCase(), message),
        record,
        view: view(),
    }, changes);
}

function refusal(reason) {
    return { refusal: reason, reply: null };
}

describe('answerSnapshotSignRequest accepted requests', function () {
    it('answers a clean request with the co-signer reply and claims its payload', function () {
        const record = createSnapshotSignedRecord();
        const result = answerSnapshotSignRequest(request(), context(record));
        expect(result.refusal).to.equal(null);
        expect(result.reply).to.include({
            snapshot_block: 106,
            block_index: 100,
            pubkey: COSIGNER,
        });
        expect(result.reply.sig).to.be.a('string').with.length(128);
        expect(record.held('testnet', 100)).to.deep.equal({
            block_hash: hash('a'),
            state_root: hash('b'),
            state_root_version: 2,
        });
    });

    it('answers an identical repeat without adding another claim', function () {
        const record = createSnapshotSignedRecord();
        const req = request();
        const ctx = context(record);
        const first = answerSnapshotSignRequest(req, ctx);
        expect(answerSnapshotSignRequest(req, ctx)).to.deep.equal(first);
        expect(record.size()).to.equal(1);
    });
});

describe('answerSnapshotSignRequest request refusal', function () {
    it('refuses a key that does not lead the block with not_leader', function () {
        const record = createSnapshotSignedRecord();
        expect(answerSnapshotSignRequest(request(checkpoint(), COSIGNER), context(record)))
            .to.deep.equal(refusal('not_leader'));
        expect(record.size()).to.equal(0);
    });

    it('signs for the next key in rotation once its own tip is a fallback step past due', function () {
        const record = createSnapshotSignedRecord();
        const third = hash('3');
        // Block 100 over three keys is the second key's turn, so the third key is next.
        const ctx = context(record, {
            identity: identity(LEADER),
            validators: validators.concat({ pubkey: third }),
        });
        const fallback = request(checkpoint({ block_index: 100 }), third);
        expect(answerSnapshotSignRequest(fallback, Object.assign({}, ctx, {
            view: view({ chainHeight: 106 + STEP - 1 }),
        }))).to.deep.equal(refusal('not_leader'));
        const result = answerSnapshotSignRequest(fallback, Object.assign({}, ctx, {
            view: view({ chainHeight: 106 + STEP }),
        }));
        expect(result.refusal).to.equal(null);
        expect(result.reply).to.include({ block_index: 100, pubkey: LEADER });
    });

    it('agrees with leader selection immediately below and at every fallback rank boundary', function () {
        const set = [1, 2, 3, 4, 5].map(digit => ({ pubkey: hash(String(digit)) }));
        const dueHeight = checkpoint().block_index + 6;
        for (let rank = 1; rank < set.length; rank++) {
            const signer = set[rank].pubkey;
            const req = request(checkpoint(), signer);
            for (const delta of [rank * STEP - 1, rank * STEP]) {
                const decision = snapshotLeaderDecision(
                    checkpoint().block_index, set, signer, delta);
                const result = answerSnapshotSignRequest(req, context(
                    createSnapshotSignedRecord(), {
                        validators: set,
                        view: view({ chainHeight: dueHeight + delta }),
                    }));
                expect(result.refusal === null, 'rank ' + rank + ', delta ' + delta)
                    .to.equal(decision.leads);
            }
        }
    });

    it('refuses a forged leader signature with bad_leader_signature', function () {
        const record = createSnapshotSignedRecord();
        const forged = request();
        forged.sig = fakeSignature(LEADER, 'another payload');
        expect(answerSnapshotSignRequest(forged, context(record)))
            .to.deep.equal(refusal('bad_leader_signature'));
        expect(record.size()).to.equal(0);
    });
});

describe('answerSnapshotSignRequest co-sign refusal', function () {
    const cases = [
        ['gate_inactive', { gateActive: false }],
        ['wrong_block', { expectedBlock: 99 }],
        ['shallow', { chainHeight: 105 }],
        ['local_mismatch', {
            local: { block_hash: hash('a'), state_root: hash('c'), state_root_version: 2 },
        }],
        ['conflicting_payload', {
            stored: { block_hash: hash('a'), state_root: hash('c'), state_root_version: 2 },
        }],
    ];

    for(const [reason, changes] of cases) {
        it('refuses ' + reason + ' without claiming or signing', function () {
            let signs = 0;
            const record = createSnapshotSignedRecord();
            const ctx = context(record, {
                identity: identity(COSIGNER, () => { signs += 1; }),
                view: view(changes),
            });
            expect(answerSnapshotSignRequest(request(), ctx))
                .to.deep.equal(refusal(reason));
            expect(record.size()).to.equal(0);
            expect(signs).to.equal(0);
        });
    }
});

describe('answerSnapshotSignRequest committed height refusal', function () {
    it('refuses committed height one block below required depth at a high chain height', function () {
        const record = createSnapshotSignedRecord();
        const ctx = context(record, {
            view: view({ committedHeight: 105, chainHeight: 1000 }),
        });
        expect(answerSnapshotSignRequest(request(), ctx))
            .to.deep.equal(refusal('shallow'));
        expect(record.size()).to.equal(0);
    });
});

describe('answerSnapshotSignRequest co-sign refusal', function () {
    it('uses record.held as the signed view and keeps a different first payload', function () {
        const record = createSnapshotSignedRecord();
        record.claim(checkpoint({ state_root: hash('c') }));
        expect(answerSnapshotSignRequest(request(), context(record)))
            .to.deep.equal(refusal('conflicting_payload'));
        expect(record.held('testnet', 100).state_root).to.equal(hash('c'));
    });

    it('does not claim after a signed-view refusal', function () {
        let claims = 0;
        const record = {
            held: () => ({
                block_hash: hash('a'),
                state_root: hash('c'),
                state_root_version: 2,
            }),
            claim: () => { claims += 1; return true; },
        };
        expect(answerSnapshotSignRequest(request(), context(record)))
            .to.deep.equal(refusal('conflicting_payload'));
        expect(claims).to.equal(0);
    });
});

describe('answerSnapshotSignRequest claim and signing order', function () {
    it('refuses conflicting_payload when claim answers false and does not sign', function () {
        let signs = 0;
        const record = { held: () => null, claim: () => false };
        const ctx = context(record, {
            identity: identity(COSIGNER, () => { signs += 1; }),
        });
        expect(answerSnapshotSignRequest(request(), ctx))
            .to.deep.equal(refusal('conflicting_payload'));
        expect(signs).to.equal(0);
    });

    it('claims before building the signature', function () {
        const order = [];
        const record = {
            held: () => null,
            claim: () => { order.push('claim'); return true; },
        };
        const ctx = context(record, {
            identity: identity(COSIGNER, () => { order.push('sign'); }),
        });
        expect(answerSnapshotSignRequest(request(), ctx).refusal).to.equal(null);
        expect(order).to.deep.equal(['claim', 'sign']);
    });
});

describe('answerSnapshotSignRequest malformed dependencies', function () {
    it('returns malformed for a missing ctx or record', function () {
        expect(answerSnapshotSignRequest(request(), null)).to.deep.equal(refusal('malformed'));
        expect(answerSnapshotSignRequest(request(), {})).to.deep.equal(refusal('malformed'));
        expect(answerSnapshotSignRequest(request(), context({})))
            .to.deep.equal(refusal('malformed'));
    });

    it('returns malformed for a missing signing identity without throwing', function () {
        const record = createSnapshotSignedRecord();
        expect(answerSnapshotSignRequest(request(), context(record, { identity: {} })))
            .to.deep.equal(refusal('malformed'));
        expect(record.size()).to.equal(0);
    });

    it('never throws when a dependency throws', function () {
        const record = {
            held: () => { throw new Error('unavailable'); },
            claim: () => true,
        };
        expect(() => answerSnapshotSignRequest(request(), context(record))).not.to.throw();
        expect(answerSnapshotSignRequest(request(), context(record)))
            .to.deep.equal(refusal('malformed'));
    });
});
