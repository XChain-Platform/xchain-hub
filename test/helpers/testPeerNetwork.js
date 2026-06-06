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

const WebSocket   = require('ws');
const PeerManager = require('../../src/PeerManager');

/**
 * Build a valid P2P envelope for message injection.
 * Used by consensus tests to simulate peer messages via peerManager.emit('message', env).
 */
function buildEnvelope(type, data, senderAddr) {
    return {
        type:      type,
        id:        'test:' + Date.now() + ':' + Math.random().toString(16).slice(2, 10),
        sender:    senderAddr || 'ws://peer:10001',
        timestamp: Date.now(),
        data:      data || {}
    };
}

/**
 * Create a PeerManager server on a random port and a raw WS client connected to it.
 * Used only by P2P routing tests (SC-9.x) that need real WebSocket transport.
 */
async function createPeerPair(db) {
    let pm = new PeerManager({
        P2P_VALIDATOR_ADDR:     'ws://hub:10001',
        P2P_PORT:               0,
        P2P_HOST:               '127.0.0.1',
        REQUIRE_SIGNATURES:     false,
        P2P_HEARTBEAT_INTERVAL: 600000,
        P2P_RECONNECT_BASE:     60000,
        P2P_MSG_DEDUP_TTL:      60000
    }, db);

    await pm.start();

    let port = pm.httpServer.address().port;
    let peerWs = new WebSocket('ws://127.0.0.1:' + port);

    await new Promise((resolve, reject) => {
        peerWs.on('open', resolve);
        peerWs.on('error', reject);
    });

    return { pm, peerWs, port };
}

/**
 * Send a JSON envelope over a raw WebSocket.
 */
function sendEnvelope(ws, envelope) {
    ws.send(JSON.stringify(envelope));
}

/**
 * Wait for a specific event on an EventEmitter, with timeout.
 */
function waitForEvent(emitter, eventName, timeoutMs) {
    return new Promise((resolve, reject) => {
        let timer = setTimeout(() => reject(new Error('Timeout waiting for ' + eventName)), timeoutMs || 5000);
        emitter.once(eventName, (data) => {
            clearTimeout(timer);
            resolve(data);
        });
    });
}

module.exports = { buildEnvelope, createPeerPair, sendEnvelope, waitForEvent };
