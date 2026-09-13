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

// Per-IP rate-limit policy.
//
// The two failures this covers were MEASURED on 2026-08-27 driving a chain-only
// node's price-history recovery at the shipped HUB_RATE_LIMIT_RPM default of 100:
//
//   1. the 429 came back as express-rate-limit's default text/html string, which
//      every JSON-RPC client on this surface reported as "Invalid JSON response:
//      Unexpected token 'T'" - naming neither the throttle nor the limit;
//   2. the guard fired on the node's OWN indexer, reaching its own hub container
//      over the docker bridge, so a supported recovery path only ran with the
//      limit raised to 60000 by hand.
//
// The live-server section is deliberately end to end through real
// express + express-rate-limit rather than asserting on the options object
// alone: the bug was never in the options we intended, it was in what the
// middleware actually put on the wire.

const { expect } = require('chai');
const sinon      = require('sinon');
const express    = require('express');
const rateLimit  = require('express-rate-limit');
const http       = require('http');
const proxyquire = require('proxyquire').noPreserveCache();
const { waitUntil } = require('../helpers/waitUntil');

const policy = require('../../src/lib/rate_limit_policy.js');
const { buildRateLimitOptions, isLocalCaller, normalizeIp, parseExemptLocal,
        RATE_LIMIT_RPC_ERROR_CODE } = policy;

describe('hub per-IP rate-limit policy', function () {

    afterEach(function () { sinon.restore(); });

    describe('normalizeIp', function () {
        it('unwraps a v4-mapped IPv6 address', function () {
            expect(normalizeIp('::ffff:127.0.0.1')).to.equal('127.0.0.1');
            expect(normalizeIp('::ffff:172.17.0.4')).to.equal('172.17.0.4');
        });
        it('strips an IPv6 zone index', function () {
            expect(normalizeIp('fe80::1%eth0')).to.equal('fe80::1');
        });
        it('returns empty string for anything that is not a usable address', function () {
            for (const bad of [undefined, null, 42, {}, '', '   ']) expect(normalizeIp(bad)).to.equal('');
        });
    });

    describe('isLocalCaller', function () {
        it('treats the whole 127.0.0.0/8 loopback block as local, not just 127.0.0.1', function () {
            expect(isLocalCaller('127.0.0.1')).to.equal(true);
            expect(isLocalCaller('127.13.9.200')).to.equal(true);
            expect(isLocalCaller('::1')).to.equal(true);
            expect(isLocalCaller('::ffff:127.0.0.1')).to.equal(true);
        });

        // This is the case the whole exemption exists for: xchain-node points the
        // indexer at http://<hub-container>:10000, so the hub sees a docker bridge
        // address. Loopback alone would have fixed nothing.
        it('treats docker-bridge and RFC1918 addresses as local', function () {
            for (const ip of ['172.17.0.4', '172.31.255.254', '10.0.0.9', '10.255.255.255',
                              '192.168.1.20', '169.254.7.7']) {
                expect(isLocalCaller(ip), ip).to.equal(true);
            }
        });

        it('treats IPv6 unique-local and link-local as local', function () {
            expect(isLocalCaller('fd00::1')).to.equal(true);
            expect(isLocalCaller('fc00::abcd')).to.equal(true);
            expect(isLocalCaller('fe80::42:acff:fe11:2')).to.equal(true);
        });

        it('does NOT exempt public addresses', function () {
            for (const ip of ['8.8.8.8', '203.0.113.7', '172.32.0.1', '172.15.255.255',
                              '11.0.0.1', '192.169.0.1', '2606:4700::1111']) {
                expect(isLocalCaller(ip), ip).to.equal(false);
            }
        });

        it('fails closed on an unparseable address', function () {
            for (const bad of [undefined, null, '', 'not-an-ip', '999.1.1.1', '1.2.3', '::']) {
                expect(isLocalCaller(bad), String(bad)).to.equal(false);
            }
        });
    });

    describe('parseExemptLocal', function () {
        it('defaults ON when unset or blank', function () {
            for (const raw of [undefined, null, '', '   ']) expect(parseExemptLocal(raw)).to.equal(true);
        });
        it('accepts the usual off spellings', function () {
            for (const raw of ['false', 'FALSE', '0', 'no', 'off', ' Off ']) {
                expect(parseExemptLocal(raw), raw).to.equal(false);
            }
        });
        it('anything else leaves the exemption on', function () {
            for (const raw of ['true', '1', 'yes']) expect(parseExemptLocal(raw)).to.equal(true);
        });
    });

    describe('buildRateLimitOptions', function () {
        it('carries the rpm through as the express-rate-limit limit', function () {
            const opts = buildRateLimitOptions({ rpm: 250, windowMs: 60000 });
            expect(opts.limit).to.equal(250);
            expect(opts.windowMs).to.equal(60000);
            expect(opts.standardHeaders).to.equal(true);
            expect(opts.legacyHeaders).to.equal(false);
        });

        it('falls back to 100 req/60s on a garbage or non-positive rpm', function () {
            for (const rpm of [undefined, null, NaN, 0, -5, 'lots']) {
                expect(buildRateLimitOptions({ rpm }).limit, String(rpm)).to.equal(100);
            }
            expect(buildRateLimitOptions({ windowMs: 0 }).windowMs).to.equal(60000);
        });

        it('skips local callers by default and never skips public ones', function () {
            const { skip } = buildRateLimitOptions({});
            expect(skip({ ip: '172.17.0.4' })).to.equal(true);
            expect(skip({ ip: '127.0.0.1' })).to.equal(true);
            expect(skip({ ip: '203.0.113.7' })).to.equal(false);
            expect(skip({})).to.equal(false);
        });

        it('enforces on every caller when exemptLocal is off', function () {
            const { skip } = buildRateLimitOptions({ exemptLocal: false });
            expect(skip({ ip: '172.17.0.4' })).to.equal(false);
            expect(skip({ ip: '127.0.0.1' })).to.equal(false);
        });

        function driveHandler(opts, req) {
            const res = {
                statusCode: 200, headers: {},
                setHeader (k, v) { this.headers[k.toLowerCase()] = v; },
                status (code) { this.statusCode = code; return this; },
                json (body) { this.body = body; return this; }
            };
            opts.handler(req, res);
            return res;
        }

        it('answers 429 with a JSON-RPC error envelope naming the limit', function () {
            const opts = buildRateLimitOptions({ rpm: 100, windowMs: 60000 });
            const res  = driveHandler(opts, { ip: '203.0.113.7', body: { jsonrpc: '2.0', id: 77, method: 'pushpricebatch' } });

            expect(res.statusCode).to.equal(429);
            expect(res.body.jsonrpc).to.equal('2.0');
            expect(res.body.id).to.equal(77);
            expect(res.body.error.code).to.equal(RATE_LIMIT_RPC_ERROR_CODE);
            expect(res.body.error.message).to.contain('rate limit exceeded');
            expect(res.body.error.message).to.contain('100 requests per 60s');
            expect(res.body.error.message).to.contain('HUB_RATE_LIMIT_RPM');
            expect(res.body.error.data).to.deep.include({
                limit: 100, windowMs: 60000, retryAfterSeconds: 60, policy: 'per-ip', env: 'HUB_RATE_LIMIT_RPM'
            });
            expect(res.headers['retry-after']).to.equal('60');
        });

        it('echoes a null id for a batch or bodyless request rather than inventing one', function () {
            const opts = buildRateLimitOptions({});
            expect(driveHandler(opts, { ip: '8.8.8.8', body: [{ id: 1 }, { id: 2 }] }).body.id).to.equal(null);
            expect(driveHandler(opts, { ip: '8.8.8.8' }).body.id).to.equal(null);
            expect(driveHandler(opts, { ip: '8.8.8.8', body: { id: { nested: true } } }).body.id).to.equal(null);
        });

        it('notifies onLimited once per rejection and never lets it break the response', function () {
            const onLimited = sinon.stub();
            const res = driveHandler(buildRateLimitOptions({ rpm: 7, onLimited }), { ip: '8.8.8.8', body: {} });
            expect(onLimited.calledOnce).to.equal(true);
            expect(onLimited.firstCall.args[0]).to.include({ limit: 7 });
            expect(res.statusCode).to.equal(429);

            const thrower = sinon.stub().throws(new Error('log sink down'));
            const res2 = driveHandler(buildRateLimitOptions({ rpm: 7, onLimited: thrower }), { ip: '8.8.8.8', body: {} });
            expect(res2.statusCode).to.equal(429);
            expect(res2.body.error.code).to.equal(RATE_LIMIT_RPC_ERROR_CODE);
        });
    });

    // End to end through the real middleware: the defect was in what went on the
    // wire, so asserting on the options object alone would not have caught it.
    describe('live express server', function () {
        this.timeout(10000);

        let server, port;

        function boot(opts, trustProxy) {
            return new Promise((resolve) => {
                const app = express();
                app.set('trust proxy', trustProxy);
                app.use(express.json());
                app.use(rateLimit(buildRateLimitOptions(opts)));
                app.post('/', (req, res) => res.json({ jsonrpc: '2.0', id: req.body.id, result: { accepted: true } }));
                server = app.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
            });
        }

        function post(id, headers) {
            return new Promise((resolve, reject) => {
                const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'pushpricebatch', params: {} });
                const req = http.request({
                    hostname: '127.0.0.1', port, path: '/', method: 'POST',
                    headers: Object.assign({
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body)
                    }, headers || {})
                }, (res) => {
                    let data = '';
                    res.on('data', (c) => { data += c; });
                    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
                });
                req.on('error', reject);
                req.write(body);
                req.end();
            });
        }

        afterEach(function (done) {
            if (!server) return done();
            server.close(() => { server = null; done(); });
        });

        it('a throttled public caller gets a 429 the client can JSON.parse', async function () {
            // trust proxy 'loopback' only, so the XFF from our loopback socket
            // resolves req.ip to the public address and the exemption misses it.
            await boot({ rpm: 2, windowMs: 60000 }, 'loopback');
            const xff = { 'X-Forwarded-For': '203.0.113.7' };

            expect((await post(1, xff)).status).to.equal(200);
            expect((await post(2, xff)).status).to.equal(200);

            const limited = await post(3, xff);
            expect(limited.status).to.equal(429);
            expect(limited.headers['content-type']).to.contain('application/json');
            expect(limited.headers['retry-after']).to.equal('60');
            expect(limited.headers['ratelimit-limit']).to.equal('2');

            // The whole point: without the JSON-RPC envelope this line throws on "Too many requests, ...".
            const parsedBody = JSON.parse(limited.body);
            expect(parsedBody.error.code).to.equal(RATE_LIMIT_RPC_ERROR_CODE);
            expect(parsedBody.error.message).to.contain('2 requests per 60s');
            expect(parsedBody.error.data.limit).to.equal(2);
            expect(parsedBody.id).to.equal(3);
        });

        // The verify condition: a chain-only node replaying a
        // batch-bearing chain pushes far more than the cap, and must not be
        // throttled by its own hub at shipped defaults.
        it('a loopback caller replaying far past the cap is never throttled', async function () {
            await boot({ rpm: 2, windowMs: 60000 }, 'loopback, uniquelocal');
            for (let i = 1; i <= 25; i++) {
                const res = await post(i);
                expect(res.status, 'push ' + i).to.equal(200);
                expect(JSON.parse(res.body).result.accepted).to.equal(true);
            }
        });

        it('the same replay IS throttled once the operator turns the exemption off', async function () {
            await boot({ rpm: 2, windowMs: 60000, exemptLocal: false }, 'loopback, uniquelocal');
            expect((await post(1)).status).to.equal(200);
            expect((await post(2)).status).to.equal(200);
            const limited = await post(3);
            expect(limited.status).to.equal(429);
            expect(JSON.parse(limited.body).error.code).to.equal(RATE_LIMIT_RPC_ERROR_CODE);
        });
    });

    // api.js self-starts on require, so the only way to assert its wiring is to
    // boot it under proxyquire and read what it handed express-rate-limit.
    describe('api.js wiring', function () {
        this.timeout(10000);

        async function bootApiCapturingLimiter(env) {
            const mockApp = {
                use: sinon.stub(), get: sinon.stub(), post: sinon.stub(), set: sinon.stub(),
                listen: sinon.stub().callsFake((p, h, cb) => { if (cb) cb(); })
            };
            const mockServer = { listen: sinon.stub().callsFake((p, h, cb) => { if (cb) cb(); }), on: sinon.stub() };
            const mockExpress = sinon.stub().returns(mockApp);
            mockExpress.json = sinon.stub().returns(function expressJson() {});
            const rateLimitStub = sinon.stub().returns(function rateLimitMw() {});
            const mockHub = new Proxy({}, {
                get: (t, p) => { if (!(p in t)) t[p] = sinon.stub().callsFake(async () => ({})); return t[p]; }
            });

            const keys = ['HUB_API_KEY', 'HUB_ALLOW_UNAUTHENTICATED', 'HUB_RATE_LIMIT_RPM',
                          'HUB_RATE_LIMIT_EXEMPT_LOCAL', 'HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME',
                          'HUB_DB_USER', 'HUB_DB_PASS', 'HUB_PORT'];
            const saved = {};
            for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
            Object.assign(process.env, {
                HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
                HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9999',
                HUB_API_KEY: 'test-hub-key'
            }, env);
            try {
                proxyquire('../../src/api', {
                    'dotenv': { config: sinon.stub() },
                    'express': mockExpress,
                    'helmet': sinon.stub().returns(function helmetMw() {}),
                    'cors': sinon.stub().returns(function corsMw() {}),
                    'express-rate-limit': rateLimitStub,
                    'express-json-rpc-router': sinon.stub().returns(function routerMw() {}),
                    'http': { createServer: sinon.stub().returns(mockServer) },
                    'ws': { Server: sinon.stub().returns({ on: sinon.stub() }) },
                    'geoip-lite': { lookup: sinon.stub().returns(null) },
                    './XChainHub': function () { return mockHub; }
                });
            } finally {
                for (const [k, v] of Object.entries(saved)) {
                    if (v === undefined) delete process.env[k]; else process.env[k] = v;
                }
            }
            await waitUntil(() => rateLimitStub.called, { label: 'api.js boot to install the rate limiter' });
            return rateLimitStub.firstCall.args[0];
        }

        it('installs the policy options, exemption on, at the shipped default of 100', async function () {
            const opts = await bootApiCapturingLimiter({});
            expect(opts.limit).to.equal(100);
            expect(opts.windowMs).to.equal(60000);
            expect(opts.skip({ ip: '172.17.0.4' })).to.equal(true);
            expect(opts.skip({ ip: '203.0.113.7' })).to.equal(false);
            expect(typeof opts.handler).to.equal('function');
        });

        it('honours HUB_RATE_LIMIT_RPM and HUB_RATE_LIMIT_EXEMPT_LOCAL=false', async function () {
            const opts = await bootApiCapturingLimiter({
                HUB_RATE_LIMIT_RPM: '4200', HUB_RATE_LIMIT_EXEMPT_LOCAL: 'false'
            });
            expect(opts.limit).to.equal(4200);
            expect(opts.skip({ ip: '172.17.0.4' })).to.equal(false);
        });
    });
});
