'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const { authGate, feedPortAllowlist } = require('../../../src/api/auth_gate.js');
const { mountSnapshotAuth } = require('../../../src/api/rest/hub_db_snapshot.js');
const { upgradeHandler, serveFeedOnP2pPort } = require('../../../src/api/server.js');

const BULK_KEY = 'bulk-key';
const FEED_KEY = 'feed-key';
const REORG_KEY = 'reorg-key';

const FORWARD_PUSHES = [
    'pushchaintip', 'pushpriceround', 'pushpricebatch', 'pushattestbatch', 'pushoracleprice'
];
const REORG_PUSHES = [
    'pushpricereorg', 'pushxcallreorg', 'pushdexreorg', 'pushbridgereorg', 'retractattestbatch'
];
const CONFIG_READS = ['getallconfigs', 'getrollcallstatus'];

function authContext(overrides) {
    return Object.assign({
        HUB_API_KEY: BULK_KEY,
        HUB_FEED_API_KEY: FEED_KEY,
        HUB_REORG_API_KEY: REORG_KEY,
        HUB_CONFIG_SECRETS_API_KEY: '',
        WRITE_METHODS: new Set(FORWARD_PUSHES.concat(REORG_PUSHES)),
        REORG_WRITE_METHODS: new Set(REORG_PUSHES),
        SENSITIVE_READ_METHODS: new Set(CONFIG_READS),
        SENSITIVE_READ_AUTH: true
    }, overrides || {});
}

function driveAuth(ctx, methods, key) {
    const body = Array.isArray(methods)
        ? methods.map((method, id) => ({ method, id }))
        : { method: methods, id: 1 };
    const req = { body, headers: key ? { 'x-api-key': key } : {} };
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; }
    };
    let nexted = false;
    authGate(ctx)(req, res, () => { nexted = true; });
    return { nexted, res };
}

function snapshotMiddleware(ctx) {
    let middleware;
    mountSnapshotAuth({ use(path, fn) { expect(path).to.equal('/hub-db/snapshot'); middleware = fn; } }, ctx);
    return middleware;
}

function driveSnapshot(ctx, key) {
    const req = { headers: key ? { 'x-api-key': key } : {} };
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; }
    };
    let nexted = false;
    snapshotMiddleware(ctx)(req, res, () => { nexted = true; });
    return { nexted, res };
}

function driveUpgrade(ctx, key) {
    const wss = { handleUpgrade: sinon.spy() };
    const socket = { write: sinon.spy(), destroy: sinon.spy() };
    const request = {
        url: '/hub-db/subscribe',
        headers: key ? { authorization: 'Bearer ' + key } : {}
    };
    upgradeHandler(wss, Object.assign({ hub: {}, logger: {} }, ctx))(request, socket, Buffer.alloc(0));
    return { wss, socket };
}

describe('read-only hub feed key tier', function () {
    it('authorizes gethubs with the feed or bulk key only', function () {
        expect(driveAuth(authContext(), 'gethubs', FEED_KEY).nexted).to.equal(true);
        expect(driveAuth(authContext(), 'gethubs', BULK_KEY).nexted).to.equal(true);
        expect(driveAuth(authContext(), 'gethubs', REORG_KEY).res.statusCode).to.equal(401);
        expect(driveAuth(authContext(), 'gethubs').res.statusCode).to.equal(401);
    });

    it('does not authorize any push with the feed key', function () {
        for (const method of FORWARD_PUSHES.concat(REORG_PUSHES)) {
            expect(driveAuth(authContext(), method, FEED_KEY).res.statusCode, method).to.equal(401);
        }
    });

    it('does not authorize config reads with the feed key', function () {
        for (const method of CONFIG_READS) {
            expect(driveAuth(authContext(), method, FEED_KEY).res.statusCode, method).to.equal(401);
        }
    });

    it('requires the bulk key for a batch mixing gethubs with a push', function () {
        expect(driveAuth(authContext(), ['gethubs', 'pushchaintip'], FEED_KEY).res.statusCode).to.equal(401);
        expect(driveAuth(authContext(), ['gethubs', 'pushchaintip'], BULK_KEY).nexted).to.equal(true);
    });

    it('keeps gethubs bulk-keyed when the feed key is unset', function () {
        const ctx = authContext({ HUB_FEED_API_KEY: '' });
        expect(driveAuth(ctx, 'gethubs', BULK_KEY).nexted).to.equal(true);
        expect(driveAuth(ctx, 'gethubs').res.statusCode).to.equal(401);
    });

    it('authorizes snapshots with the feed or bulk key only', function () {
        const ctx = authContext();
        expect(driveSnapshot(ctx, FEED_KEY).nexted).to.equal(true);
        expect(driveSnapshot(ctx, BULK_KEY).nexted).to.equal(true);
        expect(driveSnapshot(ctx, REORG_KEY).res.statusCode).to.equal(401);
        expect(driveSnapshot(ctx).res.statusCode).to.equal(401);
    });

    it('keeps snapshots bulk-keyed when the feed key is unset', function () {
        const ctx = authContext({ HUB_FEED_API_KEY: '' });
        expect(driveSnapshot(ctx, BULK_KEY).nexted).to.equal(true);
        expect(driveSnapshot(ctx, FEED_KEY).res.statusCode).to.equal(401);
    });

    it('authorizes WebSocket subscribe with the feed or bulk bearer only', function () {
        for (const key of [FEED_KEY, BULK_KEY]) {
            const accepted = driveUpgrade(authContext(), key);
            expect(accepted.wss.handleUpgrade.calledOnce, key).to.equal(true);
            expect(accepted.socket.destroy.called, key).to.equal(false);
        }
        for (const key of [REORG_KEY, undefined]) {
            const refused = driveUpgrade(authContext(), key);
            expect(refused.wss.handleUpgrade.called, String(key)).to.equal(false);
            expect(refused.socket.destroy.calledOnce, String(key)).to.equal(true);
        }
    });

    it('keeps WebSocket subscribe bulk-keyed when the feed key is unset', function () {
        const ctx = authContext({ HUB_FEED_API_KEY: '' });
        expect(driveUpgrade(ctx, BULK_KEY).wss.handleUpgrade.calledOnce).to.equal(true);
        expect(driveUpgrade(ctx, FEED_KEY).socket.destroy.calledOnce).to.equal(true);
    });

    it('serves the peer-port feed when a feed key is configured without a bulk key', function () {
        const setFeedHandlers = sinon.spy();
        const logger = { info: sinon.spy(), warn: sinon.spy() };
        serveFeedOnP2pPort({}, { emit() {} }, {
            hub: { peerManager: { setFeedHandlers }, p2pConfig: {} },
            hubConfig: {}, logger, HUB_API_KEY: '', HUB_FEED_API_KEY: FEED_KEY
        });
        expect(setFeedHandlers.calledOnce).to.equal(true);
        expect(logger.warn.called).to.equal(false);
    });

    it('admits gethubs and refuses config reads on the peer-port allowlist', function () {
        const middleware = feedPortAllowlist();
        const drive = (method) => {
            const req = { xchainFeedOrigin: true, method: 'POST', body: { method, id: 1 } };
            const res = {
                statusCode: 200,
                status(code) { this.statusCode = code; return this; },
                json(value) { this.body = value; return this; }
            };
            let nexted = false;
            middleware(req, res, () => { nexted = true; });
            return { nexted, res };
        };
        expect(drive('gethubs').nexted).to.equal(true);
        expect(drive('getallconfigs').res.statusCode).to.equal(404);
    });
});
