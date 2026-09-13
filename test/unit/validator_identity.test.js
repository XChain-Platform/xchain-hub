'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect }          = require('chai');
const ValidatorIdentity   = require('../../src/ValidatorIdentity');

describe('ValidatorIdentity', function () {

    // Pre-generate a keypair for reuse across tests
    let keypair;
    before(function () {
        keypair = ValidatorIdentity.generate();
    });

    // -----------------------------------------------------------------
    // generate()
    // -----------------------------------------------------------------

    describe('generate()', function () {
        it('returns pubkeyHex and privkeyHex each 64 hex chars', function () {
            let kp = ValidatorIdentity.generate();
            expect(kp.pubkeyHex).to.match(/^[0-9a-f]{64}$/);
            expect(kp.privkeyHex).to.match(/^[0-9a-f]{64}$/);
        });

        it('generates unique keypairs on each call', function () {
            let a = ValidatorIdentity.generate();
            let b = ValidatorIdentity.generate();
            expect(a.pubkeyHex).to.not.equal(b.pubkeyHex);
            expect(a.privkeyHex).to.not.equal(b.privkeyHex);
        });
    });

    // -----------------------------------------------------------------
    // constructor
    // -----------------------------------------------------------------

    describe('constructor', function () {
        it('creates an identity from a valid 64-hex-char seed', function () {
            let id = new ValidatorIdentity(keypair.privkeyHex);
            expect(id.getPubkeyHex()).to.equal(keypair.pubkeyHex);
        });

        it('is deterministic: same seed yields same pubkey', function () {
            let a = new ValidatorIdentity(keypair.privkeyHex);
            let b = new ValidatorIdentity(keypair.privkeyHex);
            expect(a.getPubkeyHex()).to.equal(b.getPubkeyHex());
        });

        it('throws on null input', function () {
            expect(() => new ValidatorIdentity(null)).to.throw();
        });

        it('throws on empty string', function () {
            expect(() => new ValidatorIdentity('')).to.throw();
        });

        it('throws on 62-char hex (too short)', function () {
            expect(() => new ValidatorIdentity('aa'.repeat(31))).to.throw();
        });

        it('throws on 66-char hex (too long)', function () {
            expect(() => new ValidatorIdentity('aa'.repeat(33))).to.throw();
        });

        it('throws on non-hex characters', function () {
            expect(() => new ValidatorIdentity('zz' + 'aa'.repeat(31))).to.throw();
        });
    });

    // -----------------------------------------------------------------
    // getPubkeyHex()
    // -----------------------------------------------------------------

    describe('getPubkeyHex()', function () {
        it('returns a 64 hex char string', function () {
            let id = new ValidatorIdentity(keypair.privkeyHex);
            expect(id.getPubkeyHex()).to.match(/^[0-9a-f]{64}$/);
        });
    });

    // -----------------------------------------------------------------
    // sign() / verify()
    // -----------------------------------------------------------------

    describe('sign() and verify()', function () {
        it('valid signature verifies successfully', function () {
            let id  = new ValidatorIdentity(keypair.privkeyHex);
            let sig = id.sign('hello world');
            expect(sig).to.match(/^[0-9a-f]{128}$/);
            let ok = ValidatorIdentity.verify('hello world', sig, keypair.pubkeyHex);
            expect(ok).to.be.true;
        });

        it('tampered payload fails verification', function () {
            let id  = new ValidatorIdentity(keypair.privkeyHex);
            let sig = id.sign('hello world');
            let ok  = ValidatorIdentity.verify('hello world!', sig, keypair.pubkeyHex);
            expect(ok).to.be.false;
        });

        it('wrong pubkey fails verification (cross-key rejection)', function () {
            let id    = new ValidatorIdentity(keypair.privkeyHex);
            let sig   = id.sign('test payload');
            let other = ValidatorIdentity.generate();
            let ok    = ValidatorIdentity.verify('test payload', sig, other.pubkeyHex);
            expect(ok).to.be.false;
        });

        it('null sigHex returns false', function () {
            expect(ValidatorIdentity.verify('test', null, keypair.pubkeyHex)).to.be.false;
        });

        it('null pubkeyHex returns false', function () {
            let id  = new ValidatorIdentity(keypair.privkeyHex);
            let sig = id.sign('test');
            expect(ValidatorIdentity.verify('test', sig, null)).to.be.false;
        });

        it('corrupted sigHex returns false (no throw)', function () {
            expect(ValidatorIdentity.verify('test', 'not-valid-hex', keypair.pubkeyHex)).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // signEnvelope() / verifyEnvelope()
    // -----------------------------------------------------------------

    describe('signEnvelope() and verifyEnvelope()', function () {
        it('round-trip sign and verify succeeds', function () {
            let id = new ValidatorIdentity(keypair.privkeyHex);
            let envelope = {
                id:        'msg-1',
                type:      'TEST',
                sender:    'ws://validator-1:10001',
                timestamp: 1700000000000,
                data:      { foo: 'bar' }
            };
            envelope.sig = id.signEnvelope(envelope);
            expect(ValidatorIdentity.verifyEnvelope(envelope, keypair.pubkeyHex)).to.be.true;
        });

        it('tampered data fails verification', function () {
            let id = new ValidatorIdentity(keypair.privkeyHex);
            let envelope = {
                id: 'msg-1', type: 'TEST', sender: 'ws://v:1', timestamp: 1, data: { a: 1 }
            };
            envelope.sig = id.signEnvelope(envelope);
            envelope.data = { a: 2 };
            expect(ValidatorIdentity.verifyEnvelope(envelope, keypair.pubkeyHex)).to.be.false;
        });

        it('uses deterministic field ordering', function () {
            let envelope = {
                id: 'x', type: 'T', sender: 's', timestamp: 0, data: null
            };
            let payload = ValidatorIdentity.getSignablePayload(envelope);
            let parsed = JSON.parse(payload);
            expect(Object.keys(parsed)).to.deep.equal(['id', 'type', 'sender', 'timestamp', 'data']);
        });
    });

    // -----------------------------------------------------------------
    // Option A: sig_pubkey binding into the canonical payload
    // -----------------------------------------------------------------

    describe('sig_pubkey canonical binding (Option A)', function () {
        it('omits sig_pubkey from the canonical when absent (pre-A backward compat)', function () {
            // A pre-A envelope must yield the IDENTICAL canonical it was signed
            // with, so an A-verifier accepts a pre-A signature unchanged.
            let env = { id: 'x', type: 'T', sender: 's', timestamp: 0, data: { a: 1 } };
            let parsed = JSON.parse(ValidatorIdentity.getSignablePayload(env));
            expect(parsed).to.not.have.property('sig_pubkey');
            expect(Object.keys(parsed)).to.deep.equal(['id', 'type', 'sender', 'timestamp', 'data']);
        });

        it('appends sig_pubkey LAST when present', function () {
            let env = {
                id: 'x', type: 'T', sender: 's', timestamp: 0, data: {}, sig_pubkey: keypair.pubkeyHex
            };
            let parsed = JSON.parse(ValidatorIdentity.getSignablePayload(env));
            expect(Object.keys(parsed)).to.deep.equal(['id', 'type', 'sender', 'timestamp', 'data', 'sig_pubkey']);
        });

        it('round-trips an envelope that carries sig_pubkey', function () {
            let id = new ValidatorIdentity(keypair.privkeyHex);
            let env = {
                id: 'oa', type: 'TEST', sender: 'ws://v:1', timestamp: 1700000000000,
                data: { foo: 'bar' }, sig_pubkey: keypair.pubkeyHex
            };
            env.sig = id.signEnvelope(env);
            expect(ValidatorIdentity.verifyEnvelope(env, keypair.pubkeyHex)).to.be.true;
        });

        it('tampering sig_pubkey after signing breaks verification', function () {
            let id = new ValidatorIdentity(keypair.privkeyHex);
            let env = {
                id: 'oa', type: 'TEST', sender: 'ws://v:1', timestamp: 1,
                data: {}, sig_pubkey: keypair.pubkeyHex
            };
            env.sig = id.signEnvelope(env);
            env.sig_pubkey = ValidatorIdentity.generate().pubkeyHex; // swap the bound key
            expect(ValidatorIdentity.verifyEnvelope(env, keypair.pubkeyHex)).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // pubkeyFromHex()
    // -----------------------------------------------------------------

    describe('pubkeyFromHex()', function () {
        it('returns a KeyObject from valid 64-hex pubkey', function () {
            let keyObj = ValidatorIdentity.pubkeyFromHex(keypair.pubkeyHex);
            expect(keyObj.type).to.equal('public');
        });

        it('throws on wrong-length hex', function () {
            expect(() => ValidatorIdentity.pubkeyFromHex('aabb')).to.throw('Invalid pubkey hex length');
        });

        it('throws on null', function () {
            expect(() => ValidatorIdentity.pubkeyFromHex(null)).to.throw();
        });
    });
});
