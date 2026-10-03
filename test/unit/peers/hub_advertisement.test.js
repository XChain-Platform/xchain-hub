'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const WebSocket = require('ws');
const PeerManager = require('../../../src/peers/manager');
const ValidatorIdentity = require('../../../src/validators/identity');

function makeHub(addr, publicUrl) {
    const config = {
        P2P_VALIDATOR_ADDR: addr,
        REQUIRE_SIGNATURES: true
    };
    if (publicUrl !== undefined && publicUrl !== null) config.HUB_PUBLIC_API_URL = publicUrl;
    const manager = new PeerManager(config, null);
    const keys = ValidatorIdentity.generate();
    const identity = new ValidatorIdentity(keys.privkeyHex);
    manager.setIdentity(identity);
    return { manager, identity, pubkey: keys.pubkeyHex.toLowerCase() };
}

function connectReceiver(receiver, sender) {
    const ws = { _peerAddr: sender.manager.validatorAddr, _remoteIp: '127.0.0.2' };
    receiver.manager.peers.set(sender.manager.validatorAddr, {
        ws: { readyState: WebSocket.OPEN }, state: 'open', lastSeen: null, inbound: false
    });
    receiver.manager.setValidatorPubkeys(new Map([
        [sender.manager.validatorAddr, sender.pubkey]
    ]));
    receiver.manager.setEffectiveSignerSet(new Set([receiver.pubkey, sender.pubkey]));
    return ws;
}

function deliverHeartbeat(sender, receiver, ws, data) {
    const envelope = sender.manager.buildEnvelope('HEARTBEAT',
        data === undefined ? sender.manager.heartbeatData('test') : data);
    receiver.manager.handleInbound(ws, JSON.stringify(envelope), sender.manager.validatorAddr);
}

describe('hub API address advertisement', function () {
    it('round-trips an address between two hubs over a signed peer heartbeat', function () {
        const a = makeHub('ws://hub-a.example:10002', 'https://api-a.example:10002/rpc/');
        const b = makeHub('ws://hub-b.example:10002', 'https://api-b.example:10002/');
        const ws = connectReceiver(b, a);

        deliverHeartbeat(a, b, ws);

        expect(b.manager.getHubAdvertisements()).to.deep.equal([
            { api_url: 'https://api-b.example:10002', signing_pubkey: b.pubkey },
            { api_url: 'https://api-a.example:10002/rpc/', signing_pubkey: a.pubkey }
        ]);
    });

    it('does not default the public API URL from the validator signing address', function () {
        const hub = makeHub('wss://validator.example:10002');
        expect(hub.manager.heartbeatData('test')).to.not.have.property('api_url');
        expect(hub.manager.getHubAdvertisements()).to.deep.equal([]);
    });

    it('omits a peer that advertises no address', function () {
        const a = makeHub('ws://hub-a.example:10002', null);
        const b = makeHub('ws://hub-b.example:10002', 'http://hub-b.example:10002');
        const ws = connectReceiver(b, a);

        deliverHeartbeat(a, b, ws);

        expect(b.manager.getHubAdvertisements()).to.deep.equal([
            { api_url: 'http://hub-b.example:10002', signing_pubkey: b.pubkey }
        ]);
    });

    it('refuses malformed configured and peer-advertised addresses', function () {
        expect(() => makeHub('ws://hub-a.example:10002', 'javascript:alert(1)'))
            .to.throw('HUB_PUBLIC_API_URL must be an http(s) URL');

        const a = makeHub('ws://hub-a.example:10002', 'http://hub-a.example:10002');
        const b = makeHub('ws://hub-b.example:10002', 'http://hub-b.example:10002');
        const ws = connectReceiver(b, a);
        const data = a.manager.heartbeatData('test');
        data.api_url = 'not a URL';
        deliverHeartbeat(a, b, ws, data);

        expect(b.manager.getHubAdvertisements().map(h => h.api_url))
            .to.deep.equal(['http://hub-b.example:10002']);
    });

    it('omits disconnected peers and peers outside the effective signer set', function () {
        const a = makeHub('ws://hub-a.example:10002', 'http://hub-a.example:10002');
        const b = makeHub('ws://hub-b.example:10002', 'http://hub-b.example:10002');
        const ws = connectReceiver(b, a);
        deliverHeartbeat(a, b, ws);

        b.manager.setEffectiveSignerSet(new Set([b.pubkey]));
        expect(b.manager.getHubAdvertisements()).to.have.length(1);
        b.manager.setEffectiveSignerSet(new Set([b.pubkey, a.pubkey]));
        b.manager.peers.get(a.manager.validatorAddr).state = 'closed';
        expect(b.manager.getHubAdvertisements()).to.have.length(1);
    });
});
