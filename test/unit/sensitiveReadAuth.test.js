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
const { waitUntil } = require('../helpers/waitUntil');

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
    for (const k of ['HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_CONFIG_SECRETS_API_KEY',
                     'HUB_SENSITIVE_READ_AUTH', 'HUB_ALLOW_UNAUTHENTICATED',
                     'HUB_DB_HOST', 'HUB_DB_PORT',
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
    // server.listen() is the last step of the async boot IIFE, so it is the
    // signal that every app.use() middleware has been registered; poll for it
    // rather than guessing how long the boot takes on this box.
    await waitUntil(() => mockServer.listen.called, { label: 'api.js boot to reach server.listen' });

    // The auth middleware is the app.use() function that 401s an unkeyed
    // write when a key is configured (or, keyless boot, the one that calls
    // next() for a write without touching res). Identify it by probing.
    function drive(mw, methodOrMethods, apiKey, params) {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
        // An array of methods drives a JSON-RPC batch (array body); a string
        // drives a single call (object body). `params` rides on the single-call
        // form, which is how the credential tier (getallconfigs with
        // include_secrets) is exercised.
        const body = Array.isArray(methodOrMethods)
            ? methodOrMethods.map((m, i) => ({ method: m, id: i + 1 }))
            : { method: methodOrMethods, id: 1, params: params };
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
        request:      (method, apiKey, params) => drive(authMw, method, apiKey, params),
        requestBatch: (methods, apiKey)        => drive(authMw, methods, apiKey)
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

        it('boot warns loudly when the hatch is open on a keyed hub (AU-4)', async function () {
            const warn = sinon.spy(console, 'warn');
            await bootApi({ HUB_API_KEY: KEY, HUB_SENSITIVE_READ_AUTH: '0' });
            expect(warn.getCalls().some((c) => /HUB_SENSITIVE_READ_AUTH=0.*getallconfigs/.test(String(c.args[0]))))
                .to.equal(true, 'expected the AU-4 boot warning');
        });

        it('no AU-4 warning when sensitive-read auth is enforcing', async function () {
            const warn = sinon.spy(console, 'warn');
            await bootApi({ HUB_API_KEY: KEY });
            expect(warn.getCalls().some((c) => /HUB_SENSITIVE_READ_AUTH=0/.test(String(c.args[0]))))
                .to.equal(false, 'unexpected AU-4 warning with auth enforcing');
        });

        // The hatch un-keys SERVICE DISCOVERY for a staged rollout. It must not
        // un-key the credentials riding in the same response, which is a
        // different and much larger decision than the operator flipping it
        // means to make.
        it('does NOT un-key the credential tier: include_secrets still 401s keyless', async function () {
            const api = await bootApi({ HUB_API_KEY: KEY, HUB_SENSITIVE_READ_AUTH: '0' });
            const { nexted, res } = api.request('getallconfigs', undefined, { include_secrets: true });
            expect(nexted).to.equal(false);
            expect(res.statusCode).to.equal(401);
        });

        it('still serves include_secrets to the bulk key while the hatch is open', async function () {
            const api = await bootApi({ HUB_API_KEY: KEY, HUB_SENSITIVE_READ_AUTH: '0' });
            expect(api.request('getallconfigs', KEY, { include_secrets: true }).nexted).to.equal(true);
        });
    });

    // Credential tier: getallconfigs redacts rpc/DB passwords unless the call
    // sets include_secrets, and THAT request is authorized on its own.
    describe('include_secrets credential tier', function () {

        describe('no HUB_CONFIG_SECRETS_API_KEY (bulk key authorizes credentials)', function () {
            let api;
            before(async function () { api = await bootApi({ HUB_API_KEY: KEY }); });

            it('include_secrets with the bulk key passes', function () {
                expect(api.request('getallconfigs', KEY, { include_secrets: true }).nexted).to.equal(true);
            });

            it('include_secrets without a key is 401', function () {
                expect(api.request('getallconfigs', undefined, { include_secrets: true }).res.statusCode)
                    .to.equal(401);
            });

            it('a redacted read (no flag) is unaffected', function () {
                expect(api.request('getallconfigs', KEY).nexted).to.equal(true);
            });
        });

        describe('HUB_CONFIG_SECRETS_API_KEY set (credentials split off the bulk key)', function () {
            const SKEY = 'test-config-secrets-key';
            let api;
            before(async function () {
                api = await bootApi({ HUB_API_KEY: KEY, HUB_CONFIG_SECRETS_API_KEY: SKEY });
            });

            it('include_secrets with the BULK key is 401 (bulk key demoted off credentials)', function () {
                expect(api.request('getallconfigs', KEY, { include_secrets: true }).res.statusCode)
                    .to.equal(401);
            });

            it('include_secrets with the secrets key passes', function () {
                expect(api.request('getallconfigs', SKEY, { include_secrets: true }).nexted).to.equal(true);
            });

            it('the redacted read still answers to the bulk key', function () {
                expect(api.request('getallconfigs', KEY).nexted).to.equal(true);
            });

            it('the secrets key authorizes nothing else (writes stay bulk-keyed)', function () {
                expect(api.request('updateconfig', SKEY).res.statusCode).to.equal(401);
                expect(api.request('pushchaintip', SKEY).res.statusCode).to.equal(401);
            });
        });

        describe('a secrets key on an otherwise keyless hub', function () {
            const SKEY = 'lone-secrets-key';
            let api;
            before(async function () {
                api = await bootApi({ HUB_ALLOW_UNAUTHENTICATED: 'true', HUB_CONFIG_SECRETS_API_KEY: SKEY });
            });

            // Returning early whenever the bulk and reorg keys are both unset
            // would leave a secrets key configured on its own silently inert.
            it('still gates include_secrets', function () {
                expect(api.request('getallconfigs', undefined, { include_secrets: true }).res.statusCode)
                    .to.equal(401);
                expect(api.request('getallconfigs', SKEY, { include_secrets: true }).nexted).to.equal(true);
            });

            it('leaves the declared-keyless surface otherwise open', function () {
                for (const m of ['getallconfigs', 'updateconfig', 'pushchaintip'])
                    expect(api.request(m, undefined).nexted).to.equal(true, m);
            });
        });

        describe('fully keyless hub (regtest)', function () {
            it('serves credentials as before: nothing on this hub is authenticated', async function () {
                const api = await bootApi({ HUB_ALLOW_UNAUTHENTICATED: 'true' });
                expect(api.request('getallconfigs', undefined, { include_secrets: true }).nexted).to.equal(true);
            });
        });
    });

    // Keyless is still a supported posture, but it has to be
    // DECLARED: a boot with neither a key nor the declaration refuses (proved in
    // bootAuthGate.test.js), so these keyless cases set the flag the way an
    // xchain-node-managed keyless deploy now does.
    describe('no HUB_API_KEY (declared keyless: regtest/local)', function () {
        it('everything passes unauthenticated', async function () {
            const api = await bootApi({ HUB_ALLOW_UNAUTHENTICATED: 'true' });
            for (const m of ['getallconfigs', 'updateconfig', 'pushchaintip', 'getproposals'])
                expect(api.request(m, undefined).nexted).to.equal(true, m);
        });
    });

    // interim credential scoping: with HUB_REORG_API_KEY set, the
    // retraction rails (push*reorg) answer ONLY to it - the bulk key no longer
    // authorizes them, and the reorg key authorizes nothing else - so a
    // bulk-key compromise cannot fabricate reorg retractions.
    describe('HUB_REORG_API_KEY set (retraction-rail tier)', function () {
        const RKEY = 'test-reorg-key';
        let api;
        before(async function () { api = await bootApi({ HUB_API_KEY: KEY, HUB_REORG_API_KEY: RKEY }); });

        it('push*reorg with the BULK key is 401 (bulk key demoted off the rail)', function () {
            for (const m of ['pushpricereorg', 'pushxcallreorg', 'pushdexreorg'])
                expect(api.request(m, KEY).res.statusCode).to.equal(401, m);
        });

        it('push*reorg with the reorg key passes', function () {
            for (const m of ['pushpricereorg', 'pushxcallreorg', 'pushdexreorg'])
                expect(api.request(m, RKEY).nexted).to.equal(true, m);
        });

        it('the reorg key authorizes nothing else (other writes stay bulk-keyed)', function () {
            expect(api.request('pushchaintip', RKEY).res.statusCode).to.equal(401);
            expect(api.request('pushchaintip', KEY).nexted).to.equal(true);
        });

        it('a batch mixing tiers cannot satisfy both with one key', function () {
            expect(api.requestBatch(['pushpricereorg', 'pushchaintip'], RKEY).res.statusCode).to.equal(401);
            expect(api.requestBatch(['pushpricereorg', 'pushchaintip'], KEY).res.statusCode).to.equal(401);
        });

        it('unset HUB_REORG_API_KEY keeps legacy bulk-key gating (rolling-deploy safe)', async function () {
            const legacy = await bootApi({ HUB_API_KEY: KEY });
            expect(legacy.request('pushpricereorg', KEY).nexted).to.equal(true);
            expect(legacy.request('pushpricereorg', undefined).res.statusCode).to.equal(401);
        });

        it('reorg tier enforced even when the bulk key is unset', async function () {
            const reorgOnly = await bootApi({ HUB_REORG_API_KEY: RKEY, HUB_ALLOW_UNAUTHENTICATED: 'true' });
            expect(reorgOnly.request('pushpricereorg', undefined).res.statusCode).to.equal(401);
            expect(reorgOnly.request('pushpricereorg', RKEY).nexted).to.equal(true);
            expect(reorgOnly.request('pushchaintip', undefined).nexted).to.equal(true);
        });
    });
});
