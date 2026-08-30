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
//
// getrollcallstatus: the RPC surface and its auth tier, plus the `broadcast`
// presence check the oracle_publish self-test gained alongside it.
//
// The method carries no credential, so nothing about its BODY forces it into the
// keyed tier; what does is that a per-epoch signer count is a pre-eviction
// TARGETING surface. A caller polling every hub in the federation can watch which
// keys are drifting toward the absence streak before the chain acts on it, which
// is a list of who to knock over and when. That reasoning lives nowhere the code
// can enforce, so the tier membership is asserted here rather than trusted.

const sinon      = require('sinon');
const assert     = require('assert');
const fs         = require('fs');
const path       = require('path');
const proxyquire = require('proxyquire').noPreserveCache();
const { waitUntil } = require('../helpers/waitUntil');

const API_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'api.js'), 'utf8');

// Boot src/api.js with everything heavy stubbed and capture the JSON-RPC
// controller object the router is handed, plus the middlewares registered.
// Same shape as test/unit/sensitiveReadAuth.test.js's harness.
async function bootApi(env, hubOverrides) {
    const useCalls = [];
    let controller = null;
    const mockApp = {
        use:  sinon.stub().callsFake((fn) => { useCalls.push(fn); }),
        get:  sinon.stub(), post: sinon.stub(), set: sinon.stub(),
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); })
    };
    const mockServer = {
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); }),
        on: sinon.stub()
    };
    const mockExpress = sinon.stub().returns(mockApp);
    mockExpress.json = sinon.stub().returns(function expressJson() {});

    const mockHub = new Proxy(Object.assign({}, hubOverrides || {}), {
        get: (target, prop) => {
            if (!(prop in target)) target[prop] = sinon.stub().callsFake(async () => ({}));
            return target[prop];
        }
    });

    const KEYS = ['HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_SENSITIVE_READ_AUTH',
                  'HUB_ALLOW_UNAUTHENTICATED', 'HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME',
                  'HUB_DB_USER', 'HUB_DB_PASS', 'HUB_PORT', 'P2P_VALIDATOR_ADDR'];
    const saved = {};
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
        HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9999',
        // A keyless boot REFUSES unless the posture is declared, and the refusal
        // is a process.exit that would take the runner with it.
        HUB_ALLOW_UNAUTHENTICATED: 'true'
    }, env);

    try {
        proxyquire('../../src/api', {
            'dotenv': { config: sinon.stub() },
            'express': mockExpress,
            'helmet': sinon.stub().returns(function helmetMw() {}),
            'cors': sinon.stub().returns(function corsMw() {}),
            'express-rate-limit': sinon.stub().returns(function rateLimitMw() {}),
            'express-json-rpc-router': (opts) => { controller = opts.methods; return function routerMw() {}; },
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
    return { controller, useCalls, hub: mockHub };
}

// Run one JSON-RPC method name through each registered middleware and report
// whether ANY of them refused it without a key. Identifying the auth middleware
// by behaviour rather than by position keeps this from breaking every time an
// unrelated middleware is inserted ahead of it.
function refusedWithoutKey(useCalls, method, apiKey) {
    for (const mw of useCalls) {
        if (typeof mw !== 'function' || mw.length < 3) continue;
        let status = 200, nexted = false;
        const res = { status(c) { status = c; return this; }, json() { return this; } };
        try {
            mw({ body: { method, id: 1 }, headers: apiKey ? { 'x-api-key': apiKey } : {} },
               res, () => { nexted = true; });
        } catch (_) { continue; }
        if (!nexted && status === 401) return true;
    }
    return false;
}

describe('getrollcallstatus', function () {

    it('is registered in SENSITIVE_READ_METHODS beside getallconfigs', function () {
        // Read the real set out of the source, so a rename cannot pass by
        // renaming the assertion with it.
        const i   = API_SRC.indexOf('SENSITIVE_READ_METHODS = new Set(');
        const set = API_SRC.slice(i, API_SRC.indexOf(')', i));
        const names = [...set.matchAll(/'([a-z_0-9]+)'/g)].map(m => m[1]);
        assert.ok(names.includes('getallconfigs'), 'extraction broken');
        assert.ok(names.includes('getrollcallstatus'),
            'per-epoch signer counts are a pre-eviction targeting surface and must be keyed');
    });

    it('401s an unkeyed call when HUB_API_KEY is set, and passes with the key', async function () {
        const KEY = 'test-hub-key';
        const { useCalls } = await bootApi({ HUB_API_KEY: KEY, HUB_ALLOW_UNAUTHENTICATED: 'false' });
        assert.strictEqual(refusedWithoutKey(useCalls, 'getrollcallstatus'), true);
        assert.strictEqual(refusedWithoutKey(useCalls, 'getrollcallstatus', KEY), false);
        // Sanity: the public read tier really is open, so the assertion above is
        // testing the tier and not a middleware that refuses everything.
        assert.strictEqual(refusedWithoutKey(useCalls, 'ping'), false);
    });

    it('returns publisher state from the engine and no ledger facts', async function () {
        const status = {
            epoch: 30, signed: true, gossiped_count: 4, on_chain_count: 3,
            leader: 'a'.repeat(64), our_rank: 1, txids: ['tx1'], broadcast_capable: true
        };
        const { controller } = await bootApi({}, { rollcallRound: { getStatus: () => status } });
        const out = await controller.getrollcallstatus({});
        assert.strictEqual(out.active, true);
        for (const [k, v] of Object.entries(status)) assert.deepStrictEqual(out[k], v);
        for (const forbidden of ['last_rolled_epoch', 'absent_streak', 'evicted'])
            assert.strictEqual(forbidden in out, false,
                forbidden + ' belongs to the BTC indexer, where it is authoritative');
    });

    it('answers a fully-shaped body with active:false when no engine is running', async function () {
        // Mirrors getanchorstatus: always 200, never a 503 that would hide the
        // body, and never a bare {active:false} a poller has to branch on.
        const { controller } = await bootApi({}, { rollcallRound: null });
        const out = await controller.getrollcallstatus({});
        assert.strictEqual(out.active, false);
        assert.deepStrictEqual(Object.keys(out).sort(),
            ['active', 'broadcast_capable', 'epoch', 'gossiped_count', 'leader',
             'on_chain_count', 'our_rank', 'signed', 'txids'].sort());
        assert.strictEqual(out.broadcast_capable, false);
    });
});

describe('capabilities/oracle_publish broadcast presence check', function () {

    const VALID = { HUB_NETWORK: 'mainnet',
                    oracle_publish: { doge_address: 'DPVuXtvCWXSBFEkgWKfeSCL1e4YqfbwXkg',
                                      doge_wallet: '/path/to/wallet' } };

    function load(loadSignerHooks) {
        return proxyquire('../../src/capabilities/oracle_publish', {
            '../lib/signer-loader.js': { loadSignerHooks }
        });
    }

    it('passes when the configured signer module exports broadcast', async function () {
        const mod = load(() => ({ source: '/opt/signer.js', walletSignFn: () => {}, broadcastFn: () => {} }));
        assert.strictEqual((await mod.selfTest(VALID)).ok, true);
    });

    it('FAILS when the configured signer module exports only walletSign', async function () {
        // signer-loader treats `broadcast` as optional, so such a module loads
        // cleanly and signs everything it is asked to; the built-in pipeline then
        // fails closed on the two-phase P2SH encoding and nothing is ever
        // published. That silence is what this check converts into a signal.
        const mod = load(() => ({ source: '/opt/signer.js', walletSignFn: () => {}, broadcastFn: null }));
        const r = await mod.selfTest(VALID);
        assert.strictEqual(r.ok, false);
        assert.ok(/broadcast\(payload\)/.test(r.reason), r.reason);
    });

    it('reports a configured-but-unloadable signer as a reason, not as a throw', async function () {
        const mod = load(() => { throw new Error('HUB_SIGNER_MODULE failed to load (/nope)'); });
        const r = await mod.selfTest(VALID);
        assert.strictEqual(r.ok, false);
        assert.ok(/unusable/.test(r.reason), r.reason);
    });

    it('leaves the no-signer-module posture unchanged', async function () {
        // An unset HUB_SIGNER_MODULE is the hub's documented "publishers stay
        // idle" state, which the publishers announce themselves. Failing it here
        // would strip oracle_publish from every hub that has never had a signer,
        // which is a different condition from the one being closed.
        const mod = load(() => null);
        assert.strictEqual((await mod.selfTest(VALID)).ok, true);
    });

    it('still enforces the address and wallet checks ahead of the signer check', async function () {
        const mod = load(() => ({ source: '/opt/signer.js', walletSignFn: () => {}, broadcastFn: () => {} }));
        assert.strictEqual((await mod.selfTest({})).ok, false);
        assert.strictEqual((await mod.selfTest({ HUB_NETWORK: 'testnet',
            oracle_publish: { doge_address: 'DPVuXtvCWXSBFEkgWKfeSCL1e4YqfbwXkg', doge_wallet: '/p' } })).ok, false);
    });
});
