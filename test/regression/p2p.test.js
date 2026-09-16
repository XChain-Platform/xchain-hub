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

const sinon              = require('sinon');
const { expect }         = require('chai');
const ValidatorIdentity  = require('../../src/validators/identity');
const PeerManager        = require('../../src/peers/manager');
const { DB_METHODS }     = require('../helpers/mockHub');

// =================================================================
// ValidatorIdentity
// =================================================================

function registerSuitePart1() {
    describe('ValidatorIdentity', function () {
    registerNestedSuite1Part1();
    registerNestedSuite1Part2();
    registerNestedSuite1Part3();
    registerNestedSuite1Part4();
    registerNestedSuite1Part5();
    registerNestedSuite1Part6();

    });
}

// =================================================================
// PeerManager
// =================================================================

function registerSuitePart2() {
    describe('PeerManager', function () {
    registerNestedSuite2Part1();
    registerNestedSuite2Part2();
    registerNestedSuite2Part3();
    registerNestedSuite2Part4();
    registerNestedSuite2Part5();
    registerNestedSuite2Part6();
    registerNestedSuite2Part7();
    registerNestedSuite2Part8();

    });
}

describe('Regression: P2P & ValidatorIdentity', function () {
    registerSuitePart1();
    registerSuitePart2();

});
      let keypair;
     function registerNestedSuite1Part1() {
    before(function () { keypair = ValidatorIdentity.generate(); });
}
      // REG-P2P-007
    function registerNestedSuite1Part2() {
    describe('REG-P2P-007: Ed25519 sign/verify round-trip', function () {
            it('valid signature verifies successfully @regression-p0', function () {
                let id  = new ValidatorIdentity(keypair.privkeyHex);
                let sig = id.sign('hello world');
                expect(sig).to.match(/^[0-9a-f]{128}$/);
                let ok = ValidatorIdentity.verify('hello world', sig, keypair.pubkeyHex);
                expect(ok).to.be.true;
            });

            it('envelope sign/verify round-trip @regression-p0', function () {
                let id = new ValidatorIdentity(keypair.privkeyHex);
                let envelope = {
                    id: 'msg-1', type: 'TEST', sender: 'ws://v:1',
                    timestamp: 1700000000000, data: { foo: 'bar' }
                };
                envelope.sig = id.signEnvelope(envelope);
                expect(ValidatorIdentity.verifyEnvelope(envelope, keypair.pubkeyHex)).to.be.true;
            });
        });
}
      // REG-P2P-008
    function registerNestedSuite1Part3() {
    describe('REG-P2P-008: Invalid signatures rejected', function () {
            it('tampered payload fails verification @regression-p0', function () {
                let id  = new ValidatorIdentity(keypair.privkeyHex);
                let sig = id.sign('hello world');
                expect(ValidatorIdentity.verify('hello world!', sig, keypair.pubkeyHex)).to.be.false;
            });

            it('wrong pubkey fails verification @regression-p0', function () {
                let id    = new ValidatorIdentity(keypair.privkeyHex);
                let sig   = id.sign('test payload');
                let other = ValidatorIdentity.generate();
                expect(ValidatorIdentity.verify('test payload', sig, other.pubkeyHex)).to.be.false;
            });

            it('null sigHex returns false @regression-p0', function () {
                expect(ValidatorIdentity.verify('test', null, keypair.pubkeyHex)).to.be.false;
            });

            it('corrupted sigHex returns false @regression-p0', function () {
                expect(ValidatorIdentity.verify('test', 'not-valid-hex', keypair.pubkeyHex)).to.be.false;
            });

            it('tampered envelope data fails @regression-p0', function () {
                let id = new ValidatorIdentity(keypair.privkeyHex);
                let envelope = {
                    id: 'msg-1', type: 'TEST', sender: 'ws://v:1', timestamp: 1, data: { a: 1 }
                };
                envelope.sig = id.signEnvelope(envelope);
                envelope.data = { a: 2 };
                expect(ValidatorIdentity.verifyEnvelope(envelope, keypair.pubkeyHex)).to.be.false;
            });
        });
}
      // REG-P2P-010
    function registerNestedSuite1Part4() {
    describe('REG-P2P-010: Identity from 64-hex-char seed', function () {
            it('creates identity deterministically @regression-p1', function () {
                let a = new ValidatorIdentity(keypair.privkeyHex);
                let b = new ValidatorIdentity(keypair.privkeyHex);
                expect(a.getPubkeyHex()).to.equal(b.getPubkeyHex());
            });

            it('pubkey is 64 hex chars @regression-p1', function () {
                let id = new ValidatorIdentity(keypair.privkeyHex);
                expect(id.getPubkeyHex()).to.match(/^[0-9a-f]{64}$/);
            });

            it('throws on invalid seed lengths @regression-p1', function () {
                expect(() => new ValidatorIdentity(null)).to.throw();
                expect(() => new ValidatorIdentity('')).to.throw();
                expect(() => new ValidatorIdentity('aa'.repeat(31))).to.throw(); // 62 chars
                expect(() => new ValidatorIdentity('aa'.repeat(33))).to.throw(); // 66 chars
            });

            it('throws on non-hex characters @regression-p1', function () {
                expect(() => new ValidatorIdentity('zz' + 'aa'.repeat(31))).to.throw();
            });

            it('generate() produces unique keypairs @regression-p1', function () {
                let a = ValidatorIdentity.generate();
                let b = ValidatorIdentity.generate();
                expect(a.pubkeyHex).to.not.equal(b.pubkeyHex);
            });
        });
}
      // Deterministic field ordering
    function registerNestedSuite1Part5() {
    describe('Deterministic field ordering', function () {
            it('getSignablePayload uses fixed key order @regression-p0', function () {
                let envelope = { id: 'x', type: 'T', sender: 's', timestamp: 0, data: null };
                let payload = ValidatorIdentity.getSignablePayload(envelope);
                let parsed = JSON.parse(payload);
                expect(Object.keys(parsed)).to.deep.equal(['id', 'type', 'sender', 'timestamp', 'data']);
            });
        });
}
      // pubkeyFromHex
    function registerNestedSuite1Part6() {
    describe('pubkeyFromHex', function () {
            it('returns KeyObject from valid hex @regression-p1', function () {
                let keyObj = ValidatorIdentity.pubkeyFromHex(keypair.pubkeyHex);
                expect(keyObj.type).to.equal('public');
            });

            it('throws on wrong-length hex @regression-p1', function () {
                expect(() => ValidatorIdentity.pubkeyFromHex('aabb')).to.throw('Invalid pubkey hex length');
            });
        });
}

      let config, dbStub, pm;
      function registerNestedSuite2Part1() {
    beforeEach(function () {
            keypair = ValidatorIdentity.generate();
            config = {
                P2P_VALIDATOR_ADDR: 'ws://self:10001',
                P2P_PORT: 0,
                P2P_HOST: '127.0.0.1',
                SEED_NODES: [],
                REQUIRE_SIGNATURES: false,
                P2P_MSG_DEDUP_TTL: 60000,
                P2P_MAX_PAYLOAD: 1048576,
                P2P_HEARTBEAT_INTERVAL: 15000,
                P2P_RECONNECT_BASE: 2000,
                P2P_RECONNECT_MAX: 60000
            };
            dbStub = { ...DB_METHODS, doQuery: sinon.stub().resolves([]) };
            pm = new PeerManager(config, dbStub);
        });
}
      function registerNestedSuite2Part2() {
    afterEach(function () { sinon.restore(); });
}
      // REG-P2P-001
    function registerNestedSuite2Part3() {
    describe('REG-P2P-001: Message broadcast', function () {
            it('broadcast returns envelope with correct type @regression-p1', function () {
                let result = pm.broadcast('TEST', { val: 1 });
                expect(result).to.have.property('id');
                expect(result.type).to.equal('TEST');
                expect(result.sender).to.equal('ws://self:10001');
            });

            it('envelope has required fields @regression-p1', function () {
                let env = pm.buildEnvelope('TEST', { foo: 'bar' });
                expect(env).to.have.property('id');
                expect(env).to.have.property('timestamp');
                expect(env.type).to.equal('TEST');
                expect(env.data).to.deep.equal({ foo: 'bar' });
            });

            it('generates unique IDs @regression-p1', function () {
                let a = pm.buildEnvelope('T', {});
                let b = pm.buildEnvelope('T', {});
                expect(a.id).to.not.equal(b.id);
            });
        });
}
      // REG-P2P-002
    function registerNestedSuite2Part4() {
    describe('REG-P2P-002: Message deduplication', function () {
            let mockWs;
            beforeEach(function () {
                mockWs = { _peerAddr: 'ws://peer:10001', send: sinon.stub() };
            });

            it('accepts first occurrence, rejects duplicate @regression-p1', function () {
                let emitted = 0;
                pm.on('message', () => emitted++);

                let env = {
                    id: 'msg-dedup-test',
                    type: 'TEST',
                    sender: 'ws://peer:10001',
                    timestamp: Date.now(),
                    data: {}
                };
                let raw = JSON.stringify(env);

                pm.handleInbound(mockWs, raw, 'ws://peer:10001');
                pm.handleInbound(mockWs, raw, 'ws://peer:10001');
                expect(emitted).to.equal(1);
            });
        });
}
      // REG-P2P-009
    function registerNestedSuite2Part5() {
    describe('REG-P2P-009: Signature enforcement', function () {
            it('valid signature accepted when REQUIRE_SIGNATURES=true @regression-p0', function () {
                pm.requireSigs = true;
                let identity = new ValidatorIdentity(keypair.privkeyHex);
                pm.setValidatorPubkeys(new Map([['ws://peer:10001', keypair.pubkeyHex]]));

                let env = {
                    id: 'msg-1', type: 'TEST', sender: 'ws://peer:10001',
                    timestamp: Date.now(), data: { x: 1 }
                };
                env.sig = identity.signEnvelope(env);

                expect(pm.verifySignature(env)).to.be.true;
            });

            it('invalid signature rejected when REQUIRE_SIGNATURES=true @regression-p0', function () {
                pm.requireSigs = true;
                pm.setValidatorPubkeys(new Map([['ws://peer:10001', keypair.pubkeyHex]]));

                let env = {
                    id: 'msg-1', type: 'TEST', sender: 'ws://peer:10001',
                    timestamp: Date.now(), data: {}, sig: 'aa'.repeat(64)
                };

                expect(pm.verifySignature(env)).to.be.false;
            });

            it('no sig required when REQUIRE_SIGNATURES=false @regression-p0', function () {
                pm.requireSigs = false;
                let env = {
                    id: 'msg-1', type: 'TEST', sender: 'ws://peer:10001',
                    timestamp: Date.now(), data: {}
                };
                expect(pm.verifySignature(env)).to.be.true;
            });
        });
}
      // Envelope signature inclusion
    function registerNestedSuite2Part6() {
    describe('Envelope signature inclusion', function () {
            it('includes sig when identity is set @regression-p1', function () {
                let identity = new ValidatorIdentity(keypair.privkeyHex);
                pm.setIdentity(identity);

                let env = pm.buildEnvelope('TEST', { x: 1 });
                expect(env.sig).to.be.a('string');
                expect(env.sig.length).to.equal(128);
            });

            it('no sig when identity not set @regression-p1', function () {
                let env = pm.buildEnvelope('TEST', {});
                expect(env.sig).to.be.undefined;
            });
        });
}
      // Invalid JSON handling
    function registerNestedSuite2Part7() {
    describe('Invalid JSON handling', function () {
            it('does not crash on non-JSON message @regression-p2', function () {
                let emitted = 0;
                pm.on('message', () => emitted++);
                expect(() => pm.handleInbound(null, 'not json', 'ws://peer:10001')).to.not.throw();
                expect(emitted).to.equal(0);
            });

            it('does not crash on empty string @regression-p2', function () {
                expect(() => pm.handleInbound(null, '', 'ws://peer:10001')).to.not.throw();
            });
        });
}
      // Setter methods
    function registerNestedSuite2Part8() {
    describe('Setter methods', function () {
            it('setIdentity stores identity @regression-p2', function () {
                let identity = new ValidatorIdentity(keypair.privkeyHex);
                pm.setIdentity(identity);
                expect(pm.identity).to.equal(identity);
            });

            it('setValidatorPubkeys stores map @regression-p2', function () {
                let map = new Map([['addr1', 'pk1']]);
                pm.setValidatorPubkeys(map);
                expect(pm.validatorPubkeys).to.equal(map);
            });
        });
}
