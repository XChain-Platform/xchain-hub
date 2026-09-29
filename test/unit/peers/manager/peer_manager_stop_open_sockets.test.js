'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// PeerManager.stop() must not wait on remote peers. httpServer.close() resolves
// only once every connection is gone, and a WebSocket upgrade (a gossip peer or a
// mirror feed subscriber) leaves the HTTP connection list, so neither
// closeAllConnections() nor the peer map reaches it. A remote that does not hang up
// would hold shutdown open until the hub's 10 s forced exit, so stop() destroys
// those sockets itself.

const net         = require('net');
const sinon       = require('sinon');
const { expect }  = require('chai');
const WebSocket   = require('ws');
const { waitUntil } = require('../../../helpers/waitUntil');
const PeerManager = require('../../../../src/peers/manager');

{

    let pm, port;

    async function stopOutcome() {
        let stopped = false;
        pm.stop().then(() => { stopped = true; });
        try {
            await waitUntil(() => stopped, { timeoutMs: 3000, label: 'PeerManager.stop()' });
            return 'stopped';
        } catch (e) {
            return 'hung';
        }
    }

    // P2P_PORT 0 falls back to the default 10001, which another suite may still
    // hold, so pick a free port first.
    function freePort() {
        return new Promise((resolve) => {
            let probe = net.createServer().listen(0, '127.0.0.1', () => {
                let p = probe.address().port;
                probe.close(() => resolve(p));
            });
        });
    }

    async function connect(path) {
        let ws = new WebSocket('ws://127.0.0.1:' + port + path);
        await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
        // A remote that never reads again, so it never answers the close frame.
        ws._socket.pause();
        return ws;
    }

    async function stopResolvesWithASilentGossipPeerTest1() {
        await connect('/');
        expect(await stopOutcome()).to.equal('stopped');
    }

    async function stopResolvesWithAnOpenFeedSubscriberTest2() {
        let feed = new WebSocket.Server({ noServer: true });
        pm.setFeedHandlers((req, res) => { res.writeHead(404); res.end(); },
            (req, socket, head) => feed.handleUpgrade(req, socket, head, () => {}));
        await connect('/hub-db/subscribe');
        expect(await stopOutcome()).to.equal('stopped');
    }

    function peermanagerStopOpenSocketsSuite1() {
        beforeEach(async function () {
            port = await freePort();
            pm = new PeerManager({
                P2P_VALIDATOR_ADDR: 'ws://self:10002',
                P2P_PORT: port,
                P2P_HOST: '127.0.0.1',
                SEED_NODES: [],
                REQUIRE_SIGNATURES: false,
                P2P_HEARTBEAT_INTERVAL: 3600000,
                P2P_WS_PING_INTERVAL: 3600000,
                P2P_DEDUP_PRUNE_INTERVAL: 3600000
            }, { doQuery: sinon.stub().resolves([]) });
            await pm.start();
        });
        afterEach(function () { sinon.restore(); });
        it('stop() resolves while a silent gossip peer is connected', stopResolvesWithASilentGossipPeerTest1);
        it('stop() resolves while a mirror feed subscriber is connected', stopResolvesWithAnOpenFeedSubscriberTest2);
    }

    describe('PeerManager.stop: sockets that never hang up', peermanagerStopOpenSocketsSuite1);

}
