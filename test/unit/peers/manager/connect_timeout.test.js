/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************/

'use strict';

const EventEmitter = require('events');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const sinon = require('sinon');

let latestSocket;

class StubWebSocket extends EventEmitter {
    constructor(url, options) {
        super();
        this.url = url;
        this.options = options;
        latestSocket = this;
    }
}

StubWebSocket.OPEN = 1;
StubWebSocket.Server = class {};

const PeerConnections = proxyquire('../../../../src/peers/gossip/connections.js', {
    ws: StubWebSocket
});

describe('outbound peer connection timeout', function () {
    it('bounds the opening handshake and reconnects after the socket closes', function () {
        const pm = {
            config: { P2P_MAX_PAYLOAD: 4096 },
            peers: new Map(),
            scheduleReconnect: sinon.spy(),
            handleInbound: sinon.spy(),
            sendToPeer: sinon.spy(),
            emit: sinon.spy()
        };

        PeerConnections.prototype.connectToPeer.call(pm, 'peer.example:10001');

        expect(latestSocket.options).to.deep.equal({
            maxPayload: 4096,
            handshakeTimeout: 10000
        });
        latestSocket.emit('error', new Error('Opening handshake has timed out'));
        latestSocket.emit('close', 1006, Buffer.alloc(0));

        const peer = pm.peers.get('peer.example:10001');
        expect(peer.state).to.equal('closed');
        expect(peer.lastError).to.equal('Opening handshake has timed out');
        expect(pm.scheduleReconnect.calledOnceWithExactly('peer.example:10001')).to.equal(true);
    });
});
