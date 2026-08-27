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

// PRICE batch ingest: pushpricebatch JSON-RPC method (spec
// spec section 5.7, decision D22).
//
// Coverage:
//   - the method is registered in WRITE_METHODS (bulk-keyed like every other
//     forward write) and deliberately absent from REORG_WRITE_METHODS;
//   - the handler mirrors pushpriceround's validation and {error} convention;
//   - the handler delegates verification/storage to
//     hub.priceAggregator.receiveValidatedBatch and returns its result
//     verbatim.
//
// The aggregator is STUBBED here (sinon), never the real PriceAggregator:
// receiveValidatedBatch is being built in a parallel session and this suite
// must pass regardless of that work's state. This file only proves the RPC
// surface calls the contracted method with the contracted shape and returns
// what it gets back; the real batch-signature/dedupe behavior needs its own
// exercise once PriceAggregator.js lands receiveValidatedBatch for real.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();
const { waitUntil } = require('../helpers/waitUntil');

const KEY = 'test-hub-key';

// Boot src/api.js with everything heavy stubbed out. Captures both the
// app.use() middlewares (for the WRITE_METHODS/REORG_WRITE_METHODS auth
// checks) and the jsonRpcController methods object passed to
// express-json-rpc-router (for driving the handler directly). Pattern lifted
// from sensitiveReadAuth.test.js, which establishes that this is how api.js
// boots under proxyquire with no real DB/network.
async function bootApi(env, hubOverrides) {
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

    const mockHub = new Proxy(Object.assign({}, hubOverrides), {
        get: (target, prop) => {
            if (!(prop in target)) target[prop] = sinon.stub().callsFake(async () => ({}));
            return target[prop];
        }
    });

    let capturedController = null;
    const mockJsonRouter = sinon.stub().callsFake((opts) => {
        capturedController = opts.methods;
        return function routerMw() {};
    });

    const saved = {};
    for (const k of ['HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_SENSITIVE_READ_AUTH', 'HUB_ALLOW_UNAUTHENTICATED',
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
            'express-json-rpc-router': mockJsonRouter,
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
    // signal every app.use() middleware AND the jsonRouter({methods}) call
    // have both already happened; poll for it rather than guessing timing.
    await waitUntil(() => mockServer.listen.called, { label: 'api.js boot to reach server.listen' });

    function drive(mw, methodOrMethods, apiKey) {
        const res = {
            statusCode: 200,
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }
        };
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
    expect(capturedController, 'jsonRpcController not captured from jsonRouter({methods})').to.not.equal(null);
    return {
        request:      (method, apiKey)  => drive(authMw, method, apiKey),
        requestBatch: (methods, apiKey) => drive(authMw, methods, apiKey),
        controller:   capturedController,
        mockHub
    };
}

describe('hub pushpricebatch JSON-RPC (PRICE batch ingest, spec section 5.7)', function () {

    afterEach(function () { sinon.restore(); });

    describe('WRITE_METHODS / REORG_WRITE_METHODS registration', function () {

        it('is bulk-keyed like every other forward write (registered in WRITE_METHODS)', async function () {
            const api = await bootApi({ HUB_API_KEY: KEY });
            expect(api.request('pushpricebatch', undefined).res.statusCode).to.equal(401);
            expect(api.request('pushpricebatch', KEY).nexted).to.equal(true);
        });

        it('is NOT in REORG_WRITE_METHODS: the reorg key alone does not authorize it', async function () {
            const RKEY = 'test-reorg-key';
            const api = await bootApi({ HUB_API_KEY: KEY, HUB_REORG_API_KEY: RKEY });
            // The reorg key authorizes only pushpricereorg/pushxcallreorg/pushdexreorg;
            // pushpricebatch must still fall back to needing the BULK key.
            expect(api.request('pushpricebatch', RKEY).res.statusCode).to.equal(401);
            expect(api.request('pushpricebatch', KEY).nexted).to.equal(true);
        });

        it('keyless boot: pushpricebatch passes unauthenticated like other writes', async function () {
            const api = await bootApi({ HUB_ALLOW_UNAUTHENTICATED: 'true' });
            expect(api.request('pushpricebatch', undefined).nexted).to.equal(true);
        });
    });

    describe('handler validation (mirrors pushpriceround\'s {error} convention)', function () {
        let api;
        before(async function () {
            // priceAggregator.receiveValidatedBatch stubbed here too (see the
            // delegation describe() below for why): these tests only exercise
            // the validation guards ABOVE that call, so the stub's return value
            // does not matter beyond "not throwing".
            api = await bootApi({ HUB_ALLOW_UNAUTHENTICATED: 'true' },
                { priceAggregator: { receiveValidatedBatch: sinon.stub().resolves({ accepted: true, stored: 0, duplicates: 0, rejected: 0 }) } });
        });

        it('source_chain is required', async function () {
            const result = await api.controller.pushpricebatch({
                first_round: 1, last_round: 6, btc_block_height: 100, rounds: []
            });
            expect(result).to.deep.equal({ error: 'source_chain is required' });
        });

        it('source_chain must be an allowed chain', async function () {
            const result = await api.controller.pushpricebatch({
                source_chain: 'NOPE', first_round: 1, last_round: 6, btc_block_height: 100, rounds: []
            });
            expect(result.error).to.match(/chain must be one of/);
        });

        it('first_round is required', async function () {
            const result = await api.controller.pushpricebatch({
                source_chain: 'DOGE', last_round: 6, btc_block_height: 100, rounds: []
            });
            expect(result).to.deep.equal({ error: 'first_round is required' });
        });

        it('last_round is required', async function () {
            const result = await api.controller.pushpricebatch({
                source_chain: 'DOGE', first_round: 1, btc_block_height: 100, rounds: []
            });
            expect(result).to.deep.equal({ error: 'last_round is required' });
        });

        it('rounds must be an array', async function () {
            const result = await api.controller.pushpricebatch({
                source_chain: 'DOGE', first_round: 1, last_round: 6, btc_block_height: 100, rounds: 'not-an-array'
            });
            expect(result).to.deep.equal({ error: 'rounds must be an array' });
        });

        it('an empty rounds array passes validation (aggregator decides emptiness)', async function () {
            const result = await api.controller.pushpricebatch({
                source_chain: 'DOGE', first_round: 1, last_round: 6, btc_block_height: 100, rounds: []
            });
            // stub hub.priceAggregator (via the Proxy default) resolves {} - proves
            // the handler got past validation and called through.
            expect(result).to.not.have.property('error');
        });
    });

    describe('aggregator not ready', function () {
        it('returns {error} when hub.priceAggregator is unset', async function () {
            const api = await bootApi({ HUB_ALLOW_UNAUTHENTICATED: 'true' }, { priceAggregator: undefined });
            const result = await api.controller.pushpricebatch({
                source_chain: 'DOGE', first_round: 1, last_round: 6, btc_block_height: 100, rounds: []
            });
            expect(result).to.deep.equal({ error: 'price aggregator not ready' });
        });
    });

    describe('delegation to PriceAggregator.receiveValidatedBatch (stubbed)', function () {

        // This is the integration seam with the OTHER builder's PriceAggregator.js
        // work (spec item 11). The contract pinned in the batching spec
        // section 5.7 / decision D13: receiveValidatedBatch(source_chain, payload)
        // returns {accepted, stored, duplicates, rejected}, accepted iff every round
        // either stored or deduped. This suite stubs that method so it is green
        // whether or not PriceAggregator.js has landed the real implementation yet;
        // exercising the REAL aggregator behind pushpricebatch is not this suite's job.
        it('calls receiveValidatedBatch with source_chain and the mirrored+extended params', async function () {
            const receiveValidatedBatch = sinon.stub().resolves({ accepted: true, stored: 6, duplicates: 0, rejected: 0 });
            const api = await bootApi({ HUB_ALLOW_UNAUTHENTICATED: 'true' }, { priceAggregator: { receiveValidatedBatch } });

            const rounds = [{ round: 1, timestamp: 111, btc_block_height: 100, pairs: [{ pair: 'XCHAIN/USD', price: '1' }] }];
            const result = await api.controller.pushpricebatch({
                source_chain:     'DOGE',
                first_round:      1,
                last_round:       6,
                btc_block_height: 100,
                rounds:           rounds,
                block_time:       1735689600,
                sigs:             [{ pubkey: 'abc', sig: 'def' }],
                action_index:     42,
                block_index:      7,
                push_generation:  3
            });

            expect(receiveValidatedBatch.calledOnce).to.equal(true);
            const [sourceChainArg, payloadArg] = receiveValidatedBatch.firstCall.args;
            expect(sourceChainArg).to.equal('DOGE');
            expect(payloadArg).to.deep.equal({
                first_round:      1,
                last_round:       6,
                btc_block_height: 100,
                rounds:           rounds,
                block_time:       1735689600,
                sigs:             [{ pubkey: 'abc', sig: 'def' }],
                action_index:     42,
                block_index:      7,
                push_generation:  3
            });
            expect(result).to.deep.equal({ accepted: true, stored: 6, duplicates: 0, rejected: 0 });
        });

        it('returns the aggregator result verbatim on a partial-dedupe outcome', async function () {
            const receiveValidatedBatch = sinon.stub().resolves({ accepted: true, stored: 5, duplicates: 1, rejected: 0 });
            const api = await bootApi({ HUB_ALLOW_UNAUTHENTICATED: 'true' }, { priceAggregator: { receiveValidatedBatch } });
            const result = await api.controller.pushpricebatch({
                source_chain: 'DOGE', first_round: 1, last_round: 6, btc_block_height: 100, rounds: []
            });
            expect(result).to.deep.equal({ accepted: true, stored: 5, duplicates: 1, rejected: 0 });
        });

        it('returns the aggregator rejection verbatim on a signature/structural failure', async function () {
            const receiveValidatedBatch = sinon.stub().resolves({ accepted: false, stored: 0, duplicates: 0, rejected: 6 });
            const api = await bootApi({ HUB_ALLOW_UNAUTHENTICATED: 'true' }, { priceAggregator: { receiveValidatedBatch } });
            const result = await api.controller.pushpricebatch({
                source_chain: 'DOGE', first_round: 1, last_round: 6, btc_block_height: 100, rounds: []
            });
            expect(result).to.deep.equal({ accepted: false, stored: 0, duplicates: 0, rejected: 6 });
        });

        it('catches a thrown aggregator error into {error}, same convention as pushpriceround', async function () {
            const receiveValidatedBatch = sinon.stub().rejects(new Error('boom'));
            const api = await bootApi({ HUB_ALLOW_UNAUTHENTICATED: 'true' }, { priceAggregator: { receiveValidatedBatch } });
            const result = await api.controller.pushpricebatch({
                source_chain: 'DOGE', first_round: 1, last_round: 6, btc_block_height: 100, rounds: []
            });
            expect(result).to.deep.equal({ error: 'boom' });
        });
    });
});
