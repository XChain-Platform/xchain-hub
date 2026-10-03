'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const http = require('http');
const net = require('net');
const rateLimit = require('express-rate-limit');
const { buildHubsRpc } = require('../../../../src/api/rpc/hubs.js');
const { authGate } = require('../../../../src/api/auth_gate.js');
const { createApp } = require('../../../../src/api/server.js');
const PeerManager = require('../../../../src/peers/manager.js');

function response() {
    return {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function requestThrough(middleware, key) {
    const req = {
        xchainFeedOrigin: true,
        method: 'POST',
        headers: key ? { 'x-api-key': key } : {},
        body: { jsonrpc: '2.0', id: 1, method: 'gethubs', params: {} }
    };
    const res = response();
    let nexted = false;
    middleware(req, res, () => { nexted = true; });
    return { req, res, nexted };
}

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const port = probe.address().port;
            probe.close(() => resolve(port));
        });
    });
}

function postRpc(port, key) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gethubs', params: {} });
        const req = http.request({
            host: '127.0.0.1', port, path: '/', method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-api-key': key }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

function appContext(hub) {
    const noop = () => {};
    return {
        hub, express, helmet, cors, rateLimit,
        hubConfig: {}, CORS_ORIGIN: false, logger: { info: noop, warn: noop, error: noop },
        HUB_RATE_LIMIT_RPM: 100, HUB_RATE_LIMIT_EXEMPT_LOCAL: true,
        HUB_API_KEY: 'feed-key', HUB_REORG_API_KEY: '', HUB_CONFIG_SECRETS_API_KEY: '',
        REORG_WRITE_METHODS: new Set(), WRITE_METHODS: new Set(),
        SENSITIVE_READ_METHODS: new Set(), SENSITIVE_READ_AUTH: false,
        HUB_NETWORK: 'regtest', TELEMETRY_ENABLED: false, TELEMETRY_ADMIN_KEY: '',
        TELEMETRY_IP_SALT: '', bigIntReplacer: (_, value) => value
    };
}

async function startFeed(hubs) {
    const port = await freePort();
    const manager = new PeerManager({
        P2P_VALIDATOR_ADDR: 'validator-self', P2P_PORT: port, P2P_HOST: '127.0.0.1',
        HUB_NETWORK: 'regtest', SEED_NODES: [], REQUIRE_SIGNATURES: false,
        P2P_HEARTBEAT_INTERVAL: 3600000, P2P_WS_PING_INTERVAL: 3600000,
        P2P_DEDUP_PRUNE_INTERVAL: 3600000
    }, { doQuery: async () => [] });
    manager.getHubAdvertisements = () => hubs;
    const hub = { peerManager: manager, getPeerManager: () => manager };
    const { app } = createApp(appContext(hub));
    manager.setFeedHandlers(app, () => {});
    await manager.start();
    return { manager, port };
}

describe('gethubs feed read', function () {
    const hubs = [{ api_url: 'https://hub.example:10002', signing_pubkey: 'aabb' }];
    const ctx = {
        HUB_API_KEY: 'feed-key',
        HUB_REORG_API_KEY: '',
        HUB_CONFIG_SECRETS_API_KEY: '',
        REORG_WRITE_METHODS: new Set(),
        WRITE_METHODS: new Set(),
        SENSITIVE_READ_METHODS: new Set(),
        SENSITIVE_READ_AUTH: false
    };

    it('answers with self and connected signer-set peer advertisements', function () {
        const methods = buildHubsRpc({
            hub: { getPeerManager: () => ({ getHubAdvertisements: () => hubs }) }
        });
        expect(methods.gethubs()).to.deep.equal({ hubs });
    });

    it('answers through the registered RPC on the feed port', async function () {
        const feed = await startFeed(hubs);
        try {
            const result = await postRpc(feed.port, 'feed-key');
            expect(result.status).to.equal(200);
            expect(result.body).to.deep.include({ jsonrpc: '2.0', id: 1, result: { hubs } });
        } finally {
            await feed.manager.stop();
        }
    });

    it('refuses the read without the feed key even when sensitive-read auth is disabled', function () {
        const denied = requestThrough(authGate(ctx));
        expect(denied.nexted).to.equal(false);
        expect(denied.res.statusCode).to.equal(401);
        expect(denied.res.body.error.code).to.equal(-32001);
    });
});
