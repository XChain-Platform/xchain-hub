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

const sinon            = require('sinon');
const { expect }       = require('chai');
const WebSocket        = require('ws');
const testDb           = require('../../helpers/testDb');
const { createPeerPair, buildEnvelope, sendEnvelope, waitForEvent } = require('../../helpers/testPeerNetwork');
const ValidatorIdentity = require('../../../src/ValidatorIdentity');

describe('Integration: P2P Message Routing (SC-9.x)', function () {

    let peerPair = null;

    before(async function () {
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable — skipping P2P tests');
        }
    });

    after(async function () { await testDb.teardown(); });

    beforeEach(async function () {
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
    });

    afterEach(async function () {
        if (peerPair) {
            if (peerPair.peerWs.readyState <= WebSocket.OPEN) {
                peerPair.peerWs.close();
            }
            await peerPair.pm.stop();
            peerPair = null;
        }
        sinon.restore();
    });

    // SC-9.1: Message type routing to correct subsystem
    describe('SC-9.1: Message type routing', function () {
        it('emits message event for valid envelopes', async function () {
            let db = testDb.getDb();
            peerPair = await createPeerPair(db);

            let received = [];
            peerPair.pm.on('message', (env) => { received.push(env); });

            // Send different message types
            let types = ['ORACLE_PRICE_SUBMIT', 'PBFT_PRE_PREPARE', 'XCHAIN_ATTEST_PROPOSE'];
            for (let type of types) {
                let env = buildEnvelope(type, { test: true }, 'ws://peer-1:10001');
                sendEnvelope(peerPair.peerWs, env);
            }

            await new Promise(r => setTimeout(r, 200));

            expect(received).to.have.lengthOf(3);
            expect(received[0].type).to.equal('ORACLE_PRICE_SUBMIT');
            expect(received[1].type).to.equal('PBFT_PRE_PREPARE');
            expect(received[2].type).to.equal('XCHAIN_ATTEST_PROPOSE');
        });

        it('emits heartbeat event for HEARTBEAT type', async function () {
            let db = testDb.getDb();
            peerPair = await createPeerPair(db);

            let heartbeats = [];
            peerPair.pm.on('heartbeat', (sender, ts) => { heartbeats.push({ sender, ts }); });

            let env = buildEnvelope('HEARTBEAT', { version: '1.0.0' }, 'ws://peer-hb:10001');
            sendEnvelope(peerPair.peerWs, env);

            await new Promise(r => setTimeout(r, 200));

            expect(heartbeats).to.have.lengthOf(1);
            expect(heartbeats[0].sender).to.equal('ws://peer-hb:10001');
        });

        it('silently drops messages with invalid JSON', async function () {
            let db = testDb.getDb();
            peerPair = await createPeerPair(db);

            let received = [];
            peerPair.pm.on('message', (env) => { received.push(env); });

            peerPair.peerWs.send('not json {{{');

            await new Promise(r => setTimeout(r, 200));

            expect(received).to.have.lengthOf(0);
        });

        it('drops messages missing required fields', async function () {
            let db = testDb.getDb();
            peerPair = await createPeerPair(db);

            let received = [];
            peerPair.pm.on('message', (env) => { received.push(env); });

            // Missing type
            peerPair.peerWs.send(JSON.stringify({ id: 'test', sender: 'ws://x:1', timestamp: Date.now(), data: {} }));
            // Missing id
            peerPair.peerWs.send(JSON.stringify({ type: 'TEST', sender: 'ws://x:1', timestamp: Date.now(), data: {} }));
            // Missing sender
            peerPair.peerWs.send(JSON.stringify({ type: 'TEST', id: 'test2', timestamp: Date.now(), data: {} }));

            await new Promise(r => setTimeout(r, 200));

            expect(received).to.have.lengthOf(0);
        });
    });

    // SC-9.2: Message deduplication
    describe('SC-9.2: Deduplication', function () {
        it('processes message with same ID only once', async function () {
            let db = testDb.getDb();
            peerPair = await createPeerPair(db);

            let received = [];
            peerPair.pm.on('message', (env) => { received.push(env); });

            // Send the same envelope twice (same ID)
            let env = buildEnvelope('TEST_MSG', { value: 1 }, 'ws://dedup-peer:10001');
            sendEnvelope(peerPair.peerWs, env);
            sendEnvelope(peerPair.peerWs, env);

            await new Promise(r => setTimeout(r, 200));

            expect(received).to.have.lengthOf(1);
        });

        it('processes messages with different IDs from same sender', async function () {
            let db = testDb.getDb();
            peerPair = await createPeerPair(db);

            let received = [];
            peerPair.pm.on('message', (env) => { received.push(env); });

            let env1 = buildEnvelope('TEST_MSG', { value: 1 }, 'ws://same-sender:10001');
            let env2 = buildEnvelope('TEST_MSG', { value: 2 }, 'ws://same-sender:10001');
            sendEnvelope(peerPair.peerWs, env1);
            sendEnvelope(peerPair.peerWs, env2);

            await new Promise(r => setTimeout(r, 200));

            expect(received).to.have.lengthOf(2);
        });
    });

    // SC-9.3: Signature verification
    describe('SC-9.3: Signature verification', function () {
        it('accepts valid signed messages when REQUIRE_SIGNATURES is true', async function () {
            let db = testDb.getDb();

            // Generate keypair for the peer
            let keypair = ValidatorIdentity.generate();
            let peerIdentity = new ValidatorIdentity(keypair.privkeyHex);
            let peerAddr = 'ws://signed-peer:10001';

            // Create PeerManager with signature requirement
            let PeerManager = require('../../../src/PeerManager');
            let pm = new PeerManager({
                P2P_VALIDATOR_ADDR:     'ws://hub-sig:10001',
                P2P_PORT:               0,
                P2P_HOST:               '127.0.0.1',
                REQUIRE_SIGNATURES:     true,
                P2P_HEARTBEAT_INTERVAL: 600000,
                P2P_RECONNECT_BASE:     60000,
                P2P_MSG_DEDUP_TTL:      60000
            }, db);

            // Register the peer's pubkey
            let pubkeyMap = new Map();
            pubkeyMap.set(peerAddr, keypair.pubkeyHex);
            pm.setValidatorPubkeys(pubkeyMap);

            await pm.start();
            let port = pm.httpServer.address().port;

            let ws = new WebSocket('ws://127.0.0.1:' + port);
            await new Promise((resolve, reject) => {
                ws.on('open', resolve);
                ws.on('error', reject);
            });

            let received = [];
            pm.on('message', (env) => { received.push(env); });

            // Send a properly signed message
            let env = {
                type:      'SIGNED_TEST',
                id:        'sig-test:' + Date.now(),
                sender:    peerAddr,
                timestamp: Date.now(),
                data:      { hello: 'world' }
            };
            env.sig = peerIdentity.signEnvelope(env);
            ws.send(JSON.stringify(env));

            await new Promise(r => setTimeout(r, 200));
            expect(received).to.have.lengthOf(1);

            // Send a message with invalid signature
            let badEnv = {
                type:      'BAD_SIG_TEST',
                id:        'bad-sig:' + Date.now(),
                sender:    peerAddr,
                timestamp: Date.now(),
                data:      { hello: 'tampered' },
                sig:       'ff'.repeat(64)
            };
            ws.send(JSON.stringify(badEnv));

            await new Promise(r => setTimeout(r, 200));
            // Should still only have the one valid message
            expect(received).to.have.lengthOf(1);

            ws.close();
            await pm.stop();
        });

        it('rejects unsigned messages when REQUIRE_SIGNATURES is true', async function () {
            let db = testDb.getDb();

            let PeerManager = require('../../../src/PeerManager');
            let pm = new PeerManager({
                P2P_VALIDATOR_ADDR:     'ws://hub-sig2:10001',
                P2P_PORT:               0,
                P2P_HOST:               '127.0.0.1',
                REQUIRE_SIGNATURES:     true,
                P2P_HEARTBEAT_INTERVAL: 600000,
                P2P_RECONNECT_BASE:     60000,
                P2P_MSG_DEDUP_TTL:      60000
            }, db);

            // Register pubkeys
            let pubkeyMap = new Map();
            pubkeyMap.set('ws://unsigned-peer:10001', 'cc'.repeat(32));
            pm.setValidatorPubkeys(pubkeyMap);

            await pm.start();
            let port = pm.httpServer.address().port;

            let ws = new WebSocket('ws://127.0.0.1:' + port);
            await new Promise((resolve, reject) => {
                ws.on('open', resolve);
                ws.on('error', reject);
            });

            let received = [];
            pm.on('message', (env) => { received.push(env); });

            // Send unsigned message
            let env = buildEnvelope('UNSIGNED_TEST', { data: true }, 'ws://unsigned-peer:10001');
            ws.send(JSON.stringify(env));

            await new Promise(r => setTimeout(r, 200));
            expect(received).to.have.lengthOf(0);

            ws.close();
            await pm.stop();
        });
    });
});
