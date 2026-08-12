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

// GET /api/v1/chain-registry: the wallet-bootstrap endpoint (wallet G007).
// Covers the route contract (shape, caching, optional identity signature),
// consistency of the vendored snapshot against the canonical coin registry,
// and drift against the wallet's bundled descriptors when the sibling repo
// is present.

const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();
const coins      = require('../../src/coins');
const { waitUntil } = require('../helpers/waitUntil');

const SNAPSHOT_PATH = path.join(__dirname, '../../src/chain-registry.json');
const SNAPSHOT = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));

// Boot src/api.js with heavy deps stubbed; capture app.get routes and return
// the /api/v1/chain-registry handler.
async function bootRoute({ identity } = {}) {
    const gets = new Map();
    const mockApp = {
        use:  sinon.stub(),
        get:  sinon.stub().callsFake((route, fn) => { gets.set(route, fn); }),
        post: sinon.stub(),
        set:  sinon.stub(),
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); })
    };
    const mockExpress = sinon.stub().returns(mockApp);
    mockExpress.json = sinon.stub().returns(function expressJson() {});
    const mockHub = new Proxy({ getIdentity: () => identity || null }, {
        get: (target, prop) => {
            if (!(prop in target)) target[prop] = sinon.stub().callsFake(async () => ({}));
            return target[prop];
        }
    });

    const saved = {};
    for (const k of ['HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS', 'HUB_PORT',
                     'P2P_VALIDATOR_ADDR', 'HUB_API_KEY', 'HUB_ALLOW_UNAUTHENTICATED']) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    Object.assign(process.env, {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
        HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9999',
        // a keyless boot refuses unless keyless is declared, and this
        // harness deliberately boots keyless (the route under test is public).
        HUB_ALLOW_UNAUTHENTICATED: 'true'
    });
    try {
        proxyquire('../../src/api', {
            'dotenv': { config: sinon.stub() },
            'express': mockExpress,
            'helmet': sinon.stub().returns(function helmetMw() {}),
            'cors': sinon.stub().returns(function corsMw() {}),
            'express-rate-limit': sinon.stub().returns(function rateLimitMw() {}),
            'express-json-rpc-router': () => function routerMw() {},
            'http': { createServer: sinon.stub().returns({ listen: sinon.stub().callsFake((p, h, cb) => { if (cb) cb(); }), on: sinon.stub() }) },
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
    // The boot is an async IIFE, so the route appears some ticks after
    // proxyquire returns; poll for it rather than guessing a settle.
    const handler = await waitUntil(() => gets.get('/api/v1/chain-registry'),
        { label: 'route /api/v1/chain-registry to register' });
    expect(handler, 'route /api/v1/chain-registry not registered').to.be.a('function');
    return handler;
}

function run(handler) {
    const res = {
        statusCode: 200,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        set(k, v) { this.headers[k] = v; return this; },
        json(body) { this.body = body; return this; }
    };
    handler({}, res);
    return res;
}

describe('GET /api/v1/chain-registry', function () {

    // The first bootRoute() pays a one-time SYNCHRONOUS require of src/api.js's
    // whole module tree (~650ms with a warm page cache, seconds on a cold CI
    // filesystem); the async IIFE it then waits on costs single-digit ms. Mocha
    // charges that load to whichever test runs first, so on a cold venue this
    // file failed its first case on the clock while every assertion in it was
    // sound - a red that was misread as descriptor drift. Absorb the
    // load in a hook with its own budget, so a test's timeout measures the route
    // rather than the module loader. Do NOT fold this into the tests by raising
    // their timeouts: that would hide a genuinely slow boot instead of paying it
    // once, and the byte-parity guard below is what must never be papered over.
    before(async function () {
        this.timeout(60000);
        await bootRoute();
    });

    afterEach(function () { sinon.restore(); });

    it('serves {schema_version, generatedAt, descriptors} with public caching', async function () {
        const res = run(await bootRoute());
        expect(res.statusCode).to.equal(200);
        expect(res.headers['Cache-Control']).to.contain('public');
        expect(res.body.schema_version).to.equal(1);
        expect(res.body.generatedAt).to.be.a('string');
        expect(res.body.descriptors).to.be.an('array').with.length(SNAPSHOT.descriptors.length);
        expect(res.body.signature).to.equal(undefined, 'unsigned without an identity');
        // Browser wallets (web SPA + MV3 extension with no host_permissions)
        // consume this cross-origin; the route must be CORS-open even though
        // the hub's global CORS_ORIGIN defaults off.
        expect(res.headers['Access-Control-Allow-Origin']).to.equal('*');
    });

    it('signs the payload when the hub has an identity', async function () {
        const identity = {
            getPubkeyHex: () => 'ab'.repeat(32),
            sign: sinon.stub().returns('cd'.repeat(64))
        };
        const res = run(await bootRoute({ identity }));
        expect(res.body.signer_pubkey).to.equal('ab'.repeat(32));
        expect(res.body.signature).to.equal('cd'.repeat(64));
        const digest = crypto.createHash('sha256')
            .update(JSON.stringify(SNAPSHOT.descriptors)).digest('hex');
        expect(identity.sign.firstCall.args[0]).to.equal(
            'XCHAIN_CHAIN_REGISTRY_V1|' + SNAPSHOT.generated_at + '|' + digest);
    });
});

describe('chain-registry snapshot consistency', function () {

    const TICK_BY_COIN = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' };

    it('covers all 9 coin/network combinations exactly once', function () {
        const ids = SNAPSHOT.descriptors.map((d) => d.id).sort();
        const expected = [];
        for (const coin of Object.keys(TICK_BY_COIN))
            for (const net of ['mainnet', 'testnet', 'regtest'])
                expected.push(coin + '-' + net);
        expect(ids).to.deep.equal(expected.sort());
    });

    it('wifVersionByte matches the canonical coin registry per network', function () {
        for (const d of SNAPSHOT.descriptors) {
            const cfg = coins.getCoinConfig(TICK_BY_COIN[d.coin], d.networkKind);
            expect(d.wifVersionByte).to.equal(cfg.net.wif,
                d.id + ' wifVersionByte must match xchain-hub/src/coins');
        }
    });

    it('every descriptor carries the endpoint objects the wallet requires', function () {
        for (const d of SNAPSHOT.descriptors)
            for (const svc of ['explorer', 'encoder', 'hub']) {
                expect(d[svc], d.id + ' ' + svc).to.be.an('object');
                expect(d[svc].defaultUrl, d.id + ' ' + svc + '.defaultUrl').to.be.a('string').and.not.equal('');
            }
    });

    // Skips when xchain-wallet is not checked out (standalone hub deploy), but hard-fails
    // in the required-siblings lane (XCHAIN_REQUIRE_SIBLINGS=1, bin/ci-all.sh) so a
    // mis-resolved sibling path cannot silently retire this byte-parity guard (item 2435).
    //
    // The skip is no longer the only thing standing between a descriptor fix and a
    // superseded snapshot: it used to be, and a corrected bitcoin-regtest
    // encoder port sat unmirrored on origin for both repos because a hub-only run
    // skipped here and a wallet-only run looked at nothing. The wallet now commits
    // bin/chain-registry.sync.json beside its descriptors and fails its own unit
    // suite when the two disagree, with no checkout of this repo present.
    it('matches the wallet bundled descriptors byte-for-byte (skip if sibling absent)', async function () {
        const walletDescriptors = path.join(__dirname,
            '../../../xchain-wallet/packages/core/src/registry/descriptors/index.js');
        if (!fs.existsSync(walletDescriptors)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the wallet bundled descriptors are missing at '
                    + walletDescriptors);
            return this.skip();
        }
        const mod = await import(walletDescriptors);
        expect(JSON.stringify(SNAPSHOT.descriptors)).to.equal(
            JSON.stringify(mod.BUNDLED_DESCRIPTORS),
            'snapshot drifted; run xchain-wallet/bin/sync-chain-registry.mjs');
    });
});
