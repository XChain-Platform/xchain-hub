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
    ROUND_STATE,
    createSnapshotRound,
} = require('../../../../src/anchor/snapshot_checkpoint/round_state.js');

const hash = (character) => character.repeat(64);

function signer() {
    const pair = crypto.generateKeyPairSync('ed25519');
    return {
        privateKey: pair.privateKey,
        pubkey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex'),
    };
}

let keys;
let trustSet;
let checkpoint;

function sign(key, cp = checkpoint) {
    const payload = Buffer.from(snapshotCheckpointCanonical(cp), 'utf8');
    return crypto.sign(null, payload, key.privateKey).toString('hex');
}

function reply(key, overrides = {}) {
    return Object.assign({
        snapshot_block: 106,
        block_index: checkpoint.block_index,
        pubkey: key.pubkey,
        sig: sign(key),
    }, overrides);
}

function round(overrides = {}) {
    return createSnapshotRound(Object.assign({
        snapshotBlock: 106,
        cp: checkpoint,
        trustSet,
        verify: ValidatorIdentity.verify,
        network: 'testnet',
        expectedBlock: 100,
        startedAt: 1000,
        timeoutMs: 500,
    }, overrides));
}

function view(nowMs, overrides = {}) {
    return Object.assign({ gateActive: true, stored: null, nowMs }, overrides);
}

function quorumRound(overrides = {}) {
    const subject = round(overrides);
    for (const key of keys.slice(0, 3)) expect(subject.add(reply(key))).to.equal(null);
    return subject;
}

beforeEach(function () {
    keys = [signer(), signer(), signer(), signer()];
    trustSet = keys.map((key, index) => ({
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

describe('snapshot checkpoint round state', function () {
    it('exports its frozen state vocabulary', function () {
        expect(ROUND_STATE).to.deep.equal({
            PENDING: 'pending',
            FINALIZE: 'finalize',
            EXPIRED: 'expired',
            ABORT: 'abort',
        });
        expect(Object.isFrozen(ROUND_STATE)).to.equal(true);
    });

    it('passes tally answers through while open', function () {
        const subject = round();
        expect(subject.add(reply(keys[0]))).to.equal(null);
        expect(subject.add(reply(keys[0]))).to.equal('duplicate');
    });

    it('stays pending one millisecond before its deadline', function () {
        const subject = round();
        expect(subject.add(reply(keys[0]))).to.equal(null);
        expect(subject.add(reply(keys[1]))).to.equal(null);
        expect(subject.decide(view(1499))).to.deep.equal({
            state: 'pending',
            reason: 'below_quorum',
        });
    });

    it('expires below quorum at its deadline and stays closed', function () {
        const subject = round();
        subject.add(reply(keys[0]));
        subject.add(reply(keys[1]));
        const decision = subject.decide(view(1500));
        expect(decision).to.deep.equal({ state: 'expired', reason: 'below_quorum' });
        expect(subject.add(reply(keys[2]))).to.equal('closed');
        expect(subject.decide(view(1000, { gateActive: false }))).to.equal(decision);
    });

    it('finalizes a quorum past the deadline in arrival order', function () {
        const subject = round();
        subject.add(reply(keys[2]));
        subject.add(reply(keys[0]));
        subject.add(reply(keys[1]));
        const decision = subject.decide(view(9999));
        expect(decision.state).to.equal('finalize');
        expect(decision.msg.snapshot_block).to.equal(106);
        expect(decision.msg.cp).to.equal(checkpoint);
        expect(decision.msg.signatures.map((row) => row.pubkey))
            .to.deep.equal([keys[2].pubkey, keys[0].pubkey, keys[1].pubkey]);
        expect(subject.add(reply(keys[3]))).to.equal('closed');
        expect(subject.decide(view(1000, { gateActive: false }))).to.equal(decision);
    });
});

describe('snapshot checkpoint round refusal decisions', function () {
    it('aborts a quorum when the gate is inactive', function () {
        const subject = quorumRound();
        const decision = subject.decide(view(1000, { gateActive: false }));
        expect(decision).to.deep.equal({ state: 'abort', reason: 'gate_inactive' });
        expect(subject.add(reply(keys[3]))).to.equal('closed');
        expect(subject.decide(view(1000))).to.equal(decision);
    });

    it('aborts a round opened for the wrong expected block', function () {
        expect(quorumRound({ expectedBlock: 101 }).decide(view(1000)))
            .to.deep.equal({ state: 'abort', reason: 'wrong_block' });
    });

    it('aborts for a differing stored row', function () {
        const stored = Object.assign({}, checkpoint, { state_root: hash('c') });
        expect(quorumRound().decide(view(1000, { stored })))
            .to.deep.equal({ state: 'abort', reason: 'conflicting_payload' });
    });

    it('finalizes with an identical stored row', function () {
        const stored = Object.assign({}, checkpoint);
        expect(quorumRound().decide(view(1000, { stored })).state).to.equal('finalize');
    });

    it('never throws while deciding hostile input', function () {
        const hostile = {};
        Object.defineProperty(hostile, 'gateActive', { get() { throw new Error('hostile'); } });
        expect(round().decide(hostile)).to.deep.equal({ state: 'abort', reason: 'malformed' });
    });
});

describe('snapshot checkpoint round construction', function () {
    it('passes canonical checkpoint errors through', function () {
        const cp = Object.assign({}, checkpoint, { chain: 'LTC' });
        expect(() => round({ cp })).to.throw('snapshot checkpoint chain must be BTC');
    });

    it('requires a finite start time', function () {
        for (const startedAt of [null, NaN, Infinity, -Infinity, '1000'])
            expect(() => round({ startedAt })).to.throw('startedAt must be a finite number');
    });

    it('requires a nonnegative finite timeout', function () {
        for (const timeoutMs of [-1, NaN, Infinity, -Infinity, null, '500'])
            expect(() => round({ timeoutMs })).to.throw('timeoutMs must be a nonnegative finite number');
    });
});
