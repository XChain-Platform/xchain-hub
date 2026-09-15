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
const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
const { DB_METHODS } = require('../helpers/mockHub');
const { waitUntil }        = require('../helpers/waitUntil');
let controller;
let routes = {};
let hubStub;

// =================================================================
// API: Input validation helpers
// =================================================================
// We test the validation functions by capturing the controller via proxyquire
// The since_id guard lives on the REST snapshot routes, not on a JSON-RPC
// method, so the route handlers are captured the same way the methods are.
// The hub stub itself, so a test can assert what the controller forwarded.
function createApiMocks() {
    let mockApp = {
        use: sinon.stub(),
        get: sinon.stub().callsFake((path, handler) => { routes[path] = handler; }),
        post: sinon.stub(),
        set: sinon.stub(),
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); })
    };
    let mockServer = {
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); }),
        on: sinon.stub()
    };
    return {
        mockExpress: Object.assign(sinon.stub().returns(mockApp), { json: sinon.stub().returns(sinon.stub()) }),
        mockHttp: { createServer: sinon.stub().returns(mockServer) },
        mockWsLib: { Server: sinon.stub().returns({ on: sinon.stub() }) }
    };
}
function createApiHubStub() {
    return {
        start: sinon.stub().resolves(),
        startP2P: sinon.stub().resolves(),
        startConsensus: sinon.stub().resolves(),
        startOracle: sinon.stub().resolves(),
        startCrossChain: sinon.stub().resolves(),
        startReorgHandler: sinon.stub().resolves(),
        startGovernance: sinon.stub().resolves(),
        startAttestation: sinon.stub().resolves(),
        startCapabilities: sinon.stub().resolves(),
        getPriceSnapshots: sinon.stub().resolves([]),
        // The with_watermark envelope carries the price-age bound the hub
        // resolves for getprice; a fixed stand-in here, asserted below.
        oracleMaxAgeSeconds: sinon.stub().returns(900),
        getPrice: sinon.stub().resolves(null),
        getFeeQuote: sinon.stub().resolves({}),
        getOracle: sinon.stub().returns(null),
        getCrossChain: sinon.stub().returns(null),
        getAllConfigs: sinon.stub().resolves({}),
        getValidators: sinon.stub().resolves([]),
        getReorgHistory: sinon.stub().resolves([]),
        getSwaps: sinon.stub().resolves([]),
        // Records the index the controller forwarded, so the well-formed case can
        // assert the exact integer reaches the engine rather than a coerced one.
        initiateSwap: sinon.stub().resolves(),
        getSwap: sinon.stub().resolves({ source_chain: 'BTC', source_action_index: 7 }),
        requestAttestation: sinon.stub().resolves({ status: 'attested' }),
        reportReorg: sinon.stub().resolves(),
        db: { ...DB_METHODS, setChainTip: sinon.stub().resolves(), doQuery: sinon.stub().resolves([]) }
    };
}
function setRequiredEnvironment() {
    // Set required env vars temporarily
    let original = {};
    let required = {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
        HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9999',
        // A keyless boot refuses unless keyless is declared, and this
        // harness boots keyless on purpose (it drives the RPC controller
        // directly, not the auth middleware).
        HUB_ALLOW_UNAUTHENTICATED: 'true'
    };
    for (let [key, value] of Object.entries(required)) {
        original[key] = process.env[key];
        process.env[key] = value;
    }
    return function restoreEnvironment() {
        for (let [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
}
async function setupApiController() {
    let { mockExpress, mockHttp, mockWsLib } = createApiMocks();
    let mockHub = createApiHubStub();
    let capturedMethods;
    let jsonRouterStub = function ({ methods }) {
        capturedMethods = methods;
        return sinon.stub();
    };
    let restoreEnvironment = setRequiredEnvironment();
    try {
        proxyquire('../../src/api', {
            'dotenv': { config: sinon.stub() },
            'express': mockExpress,
            'helmet': sinon.stub().returns(sinon.stub()),
            'cors': sinon.stub().returns(sinon.stub()),
            'express-rate-limit': sinon.stub().returns(sinon.stub()),
            'express-json-rpc-router': jsonRouterStub,
            'http': mockHttp,
            'ws': mockWsLib,
            'geoip-lite': { lookup: sinon.stub().returns(null) },
            './XChainHub': function () { return mockHub; }
        });
    } finally {
        restoreEnvironment();
    }
    // The JSON-RPC router receives the method table at the end of the async
    // startApi(), so its arrival is what "boot finished" means here.
    await waitUntil(() => capturedMethods, { label: 'api.js boot to register its JSON-RPC methods' });
    controller = capturedMethods;
    hubStub = mockHub;
}
function registerApiValidationTests1() {
it('getfeequote rejects invalid chain', async function () {
            let result = await controller.getfeequote({ action: 'ISSUE', chain: 'ETH' });
            expect(result.error).to.include('BTC');
        });
        it('getfeequote accepts valid chain', async function () {
            let result = await controller.getfeequote({ action: 'ISSUE', chain: 'BTC' });
            expect(result.error).to.be.undefined;
        });
        it('getpricesnapshots rejects negative limit', async function () {
            let result = await controller.getpricesnapshots({ limit: -5 });
            expect(result.error).to.include('limit');
        });
        it('getpricesnapshots rejects limit over the cap', async function () {
            // validateLimit caps at 10000 (widened from 1000); use a value above the
            // current cap so this tracks the source bound instead of a stale literal.
            let result = await controller.getpricesnapshots({ limit: 10001 });
            expect(result.error).to.include('limit');
        });
        // parseInt admitted anything with an integer PREFIX, so these all passed
        // validation and then reached a `LIMIT ?` bind: '50junk' as 50, '1e3' as 1,
        // '50.5' as 50. Callers disagreed on whether the raw or the parsed value
        // was forwarded, so the public limit contract differed per method.
        ['50junk', '1e3', '50.5', '-5', ' 50', '0x32', ''].forEach((bad) => {
            it(`getpricesnapshots rejects a partial-integer limit ${JSON.stringify(bad)}`, async function () {
                let result = await controller.getpricesnapshots({ limit: bad });
                expect(result.error).to.include('limit');
            });
        });
        it('getpricesnapshots rejects a fractional NUMBER limit', async function () {
            let result = await controller.getpricesnapshots({ limit: 50.5 });
            expect(result.error).to.include('limit');
        });
        it('getpricesnapshots still accepts a well-formed limit as string or number', async function () {
            expect(await controller.getpricesnapshots({ limit: '50' })).to.be.an('array');
            expect(await controller.getpricesnapshots({ limit: 50 })).to.be.an('array');
        });
        it('getpricesnapshots accepts limit = 1000', async function () {
            let result = await controller.getpricesnapshots({ limit: 1000 });
            expect(result).to.be.an('array');
        });
}
function registerApiValidationTests2() {
it('getpricesnapshots accepts no limit (defaults)', async function () {
            let result = await controller.getpricesnapshots({});
            expect(result).to.be.an('array');
        });
        it('getpricesnapshots rejects an unknown status filter', async function () {
            let result = await controller.getpricesnapshots({ limit: 10, status: 'bogus' });
            expect(result.error).to.include('status');
        });
        it("getpricesnapshots accepts status 'all' (health consumers)", async function () {
            let result = await controller.getpricesnapshots({ limit: 10, status: 'all' });
            expect(result).to.be.an('array');
        });
        // Freshness contract: opt-in server-clock watermark so the
        // dashboard's freshness thresholds are computed in the hub's clock
        // domain; omitted keeps the historical bare-array contract.
        it('getpricesnapshots with_watermark wraps rows with a server-clock watermark', async function () {
            let before = Math.floor(Date.now() / 1000);
            let result = await controller.getpricesnapshots({ limit: 10, with_watermark: 1 });
            let after = Math.floor(Date.now() / 1000);
            expect(result).to.be.an('object');
            expect(result.snapshots).to.be.an('array');
            expect(result.watermark).to.be.at.least(before);
            expect(result.watermark).to.be.at.most(after);
            // The price-age bound rides the same envelope, sourced from the hub
            // rather than a literal (the stub above returns 900).
            expect(result.oracleMaxPriceAgeSeconds).to.equal(900);
        });
        it('getpricesnapshots without with_watermark keeps the bare-array contract', async function () {
            let result = await controller.getpricesnapshots({ limit: 10 });
            expect(result).to.be.an('array');
        });
        it('reportreorg rejects invalid chain', async function () {
            let result = await controller.reportreorg({ chain: 'ETH', reorg_height: '100', timestamp: String(Date.now()) });
            expect(result.error).to.include('BTC');
        });
        it('reportreorg rejects negative reorg_height', async function () {
            let result = await controller.reportreorg({ chain: 'BTC', reorg_height: '-1', timestamp: String(Date.now()) });
            expect(result.error).to.include('non-negative integer');
        });
}
function registerApiValidationTests3() {
it('reportreorg rejects a prefix-coerced reorg_height rather than truncating it', async function () {
            for (let bad of ['850000junk', '8.5e5', '100.9']) {
                let result = await controller.reportreorg({
                    chain: 'BTC', reorg_height: bad, timestamp: String(Date.now()),
                    old_hash: 'a'.repeat(64), new_hash: 'b'.repeat(64)
                });
                expect(result.error, bad).to.include('reorg_height must be a non-negative integer');
            }
        });
        // timestamp had no API-layer guard at all: parseInt('abc') is NaN, forwarded straight in.
        it('reportreorg rejects a non-integer timestamp instead of forwarding NaN', async function () {
            for (let bad of ['abc', '1756900000junk', 1756900000.5]) {
                let result = await controller.reportreorg({
                    chain: 'BTC', reorg_height: '100', timestamp: bad,
                    old_hash: 'a'.repeat(64), new_hash: 'b'.repeat(64)
                });
                expect(result.error, String(bad)).to.include('timestamp must be a non-negative integer');
            }
        });
        it('getreorghistory rejects limit over the cap', async function () {
            let result = await controller.getreorghistory({ limit: 10001 });
            expect(result.error).to.include('limit');
        });
        it('requestattestation rejects invalid source_chain', async function () {
            let result = await controller.requestattestation({ source_chain: 'ETH', source_action_index: 1, dest_chain: 'BTC' });
            expect(result.error).to.include('BTC');
        });
        it('initiateswap rejects invalid dest_chain', async function () {
            let result = await controller.initiateswap({ source_chain: 'BTC', source_action_index: 1, dest_chain: 'ETH' });
            expect(result.error).to.include('BTC');
        });
}
function registerApiValidationTests4() {
['7junk', '1e3', '7.5', '-7', ' 7', '0x7', '0'].forEach((bad) => {
            it(`initiateswap rejects a partial-integer source_action_index ${JSON.stringify(bad)}`, async function () {
                let result = await controller.initiateswap({ source_chain: 'BTC', source_action_index: bad, dest_chain: 'LTC' });
                expect(result.error).to.include('source_action_index');
            });
            it(`getswap rejects a partial-integer source_action_index ${JSON.stringify(bad)}`, async function () {
                let result = await controller.getswap({ source_chain: 'BTC', source_action_index: bad });
                expect(result.error).to.include('source_action_index');
            });
            // Same field, same band, on the entrypoint that opens a quorum round. The
            // engine's parseInt guard accepts a prefix, so without this gate '1e3' attests as
            // action 1 under the id BTC:1:LTC instead of erroring.
            it(`requestattestation rejects a partial-integer source_action_index ${JSON.stringify(bad)}`, async function () {
                let result = await controller.requestattestation({ source_chain: 'BTC', source_action_index: bad, dest_chain: 'LTC' });
                expect(result.error).to.include('source_action_index');
            });
            // The read side of the same field. It binds against the attestations BIGINT
            // column, which MariaDB coerces rather than rejects, so an ungated '1e3'
            // returned the attestation for action 1000 with no error at all.
            it(`getattestation rejects a partial-integer source_action_index ${JSON.stringify(bad)}`, async function () {
                let result = await controller.getattestation({ source_chain: 'BTC', source_action_index: bad });
                expect(result.error).to.include('source_action_index');
            });
        });
        it('getattestation rejects invalid source_chain', async function () {
            let result = await controller.getattestation({ source_chain: 'ETH', source_action_index: 1 });
            expect(result.error).to.include('BTC');
        });
        // Negative control for the two guards above: a well-formed call must reach
        // past them (the suite's hub stub returns no cross-chain engine, so the
        // handler's own downstream error is what proves validation did NOT fire).
        it('getattestation accepts a well-formed chain and index', async function () {
            let result = await controller.getattestation({ source_chain: 'BTC', source_action_index: '7' });
            expect(result.error).to.not.include('source_action_index');
            expect(result.error).to.not.include('chain must be one of');
        });
        it('initiateswap rejects a partial-integer dest_action_index', async function () {
            let result = await controller.initiateswap({
                source_chain: 'BTC', source_action_index: 7, dest_chain: 'LTC', dest_action_index: '9junk'
            });
            expect(result.error).to.include('dest_action_index');
        });
}
function registerApiValidationTests5() {
it('initiateswap forwards the exact integer, string or number', async function () {
            expect(await controller.initiateswap({ source_chain: 'BTC', source_action_index: '7', dest_chain: 'LTC' }))
                .to.deep.equal({ status: 'success' });
            expect(await controller.initiateswap({ source_chain: 'BTC', source_action_index: 7, dest_chain: 'LTC', dest_action_index: 9 }))
                .to.deep.equal({ status: 'success' });
        });
        it('getswap accepts a well-formed index', async function () {
            let result = await controller.getswap({ source_chain: 'BTC', source_action_index: '7' });
            expect(result.error).to.be.undefined;
        });
        it('requestattestation forwards the exact integer, string or number', async function () {
            hubStub.requestAttestation.resetHistory();
            expect(await controller.requestattestation({ source_chain: 'BTC', source_action_index: '1000', dest_chain: 'LTC' }))
                .to.deep.equal({ status: 'attested' });
            expect(hubStub.requestAttestation.lastCall.args).to.deep.equal(['BTC', 1000, 'LTC']);
            expect(await controller.requestattestation({ source_chain: 'BTC', source_action_index: 42, dest_chain: 'LTC' }))
                .to.deep.equal({ status: 'attested' });
            expect(hubStub.requestAttestation.lastCall.args).to.deep.equal(['BTC', 42, 'LTC']);
        });
        ['850000junk', '1e3', '850000.9', ' 850000', '0x32'].forEach((bad) => {
            it(`pushchaintip rejects a partial-integer block_height ${JSON.stringify(bad)}`, async function () {
                let result = await controller.pushchaintip({ coin: 'BTC', network: 'mainnet', block_height: bad, block_time: 1700000000 });
                expect(result.error).to.include('invalid block_height');
            });
            it(`pushchaintip rejects a partial-integer block_time ${JSON.stringify(bad)}`, async function () {
                let result = await controller.pushchaintip({ coin: 'BTC', network: 'mainnet', block_height: 850000, block_time: bad });
                expect(result.error).to.include('invalid block_time');
            });
        });
        it('pushchaintip still accepts the shapes the indexer sends', async function () {
            expect(await controller.pushchaintip({ coin: 'BTC', network: 'mainnet', block_height: 850000, block_time: 1700000000 }))
                .to.deep.equal({ status: 'success' });
            expect(await controller.pushchaintip({ coin: 'BTC', network: 'mainnet', block_height: '850000', block_time: '1700000000' }))
                .to.deep.equal({ status: 'success' });
        });
}
function registerApiValidationTests6() {
describe('since_id on the snapshot routes', function () {
            let route;
            // Mirrors the slice of the express response the snapshot routes actually
            // use. The success path serializes itself and ships the string through
            // type().send() so a BIGINT column can go out as a string, which json()
            // cannot do, so a double carrying only status()/json() sends the route
            // into its own catch and reports a 500 that the route never chose.
            let fakeRes = () => {
                let out = { code: null, body: null, contentType: null };
                out.status = (c) => { out.code = c; return out; };
                out.json = (b) => { out.body = b; return out; };
                out.type = (t) => { out.contentType = t; return out; };
                out.send = (b) => { out.body = b; return out; };
                return out;
            };
            before(function () {
                route = routes['/hub-db/snapshot/price_snapshots'];
                expect(route, 'price_snapshots snapshot route registered').to.be.a('function');
            });
            ['5junk', '1e3', '5.5', '-5', ' 5', '0x32'].forEach((bad) => {
                it(`rejects a partial-integer since_id ${JSON.stringify(bad)}`, async function () {
                    let res = fakeRes();
                    await route({ query: { since_id: bad } }, res);
                    expect(res.code).to.equal(400);
                    expect(res.body.error).to.include('since_id');
                });
            });
            it('accepts a digit-only since_id and an omitted one', async function () {
                let res = fakeRes();
                await route({ query: { since_id: '1000' } }, res);
                expect(res.code).to.equal(null);
                let res2 = fakeRes();
                await route({ query: {} }, res2);
                expect(res2.code).to.equal(null);
            });
        });
}
function apiInputValidationSuite() {
        before(setupApiController);
        registerApiValidationTests1();
        registerApiValidationTests2();
        // parseInt took an integer PREFIX, so these reached hub.reportReorg as
        // 850000, 8 and 100 instead of an input error naming the bad field.
        registerApiValidationTests3();
        // The same integer-PREFIX hole validateLimit was hardened against, on the
        // three other fields that reach a write: the swap action indices (INSERTed
        // into swap_records), the chain tip (read by the staleness gates) and
        // since_id (paged from the truncated id). '7junk' recorded a swap against
        // action 7, '1e3' against action 1.
        registerApiValidationTests4();
        registerApiValidationTests5();
        registerApiValidationTests6();
    }
function securityHardeningSuite() {
    afterEach(function () {
        sinon.restore();
    });
    describe('API: Input validation helpers', apiInputValidationSuite);
}
describe('Security Hardening', securityHardeningSuite);
