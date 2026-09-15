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

const sinon        = require('sinon');
const { expect }   = require('chai');
const EventEmitter = require('events');
const PeerManager  = require('../../../src/peers/manager');
const { createMockHub, DB_METHODS } = require('../../helpers/mockHub');

let pm, db;

describe('Boundary: P2P Layer', registerBoundaryP2PLayer);

function registerBoundaryP2PLayer() {
    beforeEach(function () {
        db = {
            // Spread first so recordPeer's db.setP2pPeer(), which now carries the peer
            // upsert instead of PeerManager issuing SQL inline, still routes through the
            // doQuery stub below.
            ...DB_METHODS,
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
    // Envelope validation boundaries
    describe('inbound message validation', registerInboundMessageValidation);
    // Self-connection detection
    describe('self-connection', registerSelfConnection);
    // Deduplication
    describe('message deduplication', registerMessageDeduplication);
    // Signature verification boundaries
    describe('signature verification', registerSignatureVerification);
    // Envelope building
    describe('envelope building', registerEnvelopeBuilding);
    // Peer status
    describe('getPeerStatus', registerGetPeerStatus);
}

function registerInboundMessageValidation() {
    it('invalid JSON is silently discarded', testInvalidJSONIsSilentlyDiscarded);
    it('empty JSON object {} is rejected (missing type)', testEmptyJSONObjectIsRejectedMissingType);
    it('missing id field is rejected', testMissingIdFieldIsRejected);
    it('missing sender field is rejected', testMissingSenderFieldIsRejected);
    it('non-number timestamp is rejected', testNonNumberTimestampIsRejected);
    it('non-string type is rejected', testNonStringTypeIsRejected);
}
function testInvalidJSONIsSilentlyDiscarded() {
    let emitted = false;
    pm.on('message', () => { emitted = true; });

    let mockWs = { _peerAddr: null, close: sinon.stub() };
    pm.handleInbound(mockWs, 'not-json', null);
    expect(emitted).to.be.false;
}
function testEmptyJSONObjectIsRejectedMissingType() {
    let emitted = false;
    pm.on('message', () => { emitted = true; });

    let mockWs = { _peerAddr: null, close: sinon.stub() };
    pm.handleInbound(mockWs, '{}', null);
    expect(emitted).to.be.false;
}
function testMissingIdFieldIsRejected() {
    let emitted = false;
    pm.on('message', () => { emitted = true; });

    let mockWs = { _peerAddr: null, close: sinon.stub() };
    pm.handleInbound(mockWs, JSON.stringify({
        type: 'TEST', sender: 'ws://peer:10001', timestamp: Date.now()
    }), null);
    expect(emitted).to.be.false;
}
function testMissingSenderFieldIsRejected() {
    let emitted = false;
    pm.on('message', () => { emitted = true; });

    let mockWs = { _peerAddr: null, close: sinon.stub() };
    pm.handleInbound(mockWs, JSON.stringify({
        type: 'TEST', id: 'msg-1', timestamp: Date.now()
    }), null);
    expect(emitted).to.be.false;
}
function testNonNumberTimestampIsRejected() {
    let emitted = false;
    pm.on('message', () => { emitted = true; });

    let mockWs = { _peerAddr: null, close: sinon.stub() };
    pm.handleInbound(mockWs, JSON.stringify({
        type: 'TEST', id: 'msg-1', sender: 'ws://peer:10001',
        timestamp: 'not-a-number'
    }), null);
    expect(emitted).to.be.false;
}
function testNonStringTypeIsRejected() {
    let emitted = false;
    pm.on('message', () => { emitted = true; });

    let mockWs = { _peerAddr: null, close: sinon.stub() };
    pm.handleInbound(mockWs, JSON.stringify({
        type: 123, id: 'msg-1', sender: 'ws://peer:10001',
        timestamp: Date.now()
    }), null);
    expect(emitted).to.be.false;
}

function registerSelfConnection() {
    it('message from self is rejected and connection closed', testMessageFromSelfIsRejectedAndConnectionClosed);
    it('message from self on already-registered peer does not close', testMessageFromSelfOnAlreadyRegisteredPeerDoesNotClose);
}
function testMessageFromSelfIsRejectedAndConnectionClosed() {
    let emitted = false;
    pm.on('message', () => { emitted = true; });

    let mockWs = { _peerAddr: null, close: sinon.stub() };
    pm.handleInbound(mockWs, JSON.stringify({
        type: 'TEST', id: 'self-msg-1',
        sender: 'ws://self:10001', // Same as validatorAddr
        timestamp: Date.now(),
        data: {}
    }), null);

    expect(emitted).to.be.false;
    expect(mockWs.close.calledOnce).to.be.true;
    expect(mockWs.close.getCall(0).args[0]).to.equal(1000);
    expect(mockWs.close.getCall(0).args[1]).to.equal('self-connection');
}
function testMessageFromSelfOnAlreadyRegisteredPeerDoesNotClose() {
    let mockWs = { _peerAddr: 'ws://already-known:10001', close: sinon.stub() };
    pm.handleInbound(mockWs, JSON.stringify({
        type: 'TEST', id: 'self-msg-2',
        sender: 'ws://self:10001',
        timestamp: Date.now(),
        data: {}
    }), null);

    // _peerAddr is not null, so close is NOT called
    expect(mockWs.close.called).to.be.false;
}

function registerMessageDeduplication() {
    it('same message ID is rejected on second receipt', testSameMessageIDIsRejectedOnSecondReceipt);
    it('own broadcast marks ID as seen', testOwnBroadcastMarksIDAsSeen);
}
function testSameMessageIDIsRejectedOnSecondReceipt() {
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

    pm.handleInbound(mockWs, envelope, 'ws://peer:10001');
    pm.handleInbound(mockWs, envelope, 'ws://peer:10001');

    expect(emitCount).to.equal(1);
}
function testOwnBroadcastMarksIDAsSeen() {
    pm.peers.set('ws://peer:10001', {
        ws: { readyState: 1, send: sinon.stub() },
        state: 'open'
    });

    let envelope = pm.broadcast('TEST', { foo: 'bar' });
    expect(pm.seenIds.has(envelope.id)).to.be.true;
}

function registerSignatureVerification() {
    it('unsigned message accepted when REQUIRE_SIGNATURES is false', testUnsignedMessageAcceptedWhenREQUIRESIGNATURESIsFalse);
    it('unsigned message rejected when REQUIRE_SIGNATURES is true', testUnsignedMessageRejectedWhenREQUIRESIGNATURESIsTrue);
    it('unknown sender accepted when REQUIRE_SIGNATURES is false', testUnknownSenderAcceptedWhenREQUIRESIGNATURESIsFalse);
    it('unknown sender rejected when REQUIRE_SIGNATURES is true', testUnknownSenderRejectedWhenREQUIRESIGNATURESIsTrue);
    it('no pubkey registry → accept (bootstrap mode)', testNoPubkeyRegistryAcceptBootstrapMode);
}
function testUnsignedMessageAcceptedWhenREQUIRESIGNATURESIsFalse() {
    let envelope = {
        type: 'TEST', id: 'sig-1', sender: 'ws://peer:10001',
        timestamp: Date.now(), data: {}
        // No sig field
    };
    expect(pm.verifySignature(envelope)).to.be.true;
}
function testUnsignedMessageRejectedWhenREQUIRESIGNATURESIsTrue() {
    pm.requireSigs = true;
    let envelope = {
        type: 'TEST', id: 'sig-2', sender: 'ws://peer:10001',
        timestamp: Date.now(), data: {}
    };
    expect(pm.verifySignature(envelope)).to.be.false;
}
function testUnknownSenderAcceptedWhenREQUIRESIGNATURESIsFalse() {
    pm.validatorPubkeys = new Map(); // No known validators
    let envelope = {
        type: 'TEST', id: 'sig-3', sender: 'ws://unknown:10001',
        timestamp: Date.now(), data: {}, sig: 'somesig'
    };
    expect(pm.verifySignature(envelope)).to.be.true;
}
function testUnknownSenderRejectedWhenREQUIRESIGNATURESIsTrue() {
    pm.requireSigs = true;
    pm.validatorPubkeys = new Map(); // No known validators
    let envelope = {
        type: 'TEST', id: 'sig-4', sender: 'ws://unknown:10001',
        timestamp: Date.now(), data: {}, sig: 'somesig'
    };
    expect(pm.verifySignature(envelope)).to.be.false;
}
function testNoPubkeyRegistryAcceptBootstrapMode() {
    pm.validatorPubkeys = null;
    let envelope = {
        type: 'TEST', id: 'sig-5', sender: 'ws://peer:10001',
        timestamp: Date.now(), data: {}, sig: 'anysig'
    };
    expect(pm.verifySignature(envelope)).to.be.true;
}

function registerEnvelopeBuilding() {
    it('envelope has all required fields', testEnvelopeHasAllRequiredFields);
    it('null data defaults to empty object', testNullDataDefaultsToEmptyObject);
    it('message IDs are unique', testMessageIDsAreUnique);
}
function testEnvelopeHasAllRequiredFields() {
    let env = pm.buildEnvelope('TEST', { x: 1 });
    expect(env.type).to.equal('TEST');
    expect(env.id).to.be.a('string');
    expect(env.sender).to.equal('ws://self:10001');
    expect(env.timestamp).to.be.a('number');
    expect(env.data).to.deep.equal({ x: 1 });
}
function testNullDataDefaultsToEmptyObject() {
    let env = pm.buildEnvelope('TEST', null);
    expect(env.data).to.deep.equal({});
}
function testMessageIDsAreUnique() {
    let ids = new Set();
    for (let i = 0; i < 100; i++) {
        ids.add(pm.makeId());
    }
    expect(ids.size).to.equal(100);
}

function registerGetPeerStatus() {
    it('returns empty array when no peers', testReturnsEmptyArrayWhenNoPeers);
    it('includes peer state and lastSeen', testIncludesPeerStateAndLastSeen);
}
function testReturnsEmptyArrayWhenNoPeers() {
    expect(pm.getPeerStatus()).to.deep.equal([]);
}
function testIncludesPeerStateAndLastSeen() {
    pm.peers.set('ws://peer:10001', {
        ws: null, state: 'closed', lastSeen: 12345, inbound: true
    });
    let status = pm.getPeerStatus();
    expect(status).to.have.lengthOf(1);
    expect(status[0].addr).to.equal('ws://peer:10001');
    expect(status[0].state).to.equal('closed');
    expect(status[0].lastSeen).to.equal(12345);
    expect(status[0].inbound).to.be.true;
}
