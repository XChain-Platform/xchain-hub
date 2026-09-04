'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// Public-port method allowlist. The read-only mirror feed shares the PUBLIC P2P
// port (PeerManager.setFeedHandlers), and an indexer must also report what landed
// on its chain, so a small set of push methods is reachable there. The guard these
// tests hold is that the set is EXACTLY those pushes: a request stamped as arriving
// on the public port may call nothing else, while the private API port keeps its
// full surface. The x-api-key tiers are unchanged and tested in
// sensitiveReadAuth.test.js; this file is only about which methods that port
// considers at all.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();
const { waitUntil } = require('../helpers/waitUntil');

// The complete indexer->hub vocabulary (xchain-indexer src/hub_client.js).
const FEED_METHODS = [
    'pushchaintip', 'pushpriceround', 'pushpricebatch', 'pushattestbatch', 'pushoracleprice',
    'pushpricereorg', 'pushxcallreorg', 'pushdexreorg'
];

// A deliberately broad sample of what must NOT be reachable from a public port:
// config and validator administration, governance, slashing, swaps, the anchor and
// effector rails, a sensitive read, and ordinary reads.
const REFUSED_METHODS = [
    'updateconfig', 'registervalidator', 'rotatevalidator', 'deregistervalidator',
    'syncvalidators', 'propose', 'proposeslashpenalty', 'vote', 'requestattestation',
    'reportreorg', 'initiateswap', 'anchorflush', 'pauseeffectorspend',
    'resumeeffectorspend', 'getallconfigs', 'getvalidators', 'ping'
];

async function bootApi() {
    const useCalls = [];
    const mockApp = {
        use:  sinon.stub().callsFake((fn) => { useCalls.push(fn); }),
        get:  sinon.stub(),
        post: sinon.stub(),
        set:  sinon.stub(),
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); })
    };
    const mockServer = {
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); }),
        on: sinon.stub(),
        emit: sinon.stub()
    };
    const mockExpress = sinon.stub().returns(mockApp);
    mockExpress.json = sinon.stub().returns(function expressJson() {});

    const mockHub = new Proxy({}, {
        get: (target, prop) => {
            if (!(prop in target)) target[prop] = sinon.stub().callsFake(async () => ({}));
            return target[prop];
        }
    });

    const saved = {};
    for (const k of ['HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_SENSITIVE_READ_AUTH', 'HUB_ALLOW_UNAUTHENTICATED',
                     'HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS',
                     'HUB_PORT', 'P2P_VALIDATOR_ADDR']) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    Object.assign(process.env, {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
        HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9999', HUB_API_KEY: 'test-hub-key'
    });

    try {
        proxyquire('../../src/api', {
            'dotenv': { config: sinon.stub() },
            'express': mockExpress,
            'helmet': sinon.stub().returns(function helmetMw() {}),
            'cors': sinon.stub().returns(function corsMw() {}),
            'express-rate-limit': sinon.stub().returns(function rateLimitMw() {}),
            'express-json-rpc-router': () => function routerMw() {},
            'http': { createServer: sinon.stub().returns(mockServer) },
            'ws': { Server: sinon.stub().returns({ on: sinon.stub() }) },
            'geoip-lite': { lookup: sinon.stub().returns(null) },
            './XChainHub': function () { return mockHub; }
        });
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
    await waitUntil(() => mockServer.listen.called, { label: 'api.js boot to reach server.listen' });

    function drive(mw, opts) {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        const body = Array.isArray(opts.method)
            ? opts.method.map((m, i) => ({ method: m, id: i + 1 }))
            : (opts.method === undefined ? {} : { method: opts.method, id: 1 });
        const req = {
            body: body,
            headers: { 'x-api-key': 'test-hub-key' },
            method: opts.httpMethod || 'POST'
        };
        if (opts.feed) req.xchainFeedOrigin = true;
        let nexted = false;
        mw(req, res, () => { nexted = true; });
        return { nexted, res };
    }

    // Identify the allowlist middleware behaviourally: it refuses a stamped
    // administrative method with -32601 and passes the same call unstamped.
    const candidates = useCalls.filter((fn) => typeof fn === 'function' && fn.length >= 3);
    let mw = null;
    for (const fn of candidates) {
        try {
            const stamped   = drive(fn, { method: 'updateconfig', feed: true });
            const unstamped = drive(fn, { method: 'updateconfig' });
            if (!stamped.nexted && stamped.res.statusCode === 404 && unstamped.nexted) { mw = fn; break; }
        } catch (_) { /* not this middleware */ }
    }
    expect(mw, 'feed allowlist middleware not found among app.use() calls').to.not.equal(null);
    return { drive: (opts) => drive(mw, opts) };
}

describe('hub public-port rpc allowlist (P2P feed)', function () {
    let api;

    before(async function () { api = await bootApi(); });
    afterEach(function () { sinon.restore(); });

    it('admits every indexer push method on the public port', function () {
        for (const m of FEED_METHODS) {
            expect(api.drive({ method: m, feed: true }).nexted, m).to.equal(true);
        }
    });

    it('refuses every other method on the public port with -32601', function () {
        for (const m of REFUSED_METHODS) {
            const { nexted, res } = api.drive({ method: m, feed: true });
            expect(nexted, m).to.equal(false);
            expect(res.statusCode, m).to.equal(404);
            expect(res.body.error.code, m).to.equal(-32601);
        }
    });

    it('leaves the private API port unrestricted (no stamp, no allowlist)', function () {
        for (const m of REFUSED_METHODS.concat(FEED_METHODS)) {
            expect(api.drive({ method: m }).nexted, m).to.equal(true);
        }
    });

    it('admits a batch of only push methods', function () {
        expect(api.drive({ method: ['pushpricebatch', 'pushchaintip'], feed: true }).nexted).to.equal(true);
    });

    it('refuses a batch that smuggles one refused method in beside pushes', function () {
        const { nexted, res } = api.drive({ method: ['pushpricebatch', 'updateconfig'], feed: true });
        expect(nexted).to.equal(false);
        expect(res.statusCode).to.equal(404);
    });

    it('refuses a bodyless or methodless POST on the public port', function () {
        for (const body of [{ method: undefined }, { method: null }]) {
            const { nexted, res } = api.drive({ method: body.method, feed: true });
            expect(nexted).to.equal(false);
            expect(res.statusCode).to.equal(404);
        }
    });

    it('refuses an empty batch on the public port', function () {
        const { nexted, res } = api.drive({ method: [], feed: true });
        expect(nexted).to.equal(false);
        expect(res.statusCode).to.equal(404);
    });

    it('matches the method case-insensitively, as the auth tiers do', function () {
        expect(api.drive({ method: 'PushPriceBatch', feed: true }).nexted).to.equal(true);
        expect(api.drive({ method: 'UpdateConfig', feed: true }).nexted).to.equal(false);
    });

    it('passes a stamped GET through (snapshot reads are scoped by path, not method)', function () {
        expect(api.drive({ method: undefined, feed: true, httpMethod: 'GET' }).nexted).to.equal(true);
    });
});
