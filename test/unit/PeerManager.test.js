'use strict';

const sinon              = require('sinon');
const { expect }         = require('chai');
const EventEmitter       = require('events');
const ValidatorIdentity  = require('../../src/ValidatorIdentity');
const PeerManager        = require('../../src/PeerManager');

describe('PeerManager', function () {

    let config, dbStub, pm, keypair;

    beforeEach(function () {
        keypair = ValidatorIdentity.generate();
        config = {
            P2P_VALIDATOR_ADDR: 'ws://self:10001',
            P2P_PORT: 0,    // Don't bind
            P2P_HOST: '127.0.0.1',
            SEED_NODES: [],
            REQUIRE_SIGNATURES: false,
            P2P_MSG_DEDUP_TTL: 60000,
            P2P_MAX_PAYLOAD: 1048576,
            P2P_HEARTBEAT_INTERVAL: 15000,
            P2P_RECONNECT_BASE: 2000,
            P2P_RECONNECT_MAX: 60000
        };
        dbStub = { doQuery: sinon.stub().resolves([]) };
        pm = new PeerManager(config, dbStub);
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // _buildEnvelope()
    // -----------------------------------------------------------------

    describe('_buildEnvelope()', function () {
        it('creates envelope with required fields', function () {
            let env = pm._buildEnvelope('TEST', { foo: 'bar' });
            expect(env).to.have.property('id');
            expect(env.type).to.equal('TEST');
            expect(env.sender).to.equal('ws://self:10001');
            expect(env).to.have.property('timestamp');
            expect(env.data).to.deep.equal({ foo: 'bar' });
        });

        it('includes signature when identity is set', function () {
            let identity = new ValidatorIdentity(keypair.privkeyHex);
            pm.setIdentity(identity);

            let env = pm._buildEnvelope('TEST', { x: 1 });
            expect(env.sig).to.be.a('string');
            expect(env.sig.length).to.equal(128);
        });

        it('has no signature when identity is not set', function () {
            let env = pm._buildEnvelope('TEST', {});
            expect(env.sig).to.be.undefined;
        });

        it('generates unique IDs', function () {
            let a = pm._buildEnvelope('T', {});
            let b = pm._buildEnvelope('T', {});
            expect(a.id).to.not.equal(b.id);
        });
    });

    // -----------------------------------------------------------------
    // Message deduplication
    // -----------------------------------------------------------------

    describe('message deduplication', function () {
        let mockWs;
        beforeEach(function () {
            mockWs = { _peerAddr: 'ws://peer:10001', send: sinon.stub() };
        });

        function makePeerEnvelope(type, data) {
            // Build envelope with a different sender (not self) to avoid self-connection guard
            return {
                id:        'msg-' + Date.now() + '-' + Math.random(),
                type:      type,
                sender:    'ws://peer:10001',
                timestamp: Date.now(),
                data:      data || {}
            };
        }

        it('accepts first occurrence of a message ID', function () {
            let emitted = 0;
            pm.on('message', () => emitted++);

            let env = makePeerEnvelope('TEST', {});
            let raw = JSON.stringify(env);

            pm._handleInbound(mockWs, raw, 'ws://peer:10001');
            expect(emitted).to.equal(1);
        });

        it('rejects duplicate message ID', function () {
            let emitted = 0;
            pm.on('message', () => emitted++);

            let env = makePeerEnvelope('TEST', {});
            let raw = JSON.stringify(env);

            pm._handleInbound(mockWs, raw, 'ws://peer:10001');
            pm._handleInbound(mockWs, raw, 'ws://peer:10001');
            expect(emitted).to.equal(1);
        });
    });

    // -----------------------------------------------------------------
    // _verifySignature()
    // -----------------------------------------------------------------

    describe('_verifySignature()', function () {

        it('returns true for valid signature when REQUIRE_SIGNATURES is true', function () {
            pm.requireSigs = true;
            let identity = new ValidatorIdentity(keypair.privkeyHex);
            pm.setValidatorPubkeys(new Map([['ws://peer:10001', keypair.pubkeyHex]]));

            let env = {
                id: 'msg-1', type: 'TEST', sender: 'ws://peer:10001',
                timestamp: Date.now(), data: { x: 1 }
            };
            env.sig = identity.signEnvelope(env);

            expect(pm._verifySignature(env)).to.be.true;
        });

        it('returns false for invalid signature when REQUIRE_SIGNATURES is true', function () {
            pm.requireSigs = true;
            pm.setValidatorPubkeys(new Map([['ws://peer:10001', keypair.pubkeyHex]]));

            let env = {
                id: 'msg-1', type: 'TEST', sender: 'ws://peer:10001',
                timestamp: Date.now(), data: {}, sig: 'aa'.repeat(64)
            };

            expect(pm._verifySignature(env)).to.be.false;
        });

        it('returns true when REQUIRE_SIGNATURES is false (no sig)', function () {
            pm.requireSigs = false;
            let env = {
                id: 'msg-1', type: 'TEST', sender: 'ws://peer:10001',
                timestamp: Date.now(), data: {}
            };
            expect(pm._verifySignature(env)).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // Invalid JSON handling
    // -----------------------------------------------------------------

    describe('invalid JSON handling', function () {
        it('does not crash on non-JSON message', function () {
            let emitted = 0;
            pm.on('message', () => emitted++);

            expect(() => pm._handleInbound(null, 'not json', 'ws://peer:10001')).to.not.throw();
            expect(emitted).to.equal(0);
        });

        it('does not crash on empty string', function () {
            expect(() => pm._handleInbound(null, '', 'ws://peer:10001')).to.not.throw();
        });
    });

    // -----------------------------------------------------------------
    // broadcast()
    // -----------------------------------------------------------------

    describe('broadcast()', function () {
        it('returns an envelope', function () {
            let result = pm.broadcast('TEST', { val: 1 });
            expect(result).to.have.property('id');
            expect(result.type).to.equal('TEST');
        });
    });

    // -----------------------------------------------------------------
    // getPeerStatus()
    // -----------------------------------------------------------------

    describe('getPeerStatus()', function () {
        it('returns empty array when no peers', function () {
            expect(pm.getPeerStatus()).to.deep.equal([]);
        });
    });

    // -----------------------------------------------------------------
    // setIdentity() / setValidatorPubkeys()
    // -----------------------------------------------------------------

    describe('setter methods', function () {
        it('setIdentity stores identity', function () {
            let identity = new ValidatorIdentity(keypair.privkeyHex);
            pm.setIdentity(identity);
            expect(pm.identity).to.equal(identity);
        });

        it('setValidatorPubkeys stores map', function () {
            let map = new Map([['addr1', 'pk1']]);
            pm.setValidatorPubkeys(map);
            expect(pm.validatorPubkeys).to.equal(map);
        });
    });
});
