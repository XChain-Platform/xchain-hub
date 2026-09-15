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

const sinon          = require('sinon');
const { expect }     = require('chai');
const { pubkeyForTestSender } = require('../helpers/fixtures');

// =================================================================
// PeerManager: Signature enforcement
// =================================================================

function signatureEnforcementSuite() {
        const PeerManager = require('../../src/peers/manager');

        it('REQUIRE_SIGNATURES defaults to true when not specified', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1' }, null);
            expect(pm.requireSigs).to.be.true;
        });

        it('REQUIRE_SIGNATURES can be disabled by setting false', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', REQUIRE_SIGNATURES: false }, null);
            expect(pm.requireSigs).to.be.false;
        });

        it('rejects unsigned messages when requireSigs is true', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', REQUIRE_SIGNATURES: true }, null);
            pm.validatorPubkeys = new Map();
            let envelope = { type: 'TEST', id: 'x1', sender: 'ws://peer:1', sig_pubkey: pubkeyForTestSender('ws://peer:1'), timestamp: Date.now(), data: {} };
            expect(pm.verifySignature(envelope)).to.be.false;
        });

        it('accepts unsigned messages when requireSigs is false', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', REQUIRE_SIGNATURES: false }, null);
            let envelope = { type: 'TEST', id: 'x1', sender: 'ws://peer:1', sig_pubkey: pubkeyForTestSender('ws://peer:1'), timestamp: Date.now(), data: {} };
            expect(pm.verifySignature(envelope)).to.be.true;
        });

        it('rejects a signed message when validatorPubkeys is null (fail closed, not bootstrap-accept)', function () {
            // Regression: a null registry (bootstrap / DB-load failure) once
            // returned true here, accepting any self-signed envelope from any
            // sender. It must now fail closed when signatures are required.
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', REQUIRE_SIGNATURES: true }, null);
            pm.validatorPubkeys = null;
            let envelope = { type: 'PBFT_PRE_PREPARE', id: 'x1', sender: 'ws://attacker:9',
                             timestamp: Date.now(), sig: 'deadbeef', data: {} };
            expect(pm.verifySignature(envelope)).to.be.false;
        });
    }

// =================================================================
// PeerManager: Sender<->key binding (Option A transport auth)
//
// A valid Ed25519 signature authenticates the KEY, but count-mode PBFT
// tallies and the oracle submission map are keyed by envelope.sender. If
// the transport does not bind sender to the signing key, one authorized
// validator key can impersonate every OTHER validator's addr and forge a
// full quorum / poison the oracle median. This locks the binding.
// =================================================================
function senderKeyBindingSuite() {
        const PeerManager       = require('../../src/peers/manager');
        const ValidatorIdentity = require('../../src/validators/identity');

        const A = ValidatorIdentity.generate();
        const B = ValidatorIdentity.generate();
        const addrA = 'ws://a:10001', addrB = 'ws://b:10001';
        const idA = new ValidatorIdentity(A.privkeyHex);

        function makePm() {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: addrA, REQUIRE_SIGNATURES: true }, null);
            pm.setValidatorPubkeys(new Map([[addrA, A.pubkeyHex], [addrB, B.pubkeyHex]]));
            pm.setEffectiveSignerSet(new Set([A.pubkeyHex.toLowerCase(), B.pubkeyHex.toLowerCase()]));
            return pm;
        }

        function signedAs(senderAddr) {
            let env = { type: 'PBFT_PREPARE', id: 'e:' + Math.random().toString(16).slice(2),
                        sender: senderAddr, timestamp: Date.now(),
                        data: { seq: 1, configDigest: 'deadbeef' }, sig_pubkey: idA.getPubkeyHex() };
            env.sig = idA.signEnvelope(env);
            return env;
        }

        it('accepts a message whose sender matches the signing key', function () {
            expect(makePm().verifySignature(signedAs(addrA))).to.be.true;
        });

        it('rejects a message that names another validator addr but is signed by a different key', function () {
            // Attacker A holds a valid, registered, chain-effective key, yet claims
            // to be B. Membership passes and the signature is genuine, but the
            // sender it claims (B) is registered to a DIFFERENT key, so it must be
            // dropped. This is the quorum-forgery / median-poisoning primitive.
            expect(makePm().verifySignature(signedAs(addrB))).to.be.false;
        });

        it('rejects the forgery even when the effective signer set alone would admit the key', function () {
            let pm = makePm();
            // Registry still binds addrB -> B's key; effective set admits A's key.
            // The binding (registry) must win over bare membership.
            expect(pm.verifySignature(signedAs(addrB))).to.be.false;
        });
    }

// =================================================================
// XChainHub: Fail-closed validator registry on startup
// =================================================================
function validatorRegistrySuite() {
        const XChainHub   = require('../../src/XChainHub');
        const PeerManager = require('../../src/peers/manager');

        it('startP2P throws and never opens the P2P listener when the registry load fails', async function () {
            // Regression: a DB failure in _loadValidatorPubkeys once left
            // validatorPubkeys === null while peerManager.start() ran anyway,
            // opening the listener with no registry in memory.
            let startStub = sinon.stub(PeerManager.prototype, 'start').resolves();

            let h = new XChainHub('h', 3306, 'db', 'u', 'p',
                { P2P_VALIDATOR_ADDR: 'ws://a:1', REQUIRE_SIGNATURES: true });
            // Skip start(); inject a db whose validator-load query rejects so
            // loadValidatorPubkeys throws before peerManager.start() can run.
            h.db = { doQuery: sinon.stub().rejects(new Error('DB down')) };

            let threw = false;
            try { await h.startP2P(); } catch (e) { threw = true; }
            expect(threw).to.be.true;
            expect(startStub.called).to.be.false;
        });
    }

// =================================================================
// PeerManager: Dedup cache bounds
// =================================================================
function dedupCacheSuite() {
        const PeerManager = require('../../src/peers/manager');

        it('evicts oldest entry when dedup cache reaches max', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', P2P_DEDUP_CACHE_MAX: '5' }, null);
            for (let i = 0; i < 5; i++) {
                pm.addToDedup('id-' + i);
            }
            expect(pm.seenIds.size).to.equal(5);
            pm.addToDedup('id-5');
            expect(pm.seenIds.size).to.equal(5);
            expect(pm.seenIds.has('id-0')).to.be.false;
            expect(pm.seenIds.has('id-5')).to.be.true;
        });
    }

// =================================================================
// PeerManager: Peer address validation
// =================================================================
function peerAddressSuite() {
        const PeerManager = require('../../src/peers/manager');

        it('rejects peer addresses without port', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1' }, null);
            pm.connectToPeer('not-a-valid-addr');
            expect(pm.peers.has('not-a-valid-addr')).to.be.false;
        });

        it('accepts peer addresses with ws:// scheme prefix', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1' }, null);
            pm.connectToPeer('ws://peer.example.com:10001');
            expect(pm.peers.has('ws://peer.example.com:10001')).to.be.true;
            // Clean up the connecting peer entry
            let peer = pm.peers.get('ws://peer.example.com:10001');
            if (peer && peer.ws) try { peer.ws.terminate(); } catch(e) {}
            pm.peers.delete('ws://peer.example.com:10001');
        });

        it('rejects empty string', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1' }, null);
            pm.connectToPeer('');
            expect(pm.peers.has('')).to.be.false;
        });
    }

// =================================================================
// PeerManager: Per-peer rate limiting
// =================================================================
function peerRateLimitSuite() {
        const PeerManager = require('../../src/peers/manager');

        it('allows messages within rate limit', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', P2P_MSG_RATE_LIMIT: '10' }, null);
            for (let i = 0; i < 10; i++) {
                expect(pm.checkMsgRate('peer-1')).to.be.true;
            }
        });

        it('rejects messages exceeding rate limit', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', P2P_MSG_RATE_LIMIT: '5' }, null);
            for (let i = 0; i < 5; i++) {
                pm.checkMsgRate('peer-1');
            }
            expect(pm.checkMsgRate('peer-1')).to.be.false;
        });

        it('rate limits are per-peer (independent)', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', P2P_MSG_RATE_LIMIT: '2' }, null);
            pm.checkMsgRate('peer-1');
            pm.checkMsgRate('peer-1');
            expect(pm.checkMsgRate('peer-1')).to.be.false;
            // peer-2 should still be allowed
            expect(pm.checkMsgRate('peer-2')).to.be.true;
        });
    }

// =================================================================
// PeerManager: Invalid JSON logging
// =================================================================
function invalidJsonSuite() {
        const PeerManager = require('../../src/peers/manager');

        it('logs warning for invalid JSON instead of silent discard', function () {
            let pm = new PeerManager({ P2P_VALIDATOR_ADDR: 'ws://a:1', REQUIRE_SIGNATURES: false }, null);
            let warnStub = sinon.stub(console, 'warn');
            let mockWs = { _peerAddr: null };
            pm.handleInbound(mockWs, 'not-json{{{', null);
            expect(warnStub.calledWith(sinon.match('P2P: Invalid JSON'))).to.be.true;
        });
    }





function securityHardeningSuite() {
    afterEach(function () {
        sinon.restore();
    });
    describe('PeerManager: Signature enforcement', signatureEnforcementSuite);
    describe('PeerManager: Sender<->key binding', senderKeyBindingSuite);
    describe('XChainHub: Fail-closed validator registry', validatorRegistrySuite);
    describe('PeerManager: Dedup cache bounds', dedupCacheSuite);
    describe('PeerManager: Peer address validation', peerAddressSuite);
    describe('PeerManager: Per-peer rate limiting', peerRateLimitSuite);
    describe('PeerManager: Invalid JSON logging', invalidJsonSuite);
}

describe('Security Hardening', securityHardeningSuite);
