/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

'use strict';

/**
 * The public and authenticated JSON-RPC tiers, and the batch surcharge.
 *
 * The defect these guard: a validator hub shipped HUB_RATE_LIMIT_RPM=60000 for every
 * caller, and a 20-call batch cost one token, so one keyless client could drive about
 * 1.2M `health` handlers a minute. Driven over a socket against the real
 * production transport stack, as rate_limit_snapshot_route.test.js drives the drain.
 */

const { expect } = require('chai');
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const http      = require('http');
const sinon     = require('sinon');
const { installTransportMiddleware } = require('../../../../src/api/middleware.js');
const { DEFAULT_AUTH_RPM, authenticatedCaller, batchCost, parseAuthRpm } = require('../../../../src/api/rate_limit_tiers.js');
const FixedWindowStore = require('../../../../src/api/rate_limit_store.js');
const { isSnapshotPageRead } = require('../../../../src/api/rate_limit_policy.js');

const PUBLIC_IP = '203.0.113.7';
const HUB_KEY   = 'hub-key-for-tests';

let server = null;
let port   = 0;
let handled = 0;

function boot(opts) {
    opts = opts || {};
    handled = 0;
    const app = express();
    installTransportMiddleware(app, {
        hubConfig: { HUB_TRUST_PROXY: 'loopback', HUB_AUTH_RATE_LIMIT_RPM: opts.authRpm,
            HUB_SNAPSHOT_RATE_LIMIT_RPM: opts.snapshotRpm },
        logger: { info() {}, warn() {} },
        express, helmet, cors, rateLimit,
        CORS_ORIGIN: '*',
        HUB_API_KEY: opts.keyless ? '' : HUB_KEY,
        HUB_RATE_LIMIT_RPM: opts.rpm === undefined ? 100 : opts.rpm,
        HUB_RATE_LIMIT_EXEMPT_LOCAL: true
    });
    // As in server.js: the snapshot page routes first, then a JSON-RPC dispatcher mounted
    // at the root for every method and path, so a JSON-RPC body sent to a snapshot path no
    // page route answers is dispatched like one sent to /.
    app.get('/hub-db/snapshot/price_snapshots', (req, res) => res.json({ rows: [], count: 0 }));
    app.use((req, res) => {
        const calls = Array.isArray(req.body) ? req.body : [req.body || {}];
        handled += calls.length;
        res.json(calls.map((c) => ({ jsonrpc: '2.0', id: c.id, result: 'ok' })));
    });
    return new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
    });
}

function shutdown() {
    return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => { server = null; resolve(); });
    });
}

function post(payload, headers) {
    return send('POST', '/', payload, headers);
}

// One request from PUBLIC_IP; payload undefined sends no body at all, as a mirror's page read.
function send(method, path, payload, headers) {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const bodyHeaders = body === null ? {}
        : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1', port, path, method,
            headers: Object.assign(bodyHeaders, { 'X-Forwarded-For': PUBLIC_IP }, headers || {})
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (body !== null) req.write(body);
        req.end();
    });
}

function healthCall(id) {
    return { jsonrpc: '2.0', id, method: 'health', params: {} };
}

function batchOf(n) {
    return Array.from({ length: n }, (_, i) => healthCall(i + 1));
}

const WITH_KEY = { 'x-api-key': HUB_KEY };

function batchChargingSuite() {
    it('charges a batch one token per call', async function () {
        await boot({ rpm: 40 });
        expect((await post(batchOf(20))).status).to.equal(200);
        expect((await post(batchOf(20))).status).to.equal(200);
        const over = await post(healthCall(99));
        expect(over.status).to.equal(429);
        expect(JSON.parse(over.body).error.code).to.equal(-32029);
        expect(handled).to.equal(40);
    });

    it('refuses a batch whose calls exceed what is left, before any call runs', async function () {
        await boot({ rpm: 10 });
        const res = await post(batchOf(20));
        expect(res.status).to.equal(429);
        expect(handled).to.equal(0);
    });

    it('still charges a single call exactly one token', async function () {
        await boot({ rpm: 5 });
        for (let i = 1; i <= 5; i++) expect((await post(healthCall(i))).status, 'call ' + i).to.equal(200);
        expect((await post(healthCall(6))).status).to.equal(429);
    });

    it('charges an authenticated batch per call in the authenticated tier', async function () {
        await boot({ rpm: 5, authRpm: 30 });
        expect((await post(batchOf(20), WITH_KEY)).status).to.equal(200);
        expect((await post(batchOf(10), WITH_KEY)).status).to.equal(200);
        expect((await post(healthCall(1), WITH_KEY)).status).to.equal(429);
    });

    it('counts tokens by call: batchCost', function () {
        expect(batchCost({ body: batchOf(20) })).to.equal(20);
        expect(batchCost({ body: [] })).to.equal(1);
        expect(batchCost({ body: healthCall(1) })).to.equal(1);
        expect(batchCost({})).to.equal(1);
        expect(batchCost(undefined)).to.equal(1);
    });
}

// The advertised RateLimit-Remaining must match the bucket after the batch surcharge.
function batchHeaderSuite() {
    it('advertises the bucket after a served batch: Remaining drops by the call count', async function () {
        await boot({ keyless: true });
        const served = await post(batchOf(20));
        expect(served.status).to.equal(200);
        expect(served.headers['ratelimit-limit']).to.equal('100');
        expect(served.headers['ratelimit-remaining']).to.equal('80');
        expect((await post(healthCall(1))).headers['ratelimit-remaining']).to.equal('79');
    });

    it('advertises Remaining 0 on the surcharge 429 and keeps it consistent after', async function () {
        await boot({ keyless: true });
        for (let i = 1; i <= 81; i++) await post(healthCall(i));
        const refused = await post(batchOf(20));
        expect(refused.status).to.equal(429);
        expect(JSON.parse(refused.body).error.code).to.equal(-32029);
        expect(refused.headers['ratelimit-remaining']).to.equal('0');
        expect(refused.headers['retry-after']).to.be.a('string');
        const next = await post(healthCall(99));
        expect(next.status).to.equal(429);
        expect(next.headers['ratelimit-remaining']).to.equal('0');
    });

    it('advertises the cost on the batch-guard 400 for an oversized batch', async function () {
        await boot({ keyless: true });
        // The guard itself is not mounted in this harness, so assert the header the
        // surcharge leaves for whatever answers next: a 21-call batch costs 21.
        const res = await post(batchOf(21));
        expect(res.headers['ratelimit-remaining']).to.equal('79');
        expect((await post(healthCall(1))).headers['ratelimit-remaining']).to.equal('78');
    });
}

function bucketsSuite() {
    it('keeps the public tier conservative while a key-holder on the same IP carries on', async function () {
        await boot({ rpm: 3, authRpm: 50 });
        for (let i = 1; i <= 3; i++) expect((await post(healthCall(i))).status).to.equal(200);
        const refused = await post(healthCall(4));
        expect(refused.status).to.equal(429);
        expect(JSON.parse(refused.body).error.data.env).to.equal('HUB_RATE_LIMIT_RPM');
        for (let i = 1; i <= 40; i++) expect((await post(healthCall(i), WITH_KEY)).status, 'keyed ' + i).to.equal(200);
        const keyed = await post(healthCall(41), WITH_KEY);
        expect(keyed.headers['ratelimit-limit']).to.equal('50');
    });

    it('a key-holder spending its tier leaves the public tier untouched', async function () {
        await boot({ rpm: 3, authRpm: 4 });
        for (let i = 1; i <= 4; i++) expect((await post(healthCall(i), WITH_KEY)).status).to.equal(200);
        const refused = await post(healthCall(5), WITH_KEY);
        expect(refused.status).to.equal(429);
        expect(JSON.parse(refused.body).error.data.env).to.equal('HUB_AUTH_RATE_LIMIT_RPM');
        expect((await post(healthCall(6))).status).to.equal(200);
    });

    it('a wrong key buys nothing: it is metered as public', async function () {
        await boot({ rpm: 2, authRpm: 50 });
        const wrong = { 'x-api-key': 'not-the-key' };
        expect((await post(healthCall(1), wrong)).status).to.equal(200);
        expect((await post(healthCall(2), wrong)).status).to.equal(200);
        expect((await post(healthCall(3), wrong)).status).to.equal(429);
    });

    it('a keyless hub has no authenticated tier at all', async function () {
        await boot({ rpm: 2, authRpm: 50, keyless: true });
        expect((await post(healthCall(1), WITH_KEY)).status).to.equal(200);
        expect((await post(healthCall(2), WITH_KEY)).status).to.equal(200);
        expect((await post(healthCall(3), WITH_KEY)).status).to.equal(429);
    });

    it('recognises every configured hub key and nothing else', function () {
        const isAuthenticated = authenticatedCaller({
            HUB_API_KEY: 'bulk', HUB_FEED_API_KEY: 'feed',
            HUB_REORG_API_KEY: 'reorg', HUB_CONFIG_SECRETS_API_KEY: ''
        });
        expect(isAuthenticated({ headers: { 'x-api-key': 'bulk' } })).to.equal(true);
        expect(isAuthenticated({ headers: { 'x-api-key': 'feed' } })).to.equal(true);
        expect(isAuthenticated({ headers: { 'x-api-key': 'reorg' } })).to.equal(true);
        expect(isAuthenticated({ headers: { 'x-api-key': '' } })).to.equal(false);
        expect(isAuthenticated({ headers: { 'x-api-key': 'bulkx' } })).to.equal(false);
        expect(isAuthenticated({ headers: {} })).to.equal(false);
        expect(isAuthenticated(undefined)).to.equal(false);
        expect(authenticatedCaller({})({ headers: { 'x-api-key': '' } })).to.equal(false);
    });

    it('defaults the authenticated tier to the fleet value, never below the public one', function () {
        expect(DEFAULT_AUTH_RPM).to.equal(60000);
        expect(parseAuthRpm(undefined, 100)).to.equal(60000);
        expect(parseAuthRpm('abc', 100)).to.equal(60000);
        expect(parseAuthRpm('0', 100)).to.equal(60000);
        expect(parseAuthRpm(undefined, 90000)).to.equal(90000);
        expect(parseAuthRpm('5000', 100)).to.equal(5000);
    });
}

function rotatedKeySuite() {
    it('recognises HUB_API_KEY_PREVIOUS only while it is set', function () {
        const base = { HUB_API_KEY: 'bulk', HUB_API_KEY_PREVIOUS: 'old' };
        expect(authenticatedCaller(base)({ headers: { 'x-api-key': 'old' } })).to.equal(true);
        expect(authenticatedCaller(Object.assign({}, base, { HUB_API_KEY_PREVIOUS: '' }))({ headers: { 'x-api-key': 'old' } })).to.equal(false);
    });
}

// Date is faked so window expiry is driven, never waited for.
function storeSuite() {
    let clock;
    beforeEach(() => { clock = sinon.useFakeTimers(); });
    afterEach(() => clock.restore());

    it('charges in bulk and resets when the window expires', async function () {
        const store = new FixedWindowStore();
        store.init({ windowMs: 50 });
        expect(store.incrementBy('k', 19).totalHits).to.equal(19);
        expect((await store.increment('k')).totalHits).to.equal(20);
        await store.decrement('k');
        expect((await store.get('k')).totalHits).to.equal(19);
        clock.tick(51);
        expect(await store.get('k')).to.equal(undefined);
        expect(store.incrementBy('k', 1).totalHits).to.equal(1);
    });

    it('sweeps expired keys so the map cannot grow without bound', function () {
        const store = new FixedWindowStore();
        store.init({ windowMs: 20 });
        for (let i = 0; i < 50; i++) store.incrementBy('ip' + i, 1);
        clock.tick(21);
        store.incrementBy('fresh', 1);
        expect(store.windows.size).to.equal(1);
    });
}

// The escape these guard: the JSON-RPC tiers skipped every path under /hub-db/snapshot
// and the 600/min snapshot bucket metered it per HTTP request, so a JSON-RPC body POSTed
// to /hub-db/snapshot/x was dispatched by the root router at one snapshot token per
// request, batch or not: 600 x 20 calls a minute per IP against a public tier of 100.
function snapshotPathSuite() {
    const PING = { jsonrpc: '2.0', id: 7, method: 'ping', params: [] };

    for (const path of ['/hub-db/snapshot/x', '/hub-db/snapshot', '/hub-db/snapshot/price_snapshots']) {
        it('meters a JSON-RPC call POSTed to ' + path + ' on the public tier', async function () {
            await boot({ keyless: true });
            const res = await send('POST', path, PING);
            expect(res.status).to.equal(200);
            expect(res.headers['ratelimit-limit']).to.equal('100');
            expect(res.headers['ratelimit-remaining']).to.equal('99');
            expect(handled).to.equal(1);
            const after = await post(healthCall(1));
            expect(after.headers['ratelimit-remaining']).to.equal('98');
        });
    }

    it('meters a GET with a JSON-RPC body to an unknown snapshot table on the public tier', async function () {
        await boot({ keyless: true });
        const res = await send('GET', '/hub-db/snapshot/none', PING);
        expect(res.headers['ratelimit-limit']).to.equal('100');
        expect((await post(healthCall(1))).headers['ratelimit-remaining']).to.equal('98');
    });

    it('charges a batch on a snapshot path per call, and never the snapshot bucket', async function () {
        await boot({ keyless: true });
        expect((await send('POST', '/hub-db/snapshot/x', batchOf(20))).status).to.equal(200);
        expect(handled).to.equal(20);
        expect((await post(healthCall(1))).headers['ratelimit-remaining']).to.equal('79');
        const page = await send('GET', '/hub-db/snapshot/price_snapshots?since_id=0&limit=10000');
        expect(page.headers['ratelimit-limit']).to.equal('600');
        expect(page.headers['ratelimit-remaining']).to.equal('599');
    });

    it('refuses the 101st ping on a snapshot path at the shipped public tier', async function () {
        await boot({ keyless: true });
        for (let i = 1; i <= 100; i++) {
            expect((await send('POST', '/hub-db/snapshot/x', healthCall(i))).status, 'call ' + i).to.equal(200);
        }
        const refused = await send('POST', '/hub-db/snapshot/x', healthCall(101));
        expect(refused.status).to.equal(429);
        expect(JSON.parse(refused.body).error.code).to.equal(-32029);
        expect(handled).to.equal(100);
    });

    it('still meters a bodyless page read on the snapshot bucket alone', async function () {
        await boot({ keyless: true });
        const page = await send('GET', '/hub-db/snapshot/price_snapshots?since_id=0&limit=10000');
        expect(page.status).to.equal(200);
        expect(page.headers['ratelimit-limit']).to.equal('600');
        expect(page.headers['ratelimit-remaining']).to.equal('599');
        expect((await post(healthCall(1))).headers['ratelimit-remaining']).to.equal('99');
    });
}

function snapshotPageReadSuite() {
    it('classifies a page read by method, prefix and the absence of a body', function () {
        const read = (method, originalUrl, headers) => isSnapshotPageRead({ method, originalUrl, headers: headers || {} });
        expect(read('GET', '/hub-db/snapshot/price_snapshots?since_id=0')).to.equal(true);
        expect(read('HEAD', '/hub-db/snapshot/oracle_prices')).to.equal(true);
        expect(read('GET', '/hub-db/snapshot/price_snapshots', { 'content-length': '0' })).to.equal(true);
        expect(read('POST', '/hub-db/snapshot/x')).to.equal(false);
        expect(read('GET', '/hub-db/snapshot/none', { 'content-length': '58' })).to.equal(false);
        expect(read('GET', '/hub-db/snapshot/none', { 'transfer-encoding': 'chunked' })).to.equal(false);
        expect(read('GET', '/hub-db/snapshotting')).to.equal(false);
        expect(read('GET', '/')).to.equal(false);
        expect(isSnapshotPageRead({ originalUrl: '/hub-db/snapshot/x' })).to.equal(false);
        expect(isSnapshotPageRead(undefined)).to.equal(false);
    });
}

describe('hub JSON-RPC rate-limit tiers', function () {
    this.timeout(10000);
    afterEach(shutdown);
    describe('JSON-RPC sent to a snapshot path', snapshotPathSuite);
    describe('isSnapshotPageRead', snapshotPageReadSuite);
    describe('batch charging', batchChargingSuite);
    describe('batch RateLimit headers', batchHeaderSuite);
    describe('public and authenticated buckets', bucketsSuite);
    describe('rotated hub key', rotatedKeySuite);
    describe('FixedWindowStore', storeSuite);
});
