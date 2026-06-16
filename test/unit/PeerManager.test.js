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

        it('rejects when signatures are required but missing', function () {
            pm.requireSigs = true;
            expect(pm._verifySignature({ sender: 'x' })).to.be.false;
        });

        it('rejects a signed message when the validator registry is null (fail closed)', function () {
            // A null registry means no sender can be authenticated, so a signed
            // envelope must be rejected, not trusted — accepting here would let
            // any self-signed message through while the registry is unloaded.
            pm.requireSigs = true;
            pm.validatorPubkeys = null;
            expect(pm._verifySignature({ sender: 'x', sig: 'aa' })).to.be.false;
        });

        it('null registry still accepts when signatures are not required', function () {
            pm.requireSigs = false;
            pm.validatorPubkeys = null;
            expect(pm._verifySignature({ sender: 'x', sig: 'aa' })).to.be.true;
        });

        it('defers to the requireSigs policy for an unknown sender', function () {
            pm.setValidatorPubkeys(new Map([['known', 'pk']]));
            pm.requireSigs = true;
            expect(pm._verifySignature({ sender: 'unknown', sig: 'aa' })).to.be.false;
            pm.requireSigs = false;
            expect(pm._verifySignature({ sender: 'unknown', sig: 'aa' })).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // _verifySignature() — Option A (sig_pubkey union membership)
    // -----------------------------------------------------------------

    describe('_verifySignature() — Option A', function () {

        let identity;
        beforeEach(function () {
            pm.requireSigs = true;
            identity = new ValidatorIdentity(keypair.privkeyHex);
        });

        // Build a signed Option-A envelope (sig_pubkey carried) from `identity`.
        function signedEnv(id) {
            let env = {
                id: id || 'oa-1', type: 'TEST', sender: 'ws://peer:10001',
                timestamp: Date.now(), data: { x: 1 }, sig_pubkey: keypair.pubkeyHex
            };
            env.sig = identity.signEnvelope(env);
            return env;
        }

        it('accepts when sig_pubkey is in the chain-effective signer set', function () {
            pm.setEffectiveSignerSet(new Set([keypair.pubkeyHex.toLowerCase()]));
            // Registry is empty — admission must come purely from the effective set.
            pm.setValidatorPubkeys(new Map());
            expect(pm._verifySignature(signedEnv())).to.be.true;
        });

        it('accepts when sig_pubkey is in the registry pubkey set (addr-independent)', function () {
            // Registry maps a DIFFERENT addr to this pubkey — membership is by
            // pubkey value, not by envelope.sender.
            pm.setValidatorPubkeys(new Map([['ws://other-addr:9', keypair.pubkeyHex]]));
            pm.setEffectiveSignerSet(null);
            expect(pm._verifySignature(signedEnv())).to.be.true;
        });

        it('rejects (sigs required) when sig_pubkey is in neither set', function () {
            pm.setValidatorPubkeys(new Map());
            pm.setEffectiveSignerSet(new Set(['deadbeef'.repeat(8)]));
            expect(pm._verifySignature(signedEnv())).to.be.false;
        });

        it('rejects a bad signature even for a member key', function () {
            pm.setEffectiveSignerSet(new Set([keypair.pubkeyHex.toLowerCase()]));
            let env = signedEnv();
            env.sig = 'aa'.repeat(64); // corrupt
            expect(pm._verifySignature(env)).to.be.false;
        });

        it('checks membership BEFORE running the Ed25519 verify (DoS guard)', function () {
            let verifySpy = sinon.spy(ValidatorIdentity, 'verify');
            pm.setValidatorPubkeys(new Map());
            pm.setEffectiveSignerSet(new Set()); // not a member
            expect(pm._verifySignature(signedEnv())).to.be.false;
            expect(verifySpy.called).to.be.false; // never reached verify
        });

        it('rejects a denylisted pubkey before verify, even if otherwise a member', function () {
            let pk = keypair.pubkeyHex.toLowerCase();
            pm.denyPubkeys = new Set([pk]);
            pm.setEffectiveSignerSet(new Set([pk]));         // in the set...
            pm.setValidatorPubkeys(new Map([['a', keypair.pubkeyHex]])); // ...and registry
            let verifySpy = sinon.spy(ValidatorIdentity, 'verify');
            expect(pm._verifySignature(signedEnv())).to.be.false;
            expect(verifySpy.called).to.be.false; // denylist short-circuits before verify
        });

        it('backward-compat: a pre-A envelope (no sig_pubkey) still uses the addr→pubkey map', function () {
            let env = {
                id: 'bc-1', type: 'TEST', sender: 'ws://peer:10001',
                timestamp: Date.now(), data: {}
            };
            env.sig = identity.signEnvelope(env); // signed without sig_pubkey in canonical
            pm.setValidatorPubkeys(new Map([['ws://peer:10001', keypair.pubkeyHex]]));
            pm.setEffectiveSignerSet(null);
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

    // -----------------------------------------------------------------
    // broadcast() / sendToPeer() with peers
    // -----------------------------------------------------------------

    describe('broadcast() / sendToPeer() over peers', function () {
        it('broadcast sends only to OPEN peers', function () {
            let openWs   = { readyState: 1, send: sinon.stub() };
            let closedWs = { readyState: 3, send: sinon.stub() };
            pm.peers.set('a', { ws: openWs });
            pm.peers.set('b', { ws: closedWs });
            pm.broadcast('T', { x: 1 });
            expect(openWs.send.calledOnce).to.be.true;
            expect(closedWs.send.called).to.be.false;
        });

        it('sendToPeer returns false for unknown/closed peers and true on success', function () {
            expect(pm.sendToPeer('nope', 'T', {})).to.be.false;
            let ws = { readyState: 1, send: sinon.stub() };
            pm.peers.set('a', { ws });
            expect(pm.sendToPeer('a', 'T', {})).to.be.true;
            expect(ws.send.calledOnce).to.be.true;
        });

        it('_send reports a send error via the callback', function () {
            let ws = { readyState: 1, send: (data, cb) => cb(new Error('boom')) };
            expect(() => pm._send(ws, '{}')).to.not.throw();
        });
    });

    // -----------------------------------------------------------------
    // _handleInbound — guards, events, self-connection, rate limit, sig
    // -----------------------------------------------------------------

    describe('_handleInbound() branches', function () {
        function mk(type, id, sender) {
            return JSON.stringify({ id, type, sender: sender || 'ws://peer:10001', timestamp: Date.now(), data: {} });
        }

        it('ignores non-object JSON and malformed envelopes', function () {
            let emitted = 0;
            pm.on('message', () => emitted++);
            pm._handleInbound({}, 'null', 'a');
            pm._handleInbound({}, '123', 'a');
            pm._handleInbound({}, '[1,2]', 'a');
            pm._handleInbound({}, JSON.stringify({ type: 'T' }), 'a');                 // missing id/sender/ts
            pm._handleInbound({}, JSON.stringify({ id: 'x', type: 'T', sender: 's', timestamp: 'nan' }), 'a');
            expect(emitted).to.equal(0);
        });

        it('drops an envelope whose timestamp is outside the freshness window (anti-replay)', function () {
            let emitted = 0;
            pm.on('message', () => emitted++);
            let stale = JSON.stringify({
                id: 'stale1', type: 'T', sender: 'ws://peer:10001',
                timestamp: Date.now() - 400000, data: {}  // > default 300s skew
            });
            pm._handleInbound({ _peerAddr: 'ws://peer:10001' }, stale, 'ws://peer:10001');
            expect(emitted).to.equal(0);
        });

        it('closes a fresh self-connection', function () {
            let closed = null;
            let ws = { _peerAddr: null, close: (code, reason) => { closed = { code, reason }; } };
            pm._handleInbound(ws, mk('T', 'self1', pm.validatorAddr), null);
            expect(closed.code).to.equal(1000);
        });

        it('drops messages once a peer exceeds the rate limit', function () {
            pm.msgRateLimit = 1;
            let emitted = 0;
            pm.on('message', () => emitted++);
            let ws = { _peerAddr: 'ws://peer:10001' };
            pm._handleInbound(ws, mk('T', 'a'), 'ws://peer:10001');
            pm._handleInbound(ws, mk('T', 'b'), 'ws://peer:10001');
            expect(emitted).to.equal(1);
        });

        it('drops messages with an invalid signature when signatures are required', function () {
            pm.requireSigs = true;
            pm.setValidatorPubkeys(new Map([['ws://peer:10001', keypair.pubkeyHex]]));
            let emitted = 0;
            pm.on('message', () => emitted++);
            let env = { id: 'sigbad', type: 'T', sender: 'ws://peer:10001', timestamp: Date.now(), data: {}, sig: 'aa'.repeat(64) };
            pm._handleInbound({ _peerAddr: 'ws://peer:10001' }, JSON.stringify(env), 'ws://peer:10001');
            expect(emitted).to.equal(0);
        });

        it('emits heartbeat and capability events for the matching message types', function () {
            let hb = null, cap = null;
            pm.on('heartbeat', (s, t) => { hb = { s, t }; });
            pm.on('capability', (e) => { cap = e; });
            pm._handleInbound({ _peerAddr: 'ws://peer:10001' }, mk('HEARTBEAT', 'h1'), 'ws://peer:10001');
            pm._handleInbound({ _peerAddr: 'ws://peer:10001' }, mk('CAPABILITY_ACTIVATED', 'c1'), 'ws://peer:10001');
            expect(hb).to.not.be.null;
            expect(cap).to.not.be.null;
            expect(cap.type).to.equal('CAPABILITY_ACTIVATED');
        });

        it('registers a previously-unknown inbound peer from the first message', function () {
            let ws = { _peerAddr: null };
            let connected = null;
            pm.on('peer:connect', (a) => { connected = a; });
            pm._handleInbound(ws, mk('T', 'reg1'), null);
            expect(ws._peerAddr).to.equal('ws://peer:10001');
            expect(pm.peers.get('ws://peer:10001').inbound).to.be.true;
            expect(connected).to.equal('ws://peer:10001');
        });

        it('updates lastSeen for an already-known peer', function () {
            let ws = { _peerAddr: 'ws://peer:10001' };
            pm.peers.set('ws://peer:10001', { ws, inbound: true, state: 'open', lastSeen: 0 });
            pm._handleInbound(ws, mk('T', 'ls1'), 'ws://peer:10001');
            expect(pm.peers.get('ws://peer:10001').lastSeen).to.be.greaterThan(0);
        });
    });

    // -----------------------------------------------------------------
    // _relay()
    // -----------------------------------------------------------------

    describe('_relay()', function () {
        it('sends to other open peers, skipping the original sender and the source ws', function () {
            let sourceWs = { readyState: 1, send: sinon.stub() };
            let otherWs  = { readyState: 1, send: sinon.stub() };
            let senderWs = { readyState: 1, send: sinon.stub() };
            pm.peers.set('ws://sender:1', { ws: senderWs });  // original sender — skipped
            pm.peers.set('ws://src:1',    { ws: sourceWs });  // source ws — skipped
            pm.peers.set('ws://other:1',  { ws: otherWs });
            pm._relay({ id: 'm', type: 'T', sender: 'ws://sender:1', timestamp: 1, data: {} }, sourceWs);
            expect(otherWs.send.calledOnce).to.be.true;
            expect(sourceWs.send.called).to.be.false;
            expect(senderWs.send.called).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // inbound peer registration / removal
    // -----------------------------------------------------------------

    describe('_registerInboundPeer() / _removeInboundPeer()', function () {
        it('keeps an existing outbound connection when an inbound arrives for the same addr', function () {
            let outboundWs = { readyState: 1 };
            pm.peers.set('ws://p:1', { ws: outboundWs, inbound: false, state: 'open' });
            let inboundWs = {};
            pm._registerInboundPeer(inboundWs, 'ws://p:1');
            expect(pm.peers.get('ws://p:1').ws).to.equal(outboundWs); // outbound preserved
            expect(inboundWs._peerAddr).to.equal('ws://p:1');
        });

        it('registers a brand-new inbound peer', function () {
            let connected = null;
            pm.on('peer:connect', (a) => { connected = a; });
            pm._registerInboundPeer({}, 'ws://p:2');
            expect(pm.peers.get('ws://p:2').inbound).to.be.true;
            expect(connected).to.equal('ws://p:2');
        });

        it('_removeInboundPeer returns quietly when the ws has no addr', function () {
            expect(() => pm._removeInboundPeer({ _peerAddr: null })).to.not.throw();
        });

        it('_removeInboundPeer deletes the peer, emits disconnect, and decrements the IP count', function () {
            let ws = { _peerAddr: 'ws://p:1', _remoteIp: '1.2.3.4' };
            pm.peers.set('ws://p:1', { ws, inbound: true, state: 'open' });
            pm.ipConnectionCounts.set('1.2.3.4', 2);
            let dis = null;
            pm.on('peer:disconnect', (a) => { dis = a; });
            pm._removeInboundPeer(ws);
            expect(pm.peers.has('ws://p:1')).to.be.false;
            expect(dis).to.equal('ws://p:1');
            expect(pm.ipConnectionCounts.get('1.2.3.4')).to.equal(1);
        });

        it('_removeInboundPeer clears the IP entry when the count reaches zero', function () {
            let ws = { _peerAddr: 'ws://p:1', _remoteIp: '5.6.7.8' };
            pm.peers.set('ws://p:1', { ws, inbound: true, state: 'open' });
            pm.ipConnectionCounts.set('5.6.7.8', 1);
            pm._removeInboundPeer(ws);
            expect(pm.ipConnectionCounts.has('5.6.7.8')).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // _connectToPeer() / _scheduleReconnect() (no real sockets)
    // -----------------------------------------------------------------

    describe('_connectToPeer() / _scheduleReconnect()', function () {
        it('_connectToPeer rejects an invalid address format', function () {
            pm._connectToPeer('not-an-addr');
            expect(pm.peers.has('not-an-addr')).to.be.false;
        });

        it('_connectToPeer is a no-op when already connected/connecting', function () {
            pm.peers.set('ws://p:1', { state: 'open' });
            pm._connectToPeer('ws://p:1');
            expect(pm.peers.get('ws://p:1').state).to.equal('open'); // untouched
        });

        it('_scheduleReconnect does nothing when not running', function () {
            pm.running = false;
            pm.peers.set('ws://p:1', { inbound: false, reconnectDelay: 2000 });
            pm._scheduleReconnect('ws://p:1');
            expect(pm.peers.get('ws://p:1').reconnectTimer).to.be.undefined;
        });

        it('_scheduleReconnect skips inbound peers', function () {
            pm.running = true;
            pm.peers.set('ws://p:1', { inbound: true });
            pm._scheduleReconnect('ws://p:1');
            expect(pm.peers.get('ws://p:1').reconnectTimer).to.be.undefined;
        });

        it('_scheduleReconnect arms a timer, doubles the backoff, and reconnects', function () {
            let clock = sinon.useFakeTimers();
            pm.running = true;
            let connect = sinon.stub(pm, '_connectToPeer');
            pm.peers.set('ws://p:1', { inbound: false, reconnectDelay: 2000 });
            pm._scheduleReconnect('ws://p:1');
            expect(pm.peers.get('ws://p:1').reconnectDelay).to.equal(4000); // doubled
            clock.tick(3000); // delay+jitter ∈ [2000,2500) → fires
            expect(connect.calledWith('ws://p:1')).to.be.true;
            clock.restore();
        });
    });

    // -----------------------------------------------------------------
    // Timers: heartbeat / dedup pruner / ping
    // -----------------------------------------------------------------

    describe('background timers', function () {
        it('_startHeartbeat broadcasts HEARTBEAT on its interval', function () {
            let clock = sinon.useFakeTimers();
            config.P2P_HEARTBEAT_INTERVAL = 1000;
            let bcast = sinon.stub(pm, 'broadcast');
            pm._startHeartbeat();
            clock.tick(1001);
            expect(bcast.calledWith('HEARTBEAT')).to.be.true;
            clearInterval(pm.heartbeatTimer);
            clock.restore();
        });

        it('_startDedupPruner removes expired ids and keeps live ones', function () {
            let clock = sinon.useFakeTimers();
            config.P2P_DEDUP_PRUNE_INTERVAL = 1000;
            pm.seenIds.set('old', Date.now() - 1);       // expired
            pm.seenIds.set('fresh', Date.now() + 100000); // live
            pm._startDedupPruner();
            clock.tick(1001);
            expect(pm.seenIds.has('old')).to.be.false;
            expect(pm.seenIds.has('fresh')).to.be.true;
            clearInterval(pm.dedupTimer);
            clock.restore();
        });

        it('_startPingInterval pings live peers/clients and terminates unresponsive ones', function () {
            let clock = sinon.useFakeTimers();
            config.P2P_WS_PING_INTERVAL = 1000;
            let liveOut = { readyState: 1, _isAlive: true,  ping: sinon.stub(), terminate: sinon.stub() };
            let liveIn  = { _isAlive: true,  ping: sinon.stub(), terminate: sinon.stub() };
            let deadIn  = { _isAlive: false, ping: sinon.stub(), terminate: sinon.stub() };
            pm.peers.set('ws://live:1', { ws: liveOut, inbound: false, state: 'open' });
            pm.wss = { clients: new Set([liveIn, deadIn]) };
            pm._startPingInterval();
            clock.tick(1001);
            expect(liveOut.ping.called).to.be.true;
            expect(liveOut._isAlive).to.be.false;
            expect(liveIn.ping.called).to.be.true;
            expect(deadIn.terminate.called).to.be.true;
            clearInterval(pm.pingTimer);
            clock.restore();
        });

        it('_startPingInterval terminates an unresponsive outbound peer', function () {
            let clock = sinon.useFakeTimers();
            config.P2P_WS_PING_INTERVAL = 1000;
            let deadOut = { readyState: 1, _isAlive: false, ping: sinon.stub(), terminate: sinon.stub() };
            pm.peers.set('ws://dead:1', { ws: deadOut, inbound: false, state: 'open' });
            pm._startPingInterval();
            clock.tick(1001);
            expect(deadOut.terminate.called).to.be.true;
            clearInterval(pm.pingTimer);
            clock.restore();
        });
    });

    // -----------------------------------------------------------------
    // dedup cache bound / rate window / DB recording
    // -----------------------------------------------------------------

    describe('_addToDedup() / _checkMsgRate() / _recordPeer()', function () {
        it('_addToDedup evicts the oldest id at the cache cap', function () {
            pm.dedupCacheMax = 2;
            pm._addToDedup('a');
            pm._addToDedup('b');
            pm._addToDedup('c');
            expect(pm.seenIds.has('a')).to.be.false;
            expect(pm.seenIds.size).to.equal(2);
        });

        it('_checkMsgRate allows up to the limit, blocks past it, and resets after the window', function () {
            let clock = sinon.useFakeTimers();
            pm.msgRateLimit = 2;
            expect(pm._checkMsgRate('a')).to.be.true;  // 1
            expect(pm._checkMsgRate('a')).to.be.true;  // 2
            expect(pm._checkMsgRate('a')).to.be.false; // 3 > 2
            clock.tick(60001);
            expect(pm._checkMsgRate('a')).to.be.true;  // window reset
            clock.restore();
        });

        it('_recordPeer is a no-op without a db', function () {
            let pm2 = new PeerManager(config, null);
            expect(() => pm2._recordPeer('a', 'a', true)).to.not.throw();
        });

        it('_recordPeer issues an upsert into p2p_peers', function () {
            pm._recordPeer('ws://p:1', 'ws://p:1', true);
            expect(dbStub.doQuery.calledOnce).to.be.true;
            expect(dbStub.doQuery.getCall(0).args[0]).to.include('p2p_peers');
            expect(dbStub.doQuery.getCall(0).args[1]).to.deep.equal(['ws://p:1', 'ws://p:1', 1, 'ws://p:1']);
        });
    });

    // -----------------------------------------------------------------
    // Full lifecycle over real localhost sockets
    // -----------------------------------------------------------------

    describe('P2P lifecycle (real localhost sockets)', function () {
        let nodes;
        const net = require('net');

        // Allocate an OS-assigned free port. PeerManager treats P2P_PORT:0 as
        // falsy and falls back to 10001, so we must pass a concrete free port.
        function freePort() {
            return new Promise((resolve, reject) => {
                let s = net.createServer();
                s.on('error', reject);
                s.listen(0, '127.0.0.1', () => {
                    let p = s.address().port;
                    s.close(() => resolve(p));
                });
            });
        }

        beforeEach(function () { nodes = []; });
        afterEach(async function () {
            for (let n of nodes) { try { await n.stop(); } catch (e) { /* already stopped */ } }
        });

        function mkNode(port, seeds, addr) {
            let cfg = {
                P2P_VALIDATOR_ADDR: addr, P2P_PORT: port, P2P_HOST: '127.0.0.1',
                SEED_NODES: seeds || [], REQUIRE_SIGNATURES: false,
                P2P_HEARTBEAT_INTERVAL: 100000, P2P_DEDUP_PRUNE_INTERVAL: 100000,
                P2P_WS_PING_INTERVAL: 100000, P2P_RECONNECT_BASE: 200,
                P2P_RECONNECT_MAX: 2000, P2P_MAX_PAYLOAD: 1048576
            };
            let n = new PeerManager(cfg, { doQuery: sinon.stub().resolves([]) });
            nodes.push(n);
            return n;
        }

        it('two nodes connect, exchange a message, register peers, and shut down cleanly', async function () {
            this.timeout(10000);
            let portA = await freePort();
            let portB = await freePort();
            let a = mkNode(portA, [], 'ws://nodeA:1');
            await a.start();

            let b = mkNode(portB, ['ws://127.0.0.1:' + portA], 'ws://nodeB:1');
            let bConnected = new Promise(r => b.once('peer:connect', r));
            await b.start();
            await bConnected; // B's outbound to A is open

            let aMsg  = new Promise(r => a.once('message', r));
            let aPeer = new Promise(r => a.once('peer:connect', r));
            b.broadcast('TEST', { hello: 'world' });
            let env = await aMsg;
            await aPeer;

            expect(env.type).to.equal('TEST');
            expect(env.data.hello).to.equal('world');
            expect(a.getPeerStatus().some(p => p.inbound && p.state === 'open')).to.be.true;
            expect(b.getPeerStatus().some(p => !p.inbound && p.state === 'open')).to.be.true;

            await b.stop();
            await a.stop();
            expect(a.running).to.be.false;
            expect(a.httpServer).to.be.null;
        });

        it('rejects inbound connections beyond the per-IP limit', async function () {
            this.timeout(10000);
            const WebSocket = require('ws');
            let portA = await freePort();
            let a = mkNode(portA, [], 'ws://limited:1');
            a.maxConnectionsPerIp = 1;
            await a.start();

            // First client connects and stays open.
            let c1 = new WebSocket('ws://127.0.0.1:' + portA);
            await new Promise((res, rej) => { c1.once('open', res); c1.once('error', rej); });

            // Second client from the same IP should be closed by the server.
            let c2 = new WebSocket('ws://127.0.0.1:' + portA);
            let c2Closed = await new Promise((res) => {
                c2.once('close', (code) => res(code));
                c2.once('open', () => {/* may briefly open before close frame */});
            });
            expect(c2Closed).to.equal(1008);

            c1.close();
            await a.stop();
        });
    });
});
