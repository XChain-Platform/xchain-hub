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

// An unknown chain on the four durable push handlers is a JSON-RPC error, not a result.
//
// express-json-rpc-router routes whatever a handler RETURNS into the envelope's `result`
// slot and only what it THROWS into `error`, so a refusal returned as { error: '...' }
// reached the caller as { result: { error: '...' } } and a caller that checks the
// envelope's `error` field alone read a refused push as an accepted one. pushchaintip
// already moved; these four carry the durable outbox, which is why they move together
// with the push client that learns the code.
//
// The split this file pins is what makes the change safe on the caller's side: a refusal
// of the CALL's own arguments throws -32602, because a queued row replays the same
// arguments into the same verdict forever, while a refusal that describes the HUB's state
// (an aggregator still booting) keeps its returned shape, because a later attempt clears it.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();
const { waitUntil } = require('../helpers/waitUntil');

// Boot src/api.js with everything heavy stubbed and capture the JSON-RPC method table
// handed to express-json-rpc-router, so each handler can be driven directly. Pattern
// lifted from pushPriceBatch.test.js.
async function bootApi(hubOverrides) {
    const mockApp = {
        use:  sinon.stub(),
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

    let controller = null;
    const saved = {};
    for (const k of ['HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_SENSITIVE_READ_AUTH', 'HUB_ALLOW_UNAUTHENTICATED',
                     'HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS',
                     'HUB_PORT', 'P2P_VALIDATOR_ADDR']) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    Object.assign(process.env, {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
        HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9999',
        HUB_ALLOW_UNAUTHENTICATED: 'true'
    });

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
    // server.listen() is the last step of the async boot IIFE, so it is the signal that
    // jsonRouter({ methods }) has already run; poll for it rather than guessing timing.
    await waitUntil(() => mockServer.listen.called, { label: 'api.js boot to reach server.listen' });
    return controller;
}

// Every payload below is otherwise well-formed, so nothing but the chain guard can be
// what refuses it: each names the engine the handler delegates to, so a refusal can be
// checked against "the engine was never called".
const HANDLERS = [
    {
        method: 'pushpriceround',
        engine: ['priceAggregator', 'receiveValidatedRound'],
        params: (chain) => ({ source_chain: chain, round: 42, timestamp: 1757298240, btc_block_height: 100, pairs: [] })
    },
    {
        method: 'pushpricebatch',
        engine: ['priceAggregator', 'receiveValidatedBatch'],
        params: (chain) => ({ source_chain: chain, first_round: 1, last_round: 6, btc_block_height: 100, rounds: [], block_time: 1757298240 })
    },
    {
        method: 'pushattestbatch',
        engine: ['attestationResponseMirror', 'receiveValidatedBatch'],
        params: (chain) => ({ source_chain: chain, network: 'regtest', window_start: 1, window_end: 6, row_count: 0, btc_block_height: 100, rows: [], sigs: [], block_time: 1757298240 })
    },
    {
        method: 'pushoracleprice',
        engine: ['priceAggregator', 'receiveOraclePrice'],
        params: (chain) => ({ source_chain: chain, source_address: 'addr1', coin: 'BTC', tick: 'XCP', fiat: 'USD', value: '1.00', block_time: 1757298240 })
    }
];

function freshEngines() {
    return {
        priceAggregator: {
            receiveValidatedRound: sinon.stub().resolves({ accepted: true }),
            receiveValidatedBatch: sinon.stub().resolves({ accepted: true }),
            receiveOraclePrice:    sinon.stub().resolves({ accepted: true })
        },
        attestationResponseMirror: {
            receiveValidatedBatch: sinon.stub().resolves({ accepted: true })
        }
    };
}

describe('durable push handlers: an unknown chain is a JSON-RPC error', function () {
    this.timeout(15000);

    let controller, engines;

    before(async function () {
        engines = freshEngines();
        controller = await bootApi(engines);
    });

    afterEach(function () {
        for (const group of Object.values(engines))
            for (const stub of Object.values(group)) stub.resetHistory();
    });

    after(function () { sinon.restore(); });

    // A PRESENT but unknown chain is what reaches validateChain. Casing matters ('btc' is
    // not 'BTC'), and a non-string is refused by the same guard rather than coerced.
    const UNKNOWN = ['ETH', 'btc', 'BTCX', 'BTC ', 'XCP', 42, {}, []];

    for (const h of HANDLERS) {
        describe(h.method, function () {

            for (const bad of UNKNOWN) {
                it('throws -32602 for chain ' + JSON.stringify(bad) + ' and calls no engine', async function () {
                    let thrown = null;
                    try {
                        await controller[h.method](h.params(bad));
                    } catch (err) { thrown = err; }
                    expect(thrown, 'an unknown chain must throw so the refusal lands in the error slot').to.be.an('error');
                    expect(thrown.code, 'the code is what lets a caller class this terminal').to.equal(-32602);
                    expect(thrown.message).to.equal('chain must be one of: BTC, LTC, DOGE');
                    expect(engines[h.engine[0]][h.engine[1]].called,
                        'a refused chain must never reach the engine').to.be.false;
                });
            }

            // The guard ABOVE validateChain, unchanged: a missing chain is still a returned
            // refusal, so an older caller reading the result envelope keeps working.
            for (const missing of ['', 0, null, undefined]) {
                it('still RETURNS the missing-chain refusal for ' + JSON.stringify(missing), async function () {
                    const result = await controller[h.method](h.params(missing));
                    expect(result).to.deep.equal({ error: 'source_chain is required' });
                });
            }

            for (const good of ['BTC', 'LTC', 'DOGE']) {
                it('still accepts ' + good, async function () {
                    const result = await controller[h.method](h.params(good));
                    expect(result).to.deep.equal({ accepted: true });
                    expect(engines[h.engine[0]][h.engine[1]].calledOnce, good + ' must still reach the engine').to.be.true;
                    expect(engines[h.engine[0]][h.engine[1]].firstCall.args[0]).to.equal(good);
                });
            }
        });
    }

    // The other half of the split, and the reason this cannot be a blanket conversion: a
    // refusal that describes the hub's own state is retryable, and the push client must go
    // on reading it out of the result envelope. Only the payload-keyed refusal throws.
    describe('a hub-state refusal keeps its returned shape', function () {
        let notReady;

        before(async function () {
            // Explicit nulls, so the harness Proxy does not auto-stub them into existence.
            notReady = await bootApi({ priceAggregator: null, attestationResponseMirror: null });
        });

        it('pushpriceround returns the aggregator-not-ready refusal', async function () {
            expect(await notReady.pushpriceround({ source_chain: 'BTC', round: 1, pairs: [] }))
                .to.deep.equal({ error: 'price aggregator not ready' });
        });

        it('pushpricebatch returns the aggregator-not-ready refusal', async function () {
            expect(await notReady.pushpricebatch({ source_chain: 'BTC', first_round: 1, last_round: 6, rounds: [] }))
                .to.deep.equal({ error: 'price aggregator not ready' });
        });

        it('pushoracleprice returns the aggregator-not-ready refusal', async function () {
            expect(await notReady.pushoracleprice({ source_chain: 'BTC', source_address: 'a', coin: 'BTC', tick: 'XCP', fiat: 'USD', value: '1' }))
                .to.deep.equal({ error: 'price aggregator not ready' });
        });

        it('pushattestbatch returns the mirror-not-ready refusal', async function () {
            expect(await notReady.pushattestbatch({ source_chain: 'BTC', rows: [] }))
                .to.deep.equal({ error: 'attestation response mirror not ready' });
        });
    });
});
