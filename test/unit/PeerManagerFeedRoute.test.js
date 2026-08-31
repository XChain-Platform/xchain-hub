'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// The read-only mirror feed shares the PUBLIC P2P port with validator gossip, so
// an indexer can mirror from the validators themselves (a validator exposes one
// public port per network and its JSON-RPC API port is private to the box). The
// guard these tests hold is the separation: exactly two request shapes reach the
// feed, everything else on the port is gossip or 404, and a feed client never
// becomes a gossip peer (which is what would let it be relayed to or counted).

const http               = require('http');
const sinon              = require('sinon');
const { expect }         = require('chai');
const WebSocket          = require('ws');
const PeerManager        = require('../../src/PeerManager');

function get(port, path) {
    return new Promise((resolve, reject) => {
        let req = http.request({ host: '127.0.0.1', port: port, path: path, method: 'GET' }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: body }));
        });
        req.on('error', reject);
        req.end();
    });
}

function request(port, method, path) {
    return new Promise((resolve, reject) => {
        let req = http.request({ host: '127.0.0.1', port: port, path: path, method: method }, (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode }));
        });
        req.on('error', reject);
        req.end();
    });
}

describe('PeerManager: read-only mirror feed on the P2P port', function () {
    let pm, dbStub, port;

    beforeEach(async function () {
        dbStub = { doQuery: sinon.stub().resolves([]) };
        pm = new PeerManager({
            P2P_VALIDATOR_ADDR: 'ws://self:10002',
            P2P_PORT: 0,
            P2P_HOST: '127.0.0.1',
            SEED_NODES: [],
            REQUIRE_SIGNATURES: false,
            P2P_HEARTBEAT_INTERVAL: 3600000,
            P2P_WS_PING_INTERVAL: 3600000,
            P2P_DEDUP_PRUNE_INTERVAL: 3600000
        }, dbStub);
        await pm.start();
        port = pm.httpServer.address().port;
    });

    afterEach(async function () {
        await pm.stop();
        sinon.restore();
    });

    it('serves a mirror-snapshot GET through the wired handler', async function () {
        let handler = sinon.spy((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ table: 'capability_snapshots', rows: [] }));
        });
        pm.setFeedHandlers(handler, () => {});
        let res = await get(port, '/hub-db/snapshot/capability_snapshots?since_id=0');
        expect(res.status).to.equal(200);
        expect(JSON.parse(res.body).table).to.equal('capability_snapshots');
        expect(handler.calledOnce).to.be.true;
    });

    it('404s every other path and never hands it to the feed handler', async function () {
        let handler = sinon.spy((req, res) => { res.writeHead(200); res.end('{}'); });
        pm.setFeedHandlers(handler, () => {});
        for (let path of ['/', '/health', '/hub-db', '/hub-db/snapshots', '/hub-db/snapshotx']) {
            let res = await get(port, path);
            expect(res.status, path).to.equal(404);
        }
        expect(handler.called).to.be.false;
    });

    it('404s a NON-GET to the snapshot path (the write methods stay off this port)', async function () {
        let handler = sinon.spy((req, res) => { res.writeHead(200); res.end('{}'); });
        pm.setFeedHandlers(handler, () => {});
        for (let method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
            let res = await request(port, method, '/hub-db/snapshot/capability_snapshots');
            expect(res.status, method).to.equal(404);
        }
        expect(handler.called).to.be.false;
    });

    // The JSON-RPC endpoint is the second feed shape: an indexer reports what
    // landed on its chain. WHICH methods are allowed is enforced in api.js off the
    // stamp asserted here (see feedRpcAllowlist.test.js), because the method name
    // is in a body this layer has not read.
    it('delegates a POST to the rpc root and stamps it as public-port traffic', async function () {
        let seen = null;
        pm.setFeedHandlers((req, res) => {
            seen = { url: req.url, method: req.method, stamped: req.xchainFeedOrigin === true };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"jsonrpc":"2.0","result":{}}');
        }, () => {});
        let res = await request(port, 'POST', '/');
        expect(res.status).to.equal(200);
        expect(seen).to.deep.equal({ url: '/', method: 'POST', stamped: true });
    });

    it('stamps a snapshot GET too, so the allowlist sees every public-port request', async function () {
        let stamped = null;
        pm.setFeedHandlers((req, res) => {
            stamped = req.xchainFeedOrigin === true;
            res.writeHead(200); res.end('{}');
        }, () => {});
        await get(port, '/hub-db/snapshot/capability_snapshots');
        expect(stamped).to.be.true;
    });

    it('404s a POST to any path other than the rpc root', async function () {
        let handler = sinon.spy((req, res) => { res.writeHead(200); res.end('{}'); });
        pm.setFeedHandlers(handler, () => {});
        for (let path of ['/admin', '/hub-db', '/health', '/rpc']) {
            let res = await request(port, 'POST', path);
            expect(res.status, path).to.equal(404);
        }
        expect(handler.called).to.be.false;
    });

    it('404s the rpc root when no feed is wired', async function () {
        let res = await request(port, 'POST', '/');
        expect(res.status).to.equal(404);
    });

    it('404s the feed path when no feed is wired (gossip-only hub)', async function () {
        let res = await get(port, '/hub-db/snapshot/capability_snapshots');
        expect(res.status).to.equal(404);
    });

    it('routes a /hub-db/subscribe upgrade to the feed, NOT to the gossip server', async function () {
        let upgraded = null;
        pm.setFeedHandlers((req, res) => { res.writeHead(404); res.end(); }, (req, socket, head) => {
            upgraded = req.url;
            socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        });
        let gossip = sinon.spy();
        pm.wss.on('connection', gossip);

        let ws = new WebSocket('ws://127.0.0.1:' + port + '/hub-db/subscribe');
        await new Promise((resolve) => { ws.on('error', resolve); ws.on('close', resolve); ws.on('open', resolve); });
        try { ws.close(); } catch (e) { /* ignore */ }

        expect(upgraded).to.match(/^\/hub-db\/subscribe/);
        expect(gossip.called, 'feed client must never enter the gossip server').to.be.false;
        expect(pm.peers.has('ws://self:10002')).to.be.false;
    });

    it('a feed client is never added to the peer map, so it cannot be broadcast or relayed to', async function () {
        let sockets = [];
        pm.setFeedHandlers((req, res) => { res.writeHead(404); res.end(); }, (req, socket, head) => {
            sockets.push(socket);
            socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        });
        let ws = new WebSocket('ws://127.0.0.1:' + port + '/hub-db/subscribe');
        await new Promise((resolve) => { ws.on('error', resolve); ws.on('close', resolve); ws.on('open', resolve); });
        try { ws.close(); } catch (e) { /* ignore */ }

        expect(sockets.length).to.equal(1);
        expect(pm.peers.size, 'no peer entry for a feed client').to.equal(0);
        // broadcast() walks this.peers, so an absent entry is the proof it receives nothing.
        expect(pm.broadcast('HEARTBEAT', { version: '0.0.0' })).to.be.an('object');
        expect(pm.peers.size).to.equal(0);
    });

    it('destroys a subscribe upgrade when the feed is not wired, leaving gossip untouched', async function () {
        let gossip = sinon.spy();
        pm.wss.on('connection', gossip);
        let ws = new WebSocket('ws://127.0.0.1:' + port + '/hub-db/subscribe');
        await new Promise((resolve) => { ws.on('error', resolve); ws.on('close', resolve); ws.on('open', resolve); });
        try { ws.close(); } catch (e) { /* ignore */ }
        expect(gossip.called).to.be.false;
    });

    it('still accepts a normal gossip upgrade, and the feed handler never sees it', async function () {
        let feedUpgrade = sinon.spy();
        pm.setFeedHandlers((req, res) => { res.writeHead(404); res.end(); }, feedUpgrade);
        let connected = new Promise((resolve) => pm.wss.once('connection', () => resolve(true)));
        let ws = new WebSocket('ws://127.0.0.1:' + port + '/');
        await new Promise((resolve) => { ws.on('open', resolve); ws.on('error', resolve); });
        expect(await connected).to.be.true;
        expect(feedUpgrade.called).to.be.false;
        try { ws.close(); } catch (e) { /* ignore */ }
    });
});
