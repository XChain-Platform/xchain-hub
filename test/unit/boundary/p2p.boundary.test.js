'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon        = require('sinon');
const { expect }   = require('chai');
const EventEmitter = require('events');
const PeerManager  = require('../../../src/PeerManager');
const { createMockHub } = require('../../helpers/mockHub');

describe('Boundary: P2P Layer', function () {

    let pm, db;

    beforeEach(function () {
        db = {
            doQuery: sinon.stub().resolves([]),
            close:   sinon.stub().resolves()
        };

        pm = new PeerManager({
            P2P_VALIDATOR_ADDR:     'ws://self:10001',
            P2P_PORT:               0,
            P2P_HOST:               '127.0.0.1',
            REQUIRE_SIGNATURES:     false,
            P2P_HEARTBEAT_INTERVAL: 600000,
            P2P_RECONNECT_BASE:     60000,
            P2P_MSG_DEDUP_TTL:      60000,
            P2P_MAX_PAYLOAD:        1048576
        }, db);
    });

    afterEach(function () {
        if (pm.heartbeatTimer) clearInterval(pm.heartbeatTimer);
        if (pm.dedupTimer) clearInterval(pm.dedupTimer);
        if (pm.pingTimer) clearInterval(pm.pingTimer);
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // Envelope validation boundaries
    // -----------------------------------------------------------------

    describe('inbound message validation', function () {

        it('invalid JSON is silently discarded', function () {
            let emitted = false;
            pm.on('message', () => { emitted = true; });

            let mockWs = { _peerAddr: null, close: sinon.stub() };
            pm._handleInbound(mockWs, 'not-json', null);
            expect(emitted).to.be.false;
        });

        it('empty JSON object {} is rejected (missing type)', function () {
            let emitted = false;
            pm.on('message', () => { emitted = true; });

            let mockWs = { _peerAddr: null, close: sinon.stub() };
            pm._handleInbound(mockWs, '{}', null);
            expect(emitted).to.be.false;
        });

        it('missing id field is rejected', function () {
            let emitted = false;
            pm.on('message', () => { emitted = true; });

            let mockWs = { _peerAddr: null, close: sinon.stub() };
            pm._handleInbound(mockWs, JSON.stringify({
                type: 'TEST', sender: 'ws://peer:10001', timestamp: Date.now()
            }), null);
            expect(emitted).to.be.false;
        });

        it('missing sender field is rejected', function () {
            let emitted = false;
            pm.on('message', () => { emitted = true; });

            let mockWs = { _peerAddr: null, close: sinon.stub() };
            pm._handleInbound(mockWs, JSON.stringify({
                type: 'TEST', id: 'msg-1', timestamp: Date.now()
            }), null);
            expect(emitted).to.be.false;
        });

        it('non-number timestamp is rejected', function () {
            let emitted = false;
            pm.on('message', () => { emitted = true; });

            let mockWs = { _peerAddr: null, close: sinon.stub() };
            pm._handleInbound(mockWs, JSON.stringify({
                type: 'TEST', id: 'msg-1', sender: 'ws://peer:10001',
                timestamp: 'not-a-number'
            }), null);
            expect(emitted).to.be.false;
        });

        it('non-string type is rejected', function () {
            let emitted = false;
            pm.on('message', () => { emitted = true; });

            let mockWs = { _peerAddr: null, close: sinon.stub() };
            pm._handleInbound(mockWs, JSON.stringify({
                type: 123, id: 'msg-1', sender: 'ws://peer:10001',
                timestamp: Date.now()
            }), null);
            expect(emitted).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // Self-connection detection
    // -----------------------------------------------------------------

    describe('self-connection', function () {

        it('message from self is rejected and connection closed', function () {
            let emitted = false;
            pm.on('message', () => { emitted = true; });

            let mockWs = { _peerAddr: null, close: sinon.stub() };
            pm._handleInbound(mockWs, JSON.stringify({
                type: 'TEST', id: 'self-msg-1',
                sender: 'ws://self:10001', // Same as validatorAddr
                timestamp: Date.now(),
                data: {}
            }), null);

            expect(emitted).to.be.false;
            expect(mockWs.close.calledOnce).to.be.true;
            expect(mockWs.close.getCall(0).args[0]).to.equal(1000);
            expect(mockWs.close.getCall(0).args[1]).to.equal('self-connection');
        });

        it('message from self on already-registered peer does not close', function () {
            let mockWs = { _peerAddr: 'ws://already-known:10001', close: sinon.stub() };
            pm._handleInbound(mockWs, JSON.stringify({
                type: 'TEST', id: 'self-msg-2',
                sender: 'ws://self:10001',
                timestamp: Date.now(),
                data: {}
            }), null);

            // _peerAddr is not null, so close is NOT called
            expect(mockWs.close.called).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // Deduplication
    // -----------------------------------------------------------------

    describe('message deduplication', function () {

        it('same message ID is rejected on second receipt', function () {
            let emitCount = 0;
            pm.on('message', () => { emitCount++; });

            let mockWs = {
                _peerAddr: 'ws://peer:10001',
                close: sinon.stub(),
                readyState: 1 // OPEN
            };
            pm.peers.set('ws://peer:10001', { ws: mockWs, state: 'open', lastSeen: null });

            let envelope = JSON.stringify({
                type: 'TEST', id: 'dedup-test-1',
                sender: 'ws://peer:10001',
                timestamp: Date.now(),
                data: {}
            });

            pm._handleInbound(mockWs, envelope, 'ws://peer:10001');
            pm._handleInbound(mockWs, envelope, 'ws://peer:10001');

            expect(emitCount).to.equal(1);
        });

        it('own broadcast marks ID as seen', function () {
            pm.peers.set('ws://peer:10001', {
                ws: { readyState: 1, send: sinon.stub() },
                state: 'open'
            });

            let envelope = pm.broadcast('TEST', { foo: 'bar' });
            expect(pm.seenIds.has(envelope.id)).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // Signature verification boundaries
    // -----------------------------------------------------------------

    describe('signature verification', function () {

        it('unsigned message accepted when REQUIRE_SIGNATURES is false', function () {
            let envelope = {
                type: 'TEST', id: 'sig-1', sender: 'ws://peer:10001',
                timestamp: Date.now(), data: {}
                // No sig field
            };
            expect(pm._verifySignature(envelope)).to.be.true;
        });

        it('unsigned message rejected when REQUIRE_SIGNATURES is true', function () {
            pm.requireSigs = true;
            let envelope = {
                type: 'TEST', id: 'sig-2', sender: 'ws://peer:10001',
                timestamp: Date.now(), data: {}
            };
            expect(pm._verifySignature(envelope)).to.be.false;
        });

        it('unknown sender accepted when REQUIRE_SIGNATURES is false', function () {
            pm.validatorPubkeys = new Map(); // No known validators
            let envelope = {
                type: 'TEST', id: 'sig-3', sender: 'ws://unknown:10001',
                timestamp: Date.now(), data: {}, sig: 'somesig'
            };
            expect(pm._verifySignature(envelope)).to.be.true;
        });

        it('unknown sender rejected when REQUIRE_SIGNATURES is true', function () {
            pm.requireSigs = true;
            pm.validatorPubkeys = new Map(); // No known validators
            let envelope = {
                type: 'TEST', id: 'sig-4', sender: 'ws://unknown:10001',
                timestamp: Date.now(), data: {}, sig: 'somesig'
            };
            expect(pm._verifySignature(envelope)).to.be.false;
        });

        it('no pubkey registry → accept (bootstrap mode)', function () {
            pm.validatorPubkeys = null;
            let envelope = {
                type: 'TEST', id: 'sig-5', sender: 'ws://peer:10001',
                timestamp: Date.now(), data: {}, sig: 'anysig'
            };
            expect(pm._verifySignature(envelope)).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // Envelope building
    // -----------------------------------------------------------------

    describe('envelope building', function () {

        it('envelope has all required fields', function () {
            let env = pm._buildEnvelope('TEST', { x: 1 });
            expect(env.type).to.equal('TEST');
            expect(env.id).to.be.a('string');
            expect(env.sender).to.equal('ws://self:10001');
            expect(env.timestamp).to.be.a('number');
            expect(env.data).to.deep.equal({ x: 1 });
        });

        it('null data defaults to empty object', function () {
            let env = pm._buildEnvelope('TEST', null);
            expect(env.data).to.deep.equal({});
        });

        it('message IDs are unique', function () {
            let ids = new Set();
            for (let i = 0; i < 100; i++) {
                ids.add(pm._makeId());
            }
            expect(ids.size).to.equal(100);
        });
    });

    // -----------------------------------------------------------------
    // Peer status
    // -----------------------------------------------------------------

    describe('getPeerStatus', function () {

        it('returns empty array when no peers', function () {
            expect(pm.getPeerStatus()).to.deep.equal([]);
        });

        it('includes peer state and lastSeen', function () {
            pm.peers.set('ws://peer:10001', {
                ws: null, state: 'closed', lastSeen: 12345, inbound: true
            });
            let status = pm.getPeerStatus();
            expect(status).to.have.lengthOf(1);
            expect(status[0].addr).to.equal('ws://peer:10001');
            expect(status[0].state).to.equal('closed');
            expect(status[0].lastSeen).to.equal(12345);
            expect(status[0].inbound).to.be.true;
        });
    });
});
