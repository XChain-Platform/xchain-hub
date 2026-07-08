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

// API-key tier enforcement middleware: writes and SENSITIVE_READ_METHODS
// (getallconfigs, which returns DB credentials) require x-api-key when
// HUB_API_KEY is set; the public read tier passes without a key. This is the
// app-side policy that lets the hub.xchain.io vhost IP-allowlist be retired.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();

const KEY = 'test-hub-key';

// Boot src/api.js with everything heavy stubbed out and capture the
// middlewares registered via app.use(); returns a driver that runs a fake
// request through the auth middleware (identified behaviorally: the only
// use() middleware that inspects req.body.method).
async function bootApi(env) {
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
        on: sinon.stub()
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
    for (const k of ['HUB_API_KEY', 'HUB_SENSITIVE_READ_AUTH', 'HUB_DB_HOST', 'HUB_DB_PORT',
                     'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS', 'HUB_PORT', 'P2P_VALIDATOR_ADDR']) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    Object.assign(process.env, {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
        HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9999'
    }, env);

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
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The auth middleware is the app.use() function that 401s an unkeyed
    // write when a key is configured (or, keyless boot, the one that calls
    // next() for a write without touching res). Identify it by probing.
    function drive(mw, methodOrMethods, apiKey) {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        // An array of methods drives a JSON-RPC batch (array body); a string
        // drives a single call (object body).
        const body = Array.isArray(methodOrMethods)
            ? methodOrMethods.map((m, i) => ({ method: m, id: i + 1 }))
            : { method: methodOrMethods, id: 1 };
        let nexted = false;
        mw({ body, headers: apiKey ? { 'x-api-key': apiKey } : {} },
           res, () => { nexted = true; });
        return { nexted, res };
    }
    const candidates = useCalls.filter((fn) => typeof fn === 'function' && fn.length >= 3);
    let authMw = null;
    for (const fn of candidates) {
        try {
            const probe = drive(fn, 'updateconfig', 'wrong-key-probe');
            const open  = drive(fn, 'ping', undefined);
            if (open.nexted && (probe.res.statusCode === 401 || probe.nexted)) { authMw = fn; break; }
        } catch (_) { /* not the auth middleware */ }
    }
    expect(authMw, 'auth middleware not found among app.use() calls').to.not.equal(null);
    return {
        request:      (method, apiKey)  => drive(authMw, method, apiKey),
        requestBatch: (methods, apiKey) => drive(authMw, methods, apiKey)
    };
}

describe('hub API-key tiers (writes + sensitive reads vs public reads)', function () {

    afterEach(function () { sinon.restore(); });

    describe('HUB_API_KEY set (enforcing)', function () {
        let api;
        before(async function () { api = await bootApi({ HUB_API_KEY: KEY }); });

        it('getallconfigs without key is 401 (sensitive read tier)', function () {
            const { nexted, res } = api.request('getallconfigs', undefined);
            expect(nexted).to.equal(false);
            expect(res.statusCode).to.equal(401);
            expect(res.body.error.code).to.equal(-32001);
        });

        it('getallconfigs with the key passes', function () {
            expect(api.request('getallconfigs', KEY).nexted).to.equal(true);
        });

        it('write method without key is still 401 (regression)', function () {
            expect(api.request('pushchaintip', undefined).res.statusCode).to.equal(401);
        });

        it('public reads pass without a key', function () {
            for (const m of ['getproposals', 'getprice', 'getvalidators', 'getvotes', 'getvalidatorcapabilities'])
                expect(api.request(m, undefined).nexted).to.equal(true, m + ' must stay public');
        });

        it('wrong key on a sensitive read is 401', function () {
            expect(api.request('getallconfigs', 'nope').res.statusCode).to.equal(401);
        });

        it('batch with a gated method and no key is 401 (bypass regression)', function () {
            // A JSON-RPC array body must not slip a write past the gate: the
            // pre-fix middleware read req.body.method off the array (undefined)
            // and called next() unauthenticated.
            const { nexted, res } = api.requestBatch(['ping', 'updateconfig'], undefined);
            expect(nexted).to.equal(false);
            expect(res.statusCode).to.equal(401);
        });

        it('batch of a gated method with the key passes', function () {
            expect(api.requestBatch(['ping', 'getallconfigs'], KEY).nexted).to.equal(true);
        });

        it('batch of only public reads passes without a key', function () {
            expect(api.requestBatch(['ping', 'getproposals'], undefined).nexted).to.equal(true);
        });
    });

    describe('HUB_SENSITIVE_READ_AUTH=0 escape hatch', function () {
        it('getallconfigs passes without key; writes stay keyed', async function () {
            const api = await bootApi({ HUB_API_KEY: KEY, HUB_SENSITIVE_READ_AUTH: '0' });
            expect(api.request('getallconfigs', undefined).nexted).to.equal(true);
            expect(api.request('updateconfig', undefined).res.statusCode).to.equal(401);
        });
    });

    describe('no HUB_API_KEY (regtest/local default)', function () {
        it('everything passes unauthenticated', async function () {
            const api = await bootApi({});
            for (const m of ['getallconfigs', 'updateconfig', 'pushchaintip', 'getproposals'])
                expect(api.request(m, undefined).nexted).to.equal(true, m);
        });
    });
});
