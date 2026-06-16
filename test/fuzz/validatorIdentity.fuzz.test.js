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

const { expect }        = require('chai');
const fc                = require('fast-check');
const ValidatorIdentity = require('../../src/ValidatorIdentity');
const gen               = require('./generators');

describe('Fuzz: ValidatorIdentity', function () {

    // -----------------------------------------------------------------
    // Constructor — input validation
    // -----------------------------------------------------------------

    describe('constructor', function () {

        it('valid 64-char hex never throws', function () {
            fc.assert(fc.property(gen.fc_validPrivkeyHex(), function (hex) {
                expect(function () { new ValidatorIdentity(hex); }).to.not.throw();
            }), { numRuns: 50 });
        });

        it('invalid inputs always throw', function () {
            fc.assert(fc.property(gen.fc_invalidPrivkeyHex(), function (invalid) {
                expect(function () { new ValidatorIdentity(invalid); }).to.throw();
            }), { numRuns: 50 });
        });

        it('same privkey always produces the same pubkey (determinism)', function () {
            fc.assert(fc.property(gen.fc_validPrivkeyHex(), function (hex) {
                let id1 = new ValidatorIdentity(hex);
                let id2 = new ValidatorIdentity(hex);
                expect(id1.getPubkeyHex()).to.equal(id2.getPubkeyHex());
            }), { numRuns: 50 });
        });

        it('pubkey is always a 64-char lowercase hex string', function () {
            fc.assert(fc.property(gen.fc_validPrivkeyHex(), function (hex) {
                let id = new ValidatorIdentity(hex);
                expect(id.getPubkeyHex()).to.match(/^[0-9a-f]{64}$/);
            }), { numRuns: 50 });
        });

        it('different privkeys produce different pubkeys', function () {
            fc.assert(fc.property(
                gen.fc_validPrivkeyHex(),
                gen.fc_validPrivkeyHex(),
                function (hex1, hex2) {
                    fc.pre(hex1 !== hex2);
                    let id1 = new ValidatorIdentity(hex1);
                    let id2 = new ValidatorIdentity(hex2);
                    expect(id1.getPubkeyHex()).to.not.equal(id2.getPubkeyHex());
                }
            ), { numRuns: 50 });
        });
    });

    // -----------------------------------------------------------------
    // sign() and verify()
    // -----------------------------------------------------------------

    describe('sign() and verify()', function () {

        it('sign + verify round-trip always succeeds for any payload', function () {
            fc.assert(fc.property(
                gen.fc_validPrivkeyHex(),
                fc.string({ maxLength: 200 }),
                function (hex, payload) {
                    let id = new ValidatorIdentity(hex);
                    let sig = id.sign(payload);
                    expect(ValidatorIdentity.verify(payload, sig, id.getPubkeyHex())).to.be.true;
                }
            ), { numRuns: 100 });
        });

        it('signature output is always a 128-char hex string', function () {
            fc.assert(fc.property(
                gen.fc_validPrivkeyHex(),
                fc.string({ maxLength: 200 }),
                function (hex, payload) {
                    let id = new ValidatorIdentity(hex);
                    expect(id.sign(payload)).to.match(/^[0-9a-f]{128}$/);
                }
            ), { numRuns: 100 });
        });

        it('any single-character mutation of the payload fails verification', function () {
            fc.assert(fc.property(
                gen.fc_validPrivkeyHex(),
                fc.string({ minLength: 1, maxLength: 100 }),
                fc.integer({ min: 0, max: 99 }),
                fc.string({ minLength: 1, maxLength: 1 }),
                function (hex, payload, idx, newChar) {
                    fc.pre(idx < payload.length);
                    let mutated = payload.slice(0, idx) + newChar + payload.slice(idx + 1);
                    fc.pre(mutated !== payload);

                    let id = new ValidatorIdentity(hex);
                    let sig = id.sign(payload);
                    expect(ValidatorIdentity.verify(mutated, sig, id.getPubkeyHex())).to.be.false;
                }
            ), { numRuns: 100 });
        });

        it('cross-key rejection: signature from one key never verifies with a different pubkey', function () {
            fc.assert(fc.property(
                gen.fc_validPrivkeyHex(),
                gen.fc_validPrivkeyHex(),
                fc.string({ maxLength: 100 }),
                function (hex1, hex2, payload) {
                    fc.pre(hex1 !== hex2);
                    let id1 = new ValidatorIdentity(hex1);
                    let id2 = new ValidatorIdentity(hex2);
                    let sig = id1.sign(payload);
                    expect(ValidatorIdentity.verify(payload, sig, id2.getPubkeyHex())).to.be.false;
                }
            ), { numRuns: 50 });
        });

        it('invalid sigHex inputs to verify() always return false, never throw', function () {
            fc.assert(fc.property(
                gen.fc_validPrivkeyHex(),
                fc.string({ maxLength: 100 }),
                fc.oneof(
                    fc.constant(null),
                    fc.constant(''),
                    fc.constant(undefined),
                    fc.string({ minLength: 1, maxLength: 50 }),
                    fc.string({ minLength: 129, maxLength: 200 })
                ),
                function (hex, payload, badSig) {
                    let id = new ValidatorIdentity(hex);
                    let result = ValidatorIdentity.verify(payload, badSig, id.getPubkeyHex());
                    expect(result).to.be.false;
                }
            ), { numRuns: 100 });
        });
    });

    // -----------------------------------------------------------------
    // pubkeyFromHex()
    // -----------------------------------------------------------------

    describe('pubkeyFromHex()', function () {

        it('valid 64-char hex never throws', function () {
            fc.assert(fc.property(gen.fc_hexString(32), function (hex) {
                expect(function () { ValidatorIdentity.pubkeyFromHex(hex); }).to.not.throw();
            }), { numRuns: 50 });
        });

        it('any string not exactly 64 hex chars always throws', function () {
            fc.assert(fc.property(
                fc.oneof(
                    fc.constant(''),
                    fc.constant(null),
                    gen.fc_hexString(31),
                    gen.fc_hexString(33),
                    fc.string({ minLength: 0, maxLength: 63 }),
                    fc.string({ minLength: 65, maxLength: 100 })
                ),
                function (invalid) {
                    expect(function () { ValidatorIdentity.pubkeyFromHex(invalid); }).to.throw();
                }
            ), { numRuns: 50 });
        });
    });

    // -----------------------------------------------------------------
    // Envelope sign/verify round-trip
    // -----------------------------------------------------------------

    describe('envelope sign/verify round-trip', function () {

        it('full envelope round-trip succeeds for arbitrary data payloads', function () {
            fc.assert(fc.property(
                gen.fc_validPrivkeyHex(),
                fc.record({
                    id:        fc.string({ minLength: 1, maxLength: 30 }),
                    type:      fc.string({ minLength: 1, maxLength: 20 }),
                    sender:    fc.string({ minLength: 1, maxLength: 30 }),
                    timestamp: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
                    data:      fc.record({ key: fc.string({ maxLength: 20 }) })
                }),
                function (hex, envelope) {
                    let id = new ValidatorIdentity(hex);
                    let signed = Object.assign({}, envelope);
                    signed.sig = id.signEnvelope(signed);
                    expect(ValidatorIdentity.verifyEnvelope(signed, id.getPubkeyHex())).to.be.true;
                }
            ), { numRuns: 100 });
        });

        it('mutation of any envelope field after signing fails verification', function () {
            fc.assert(fc.property(
                gen.fc_validPrivkeyHex(),
                fc.string({ minLength: 1, maxLength: 20 }),
                function (hex, mutation) {
                    let id = new ValidatorIdentity(hex);
                    let envelope = {
                        id:        'test-id-1',
                        type:      'ORACLE_PROPOSE',
                        sender:    'ws://validator-1:10001',
                        timestamp: 1700000000,
                        data:      { round: 1 }
                    };

                    let signed = Object.assign({}, envelope);
                    signed.sig = id.signEnvelope(signed);

                    // Mutate the type field
                    let mutated = Object.assign({}, signed);
                    mutated.type = mutation;
                    fc.pre(mutated.type !== signed.type);

                    expect(ValidatorIdentity.verifyEnvelope(mutated, id.getPubkeyHex())).to.be.false;
                }
            ), { numRuns: 50 });
        });
    });
});
