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
 **********************************************************************
 *
 * The mirror bootstrap gets its own per-IP budget.
 *
 * THE MEASURED FAILURE, from the 2026-09-16 fleet roll. Recreating the five
 * testnet validator hubs made every mirroring indexer re-drain each hub table
 * from id 0 over /hub-db/snapshot/<table>. Three indexers reach those hubs over
 * a PUBLIC address, so they share one per-IP bucket with each other AND with
 * ordinary fleet polling; the drain 429ed part way through, retried every 30s,
 * re-spent the budget on the retry, and testnet indexing stayed wedged until
 * HUB_RATE_LIMIT_RPM was raised to 60000 by hand on all five hubs.
 *
 * WHAT THESE TESTS HOLD. Two buckets that cannot starve each other, and a
 * public JSON-RPC surface whose throttle did NOT move as a side effect. The
 * load-bearing assertions drive real express + express-rate-limit through
 * installRateLimits, because the defect was never in an options object: it was
 * in which requests were charged to which budget on the wire.
 *
 **********************************************************************/

'use strict';

const { expect } = require('chai');
const express   = require('express');
const rateLimit = require('express-rate-limit');
const http      = require('http');
const { installRateLimits } = require('../../../src/api/middleware.js');
const { buildRateLimitOptions, isSnapshotRequest, parseSnapshotRpm,
        DEFAULT_SNAPSHOT_RPM, RATE_LIMIT_RPC_ERROR_CODE,
        SNAPSHOT_PATH_PREFIX } = require('../../../src/api/rate_limit_policy.js');

// A public caller, asserted as public: trust proxy is 'loopback' only, so the
// X-Forwarded-For we send from a loopback socket resolves req.ip to this address
// and the loopback/private exemption misses it, exactly as an indexer on another
// host reaching a validator hub over its public name does.
const PUBLIC_IP = '203.0.113.7';
const PUBLIC    = { 'X-Forwarded-For': PUBLIC_IP };

let server = null;
let port   = 0;

// Mount the limiters exactly as the hub's middleware stack does, then a stand-in for
// each metered surface: one snapshot page route and one JSON-RPC endpoint.
function boot(opts) {
    opts = opts || {};
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    installRateLimits(app, {
        hubConfig: { HUB_SNAPSHOT_RATE_LIMIT_RPM: opts.snapshotRpm },
        logger: { info() {}, warn() {} },
        rateLimit,
        HUB_RATE_LIMIT_RPM: opts.rpm === undefined ? 100 : opts.rpm,
        HUB_RATE_LIMIT_EXEMPT_LOCAL: opts.exemptLocal === undefined ? true : opts.exemptLocal
    });
    app.get('/hub-db/snapshot/:table', (req, res) => res.json({ table: req.params.table, rows: [], count: 0 }));
    app.post('/', (req, res) => res.json({ jsonrpc: '2.0', id: req.body.id, result: { accepted: true } }));
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

function request(options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// One mirror-bootstrap page read, shaped like the indexer's: since_id/limit query and all.
function drainPage(sinceId, headers) {
    return request({
        hostname: '127.0.0.1', port, method: 'GET',
        path: '/hub-db/snapshot/price_snapshots?since_id=' + sinceId + '&limit=10000',
        headers: Object.assign({}, headers || {})
    });
}

function post(id, headers) {
    const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'getallconfigs', params: {} });
    return request({
        hostname: '127.0.0.1', port, path: '/', method: 'POST',
        headers: Object.assign({
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
        }, headers || {})
    }, body);
}

function acceptsABootstrapPageRead() {
    expect(isSnapshotRequest({ originalUrl: '/hub-db/snapshot/price_snapshots?since_id=0&limit=10000' })).to.equal(true);
    expect(isSnapshotRequest({ url: '/hub-db/snapshot/oracle_prices' })).to.equal(true);
    expect(isSnapshotRequest({ originalUrl: SNAPSHOT_PATH_PREFIX })).to.equal(true);
}

function refusesAPathThatMerelyStartsTheSame() {
    expect(isSnapshotRequest({ originalUrl: '/hub-db/snapshotting' })).to.equal(false);
    expect(isSnapshotRequest({ originalUrl: '/hub-db/snapshot-admin/x' })).to.equal(false);
}

function refusesTheJsonRpcSurface() {
    expect(isSnapshotRequest({ originalUrl: '/' })).to.equal(false);
    expect(isSnapshotRequest({ originalUrl: '/health' })).to.equal(false);
}

function failsClosedOnAnUnreadablePath() {
    // The general limiter consults this FIRST, so a request whose path cannot be read must
    // stay on the smaller budget rather than fall through into the bootstrap one.
    for (const req of [undefined, null, {}, { url: 42 }, { originalUrl: {} }]) {
        expect(isSnapshotRequest(req)).to.equal(false);
    }
}

function takesAPositiveOperatorValue() {
    expect(parseSnapshotRpm('900')).to.equal(900);
    expect(parseSnapshotRpm(1200)).to.equal(1200);
}

function fallsBackToTheMeasuredDefault() {
    expect(DEFAULT_SNAPSHOT_RPM).to.equal(600);
    for (const raw of [undefined, null, '', '   ', 'abc', '0', '-5']) {
        expect(parseSnapshotRpm(raw), String(raw)).to.equal(DEFAULT_SNAPSHOT_RPM);
    }
}

function handsTheSnapshotFamilyToTheOtherBucket() {
    const opts = buildRateLimitOptions({ rpm: 100, skipPath: isSnapshotRequest, exemptLocal: false });
    expect(opts.skip({ ip: PUBLIC_IP, originalUrl: '/hub-db/snapshot/price_snapshots?since_id=0' })).to.equal(true);
    expect(opts.skip({ ip: PUBLIC_IP, originalUrl: '/' })).to.equal(false);
}

async function completesTheMeasuredBootstrapBurst() {
    // 192 page reads from ONE public address inside one window: three mirrors at about 32
    // requests for a full ten-table bootstrap, attempted twice inside the minute because a
    // partial bootstrap retries every 30s. That is the load that wedged the fleet against a
    // shared 100 req/min budget.
    await boot({});
    for (let i = 1; i <= 192; i++) {
        const res = await drainPage(i, PUBLIC);
        expect(res.status, 'page ' + i).to.equal(200);
    }
    const last = await drainPage(193, PUBLIC);
    expect(last.status).to.equal(200);
    expect(last.headers['ratelimit-limit']).to.equal(String(DEFAULT_SNAPSHOT_RPM));
}

async function drainsWhenTheJsonRpcBudgetIsSpent() {
    // The starvation itself: ordinary polling had eaten the shared budget before the drain
    // got a turn, so every page read 429ed although the drain was small.
    await boot({ rpm: 2 });
    expect((await post(1, PUBLIC)).status).to.equal(200);
    expect((await post(2, PUBLIC)).status).to.equal(200);
    expect((await post(3, PUBLIC)).status).to.equal(429);
    for (let i = 1; i <= 40; i++) {
        expect((await drainPage(i, PUBLIC)).status, 'page ' + i).to.equal(200);
    }
}

async function stillThrottlesAPublicJsonRpcCaller() {
    // The side effect the split exists to avoid: raising one shared limit to fit the drain
    // would have taken this throttle off every open read.
    await boot({});
    for (let i = 1; i <= 100; i++) {
        expect((await post(i, PUBLIC)).status, 'call ' + i).to.equal(200);
    }
    const limited = await post(101, PUBLIC);
    expect(limited.status).to.equal(429);
    expect(limited.headers['ratelimit-limit']).to.equal('100');
    const parsed = JSON.parse(limited.body);
    expect(parsed.error.code).to.equal(RATE_LIMIT_RPC_ERROR_CODE);
    expect(parsed.error.message).to.contain('HUB_RATE_LIMIT_RPM');
    expect(parsed.id).to.equal(101);
}

async function boundsTheSnapshotFamilyToo() {
    await boot({ snapshotRpm: '3' });
    for (let i = 1; i <= 3; i++) {
        expect((await drainPage(i, PUBLIC)).status, 'page ' + i).to.equal(200);
    }
    const limited = await drainPage(4, PUBLIC);
    expect(limited.status).to.equal(429);
    expect(limited.headers['content-type']).to.contain('application/json');
    expect(limited.headers['retry-after']).to.equal('60');
    expect(limited.headers['ratelimit-limit']).to.equal('3');
    // REST shape, not a JSON-RPC envelope: nothing on this path speaks JSON-RPC.
    const parsed = JSON.parse(limited.body);
    expect(parsed.jsonrpc).to.equal(undefined);
    expect(parsed.error).to.contain('HUB_SNAPSHOT_RATE_LIMIT_RPM');
    expect(parsed.error).to.contain('3 requests per 60s');
    expect(parsed.data.limit).to.equal(3);
}

async function leavesJsonRpcCallableWhenADrainIsSpent() {
    await boot({ snapshotRpm: '2' });
    expect((await drainPage(1, PUBLIC)).status).to.equal(200);
    expect((await drainPage(2, PUBLIC)).status).to.equal(200);
    expect((await drainPage(3, PUBLIC)).status).to.equal(429);
    expect((await post(1, PUBLIC)).status).to.equal(200);
}

async function doesNotCountACoLocatedMirror() {
    // The docker-bridge case that already worked keeps working: no X-Forwarded-For, so
    // req.ip is the loopback socket address and the exemption covers it.
    await boot({ snapshotRpm: '2' });
    for (let i = 1; i <= 10; i++) {
        expect((await drainPage(i)).status, 'page ' + i).to.equal(200);
    }
    await shutdown();
    await boot({ snapshotRpm: '2', exemptLocal: false });
    expect((await drainPage(1)).status).to.equal(200);
    expect((await drainPage(2)).status).to.equal(200);
    expect((await drainPage(3)).status).to.equal(429);
}

function isSnapshotRequestSuite() {
    it('accepts a bootstrap page read with its query string', acceptsABootstrapPageRead);
    it('refuses a path that merely starts with the same letters', refusesAPathThatMerelyStartsTheSame);
    it('refuses the JSON-RPC surface and anything else', refusesTheJsonRpcSurface);
    it('fails closed on a request with no readable path', failsClosedOnAnUnreadablePath);
}

function parseSnapshotRpmSuite() {
    it('takes a positive operator value', takesAPositiveOperatorValue);
    it('falls back to the measured default on anything unset or unusable', fallsBackToTheMeasuredDefault);
}

function generalLimiterSuite() {
    it('hands the snapshot family to the other bucket instead of charging its own', handsTheSnapshotFamilyToTheOtherBucket);
}

function drivenSuite() {
    this.timeout(30000);
    afterEach(shutdown);
    it('completes the measured bootstrap burst at shipped defaults', completesTheMeasuredBootstrapBurst);
    it('drains even when the JSON-RPC budget is already spent', drainsWhenTheJsonRpcBudgetIsSpent);
    it('still throttles a public JSON-RPC caller at the shipped 100 req/min', stillThrottlesAPublicJsonRpcCaller);
    it('bounds the snapshot family too, and names the knob that raises it', boundsTheSnapshotFamilyToo);
    it('leaves JSON-RPC callable when a drain has spent its own budget', leavesJsonRpcCallableWhenADrainIsSpent);
    it('does not count a co-located mirror, and does once the exemption is off', doesNotCountACoLocatedMirror);
}

function mirrorBootstrapRateLimitSuite() {
    describe('isSnapshotRequest', isSnapshotRequestSuite);
    describe('parseSnapshotRpm', parseSnapshotRpmSuite);
    describe('the general limiter', generalLimiterSuite);
    describe('driven through the real middleware', drivenSuite);
}

describe('hub mirror-bootstrap rate limit', mirrorBootstrapRateLimitSuite);
