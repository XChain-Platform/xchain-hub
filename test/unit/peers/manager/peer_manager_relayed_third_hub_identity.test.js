'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins inbound peer identity for relayed gossip: when hub B relays hub A's signed
// envelope to hub C, C binds the socket to B (the authenticated connecting hub),
// never to A (the envelope's origin), and still delivers the message as A's.

const assert = require('node:assert/strict');
const WebSocket = require('ws');
const PeerManager = require('../../../../src/peers/manager.js');
const ValidatorIdentity = require('../../../../src/validators/identity.js');

describe('peer manager relayed third hub identity', () => {
    it('a relayed third hub message names the authenticated connecting hub', () => {
        const addresses = ['hub-a', 'hub-b', 'hub-c'];
        const identities = addresses.map(() => new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex));
        const pubkeys = new Map(addresses.map((address, index) => [address, identities[index].getPubkeyHex()]));
        const manager = index => {
            const instance = new PeerManager({ P2P_VALIDATOR_ADDR: addresses[index], P2P_PORT: 0,
                P2P_HOST: '127.0.0.1', SEED_NODES: [], REQUIRE_SIGNATURES: true,
                P2P_MSG_DEDUP_TTL: 60000 }, null);
            instance.setIdentity(identities[index]);
            instance.setValidatorPubkeys(pubkeys);
            return instance;
        };
        const origin = manager(0);
        const connecting = manager(1);
        const receiving = manager(2);
        let relayedFrame;
        const outboundWs = { readyState: WebSocket.OPEN, send(frame, callback) {
            relayedFrame = frame;
            if (callback) callback();
        } };
        connecting.peers.set(addresses[2],
            { inbound: false, validatorAddr: addresses[2], ws: outboundWs });
        connecting.relay(origin.buildEnvelope('THIRD_HUB_MESSAGE', { value: 1 }), null);

        const inboundWs = { _peerAddr: null, _remoteIp: '127.0.0.2',
            readyState: WebSocket.OPEN, close() {} };
        const delivered = [];
        receiving.on('message', envelope => delivered.push(envelope));
        receiving.handleInbound(inboundWs, relayedFrame, null);

        assert.equal(inboundWs._peerAddr, addresses[1]);
        assert.equal(receiving.peers.get(addresses[1]).ws, inboundWs);
        assert.equal(receiving.peers.has(addresses[0]), false);
        assert.equal(delivered.length, 1);
        assert.equal(delivered[0].sender, addresses[0]);
    });
});
