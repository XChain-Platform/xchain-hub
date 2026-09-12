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
 * The hub's bridge API surfaces: the open getbridgeinvariant read, the keyed
 * pushbridgereorg retraction rail, and the two /hub-db/snapshot routes an
 * indexer bootstraps its bridge_transfers and policy_snapshots mirror from.
 *
 * Everything here is driven through a REAL api.js boot (express, http and ws
 * stubbed, the XChainHub constructor replaced), so the auth tier a method lands
 * in is read off the middleware that actually gates requests rather than off a
 * set this test re-declares. The three surfaces were left deliberately
 * unregistered by the seam contract, and a route registered but unreachable
 * (wrong tier, wrong path) is the failure this file exists to catch.
 ********************************************************************/

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();
const { waitUntil } = require('../helpers/waitUntil');

describe('CrossChainBridgeEngine API surfaces (hub api.js)', function(){
    this.timeout(20000);

    async function bootApi({ envOverrides, hubOverrides } = {}){
        const captured = { methods: null, routes: new Map(), middlewares: [] };
        const mockApp = {
            use: sinon.stub().callsFake((...args) => {
                const fn = args[args.length - 1];
                if(typeof fn === 'function') captured.middlewares.push({ path: (typeof args[0] === 'string' ? args[0] : null), fn });
            }),
            get: sinon.stub().callsFake((path, handler) => {
                if(typeof path === 'string' && typeof handler === 'function') captured.routes.set(path, handler);
            }),
            post: sinon.stub(), set: sinon.stub(),
            listen: sinon.stub().callsFake((port, host, cb) => { if(cb) cb(); })
        };
        const mockExpress = sinon.stub().returns(mockApp);
        mockExpress.json = sinon.stub().returns(function expressJson(){});
        const mockServer = { listen: sinon.stub().callsFake((p, h, cb) => { if(cb) cb(); }), on: sinon.stub() };

        const mockHub = Object.assign({
            db: { doQuery: sinon.stub().resolves([]), getChainTip: sinon.stub().resolves(null) },
            network: 'regtest',
            capabilitySnapshot: null,
            getPeerManager: () => null,
            getAttestationRound: () => null,
            getProviderRegistry: () => null,
            _resolveBtcIndexerUrl: async () => null,
            _btcIndexerHeaders: () => ({}),
            start: async () => {}, startP2P: async () => {}, startConsensus: async () => {},
            startOracle: async () => {}, startCrossChain: async () => {}, startReorgHandler: async () => {},
            startGovernance: async () => {}, startAttestation: async () => {}, startCapabilities: async () => {},
            on: () => {}
        }, hubOverrides || {});

        const envKeys = ['HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_SENSITIVE_READ_AUTH', 'HUB_ALLOW_UNAUTHENTICATED',
                         'HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS', 'HUB_PORT',
                         'P2P_VALIDATOR_ADDR', 'ORACLE_EPOCH_START', 'HUB_NETWORK'];
        const saved = {};
        for(const k of envKeys){ saved[k] = process.env[k]; delete process.env[k]; }
        Object.assign(process.env, {
            HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
            HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '0', HUB_API_KEY: 'bulkkey'
        }, envOverrides || {});
        try {
            proxyquire('../../src/api', {
                'dotenv': { config: sinon.stub() },
                'express': mockExpress,
                'helmet': sinon.stub().returns(function helmetMw(){}),
                'cors': sinon.stub().returns(function corsMw(){}),
                'express-rate-limit': sinon.stub().returns(function rateLimitMw(){}),
                'express-json-rpc-router': (opts) => { captured.methods = opts.methods; return function routerMw(){}; },
                'http': { createServer: sinon.stub().returns(mockServer) },
                'ws': { Server: sinon.stub().returns({ on: sinon.stub() }) },
                'geoip-lite': { lookup: sinon.stub().returns(null) },
                'axios': { post: sinon.stub().rejects(new Error('no axios stub configured')) },
                './XChainHub': function(){ return mockHub; }
            });
        } finally {
            for(const [k, v] of Object.entries(saved)){
                if(v === undefined) delete process.env[k]; else process.env[k] = v;
            }
        }
        await waitUntil(() => captured.methods, { timeoutMs: 10000, label: 'api.js boot to register its RPC methods' });
        return { methods: captured.methods, routes: captured.routes, middlewares: captured.middlewares, hub: mockHub };
    }

    // The JSON-RPC key gate, picked out by a closure reference unique to it, so the
    // tier a method sits in is read off the code that gates real requests.
    function keyGate(middlewares){
        const hit = middlewares.find(m => !m.path && /callWantsConfigSecrets/.test(String(m.fn)));
        expect(hit, 'the JSON-RPC key gate middleware must be registered').to.not.equal(undefined);
        return hit.fn;
    }

    function runGate(gate, method, apiKey){
        return new Promise((resolve) => {
            const req = { body: { jsonrpc: '2.0', method, params: {}, id: 1 }, headers: apiKey ? { 'x-api-key': apiKey } : {} };
            const res = { status: (code) => ({ json: (body) => resolve({ status: code, body }) }) };
            gate(req, res, () => resolve({ status: 200 }));
        });
    }

    function fakeRes(){
        const out = { status: 200, payload: null, type: function(){ return this; } };
        out.send = (s) => { out.payload = s; return out; };
        out.json = (j) => { out.payload = j; return out; };
        const realStatus = (code) => { out.status = code; return out; };
        out.status = realStatus;
        return out;
    }

    // ------------------------------------------------------------------
    describe('getbridgeinvariant', function(){

        it('is registered and serves the engine map', async function(){
            const invariant = { XCHAIN: { BTC: { escrow: '5', supply: '0', in_flight: '0', delta: '5', finalized_policy_seq: null } } };
            const { methods } = await bootApi({
                hubOverrides: { crossChainBridge: { getBridgeInvariant: sinon.stub().resolves(invariant) } }
            });
            expect(methods.getbridgeinvariant).to.be.a('function');
            expect(await methods.getbridgeinvariant({})).to.deep.equal(invariant);
        });

        it('passes a tick through and refuses a non-string or oversized one', async function(){
            const stub = sinon.stub().resolves({});
            const { methods } = await bootApi({ hubOverrides: { crossChainBridge: { getBridgeInvariant: stub } } });
            await methods.getbridgeinvariant({ tick: 'FUFU' });
            expect(stub.calledWith('FUFU')).to.equal(true);
            expect((await methods.getbridgeinvariant({ tick: 7 })).error).to.be.a('string');
            expect((await methods.getbridgeinvariant({ tick: 'x'.repeat(251) })).error).to.be.a('string');
        });

        it('answers cleanly on a hub with no bridge engine', async function(){
            const { methods } = await bootApi();
            expect((await methods.getbridgeinvariant({})).error).to.contain('bridge engine not active');
        });

        it('is an OPEN read: no key is required even with HUB_API_KEY set', async function(){
            const { middlewares } = await bootApi({ envOverrides: { HUB_API_KEY: 'bulkkey' } });
            const gate = keyGate(middlewares);
            expect((await runGate(gate, 'getbridgeinvariant')).status).to.equal(200);
            // Contrast with a keyed write on the same gate, so a gate that let
            // everything through could not pass this case.
            expect((await runGate(gate, 'updateconfig')).status).to.equal(401);
        });
    });

    // ------------------------------------------------------------------
    describe('pushbridgereorg', function(){

        function bridgeHub(retract){
            return { crossChainBridge: { retractTransfersForReorg: retract } };
        }

        it('forwards the bounded, fenced retraction to the engine', async function(){
            const retract = sinon.stub().resolves(2);
            const { methods } = await bootApi({ hubOverrides: bridgeHub(retract) });
            const out = await methods.pushbridgereorg({
                source_chain: 'BTC', from_action_index: 40, to_action_index: 50, retraction_generation: 3 });
            expect(retract.calledWith('BTC', 40, 50, 3)).to.equal(true);
            expect(out).to.deep.equal({ status: 'ok', source_chain: 'BTC', from_action_index: 40, retracted: 2 });
        });

        it('validates its arguments and reports an inactive engine', async function(){
            const { methods } = await bootApi({ hubOverrides: bridgeHub(sinon.stub().resolves(0)) });
            expect((await methods.pushbridgereorg({ from_action_index: 1 })).error).to.contain('source_chain');
            expect((await methods.pushbridgereorg({ source_chain: 'XRP', from_action_index: 1 })).error).to.be.a('string');
            expect((await methods.pushbridgereorg({ source_chain: 'BTC' })).error).to.contain('from_action_index');
            const bare = await bootApi();
            expect((await bare.methods.pushbridgereorg({ source_chain: 'BTC', from_action_index: 1 })).error)
                .to.contain('bridge engine not active');
        });

        it('surfaces a fail-closed bound error instead of a silent widening', async function(){
            const retract = sinon.stub().rejects(new Error('invalid to_action_index'));
            const { methods } = await bootApi({ hubOverrides: bridgeHub(retract) });
            expect((await methods.pushbridgereorg({ source_chain: 'BTC', from_action_index: 40, to_action_index: 10 })).error)
                .to.equal('invalid to_action_index');
        });

        it('is on the RETRACTION key tier, not the bulk one', async function(){
            const { middlewares } = await bootApi({ envOverrides: { HUB_API_KEY: 'bulkkey', HUB_REORG_API_KEY: 'reorgkey' } });
            const gate = keyGate(middlewares);
            expect((await runGate(gate, 'pushbridgereorg')).status).to.equal(401);
            expect((await runGate(gate, 'pushbridgereorg', 'bulkkey')).status).to.equal(401);
            expect((await runGate(gate, 'pushbridgereorg', 'reorgkey')).status).to.equal(200);
        });

        it('is reachable on the public feed port, as the sibling retraction rails are', async function(){
            const { middlewares } = await bootApi();
            const feedGate = middlewares.find(m => !m.path && /FEED_RPC_METHODS/.test(String(m.fn)));
            expect(feedGate, 'the feed-port allowlist middleware must be registered').to.not.equal(undefined);
            const run = (method) => new Promise((resolve) => {
                const req = { xchainFeedOrigin: true, method: 'POST', body: { method }, headers: {} };
                const res = { status: (c) => ({ json: () => resolve(c) }) };
                feedGate.fn(req, res, () => resolve(200));
            });
            expect(await run('pushbridgereorg')).to.equal(200);
            expect(await run('updateconfig')).to.equal(404);      // still private-port only
        });
    });

    // ------------------------------------------------------------------
    describe('/hub-db/snapshot routes', function(){

        it('serves bridge_transfers, excluding retracted rows the stream deletes', async function(){
            const doQuery = sinon.stub().resolves([{ id: 1, transfer_id: 'b'.repeat(64) }]);
            const { routes } = await bootApi({ hubOverrides: { db: { doQuery, getChainTip: sinon.stub().resolves(null) } } });
            const handler = routes.get('/hub-db/snapshot/bridge_transfers');
            expect(handler, 'the bridge_transfers snapshot route must be registered').to.be.a('function');
            const res = fakeRes();
            await handler({ query: { since_id: '7', limit: '100' } }, res);
            const body = JSON.parse(res.payload);
            expect(body.table).to.equal('bridge_transfers');
            expect(body.count).to.equal(1);
            expect(body.schema_version).to.equal(6);
            const [sql, params] = doQuery.lastCall.args;
            expect(sql).to.contain("status <> 'retracted'");
            expect(sql).to.contain('ORDER BY id ASC');
            expect(params).to.deep.equal([7, 100]);
        });

        it('serves policy_snapshots WITHOUT a status filter, because the table is append-only', async function(){
            const doQuery = sinon.stub().resolves([]);
            const { routes } = await bootApi({ hubOverrides: { db: { doQuery, getChainTip: sinon.stub().resolves(null) } } });
            const handler = routes.get('/hub-db/snapshot/policy_snapshots');
            expect(handler, 'the policy_snapshots snapshot route must be registered').to.be.a('function');
            const res = fakeRes();
            await handler({ query: {} }, res);
            const [sql] = doQuery.lastCall.args;
            expect(sql).to.contain('FROM policy_snapshots');
            expect(sql).to.not.contain('retracted');
            expect(JSON.parse(res.payload).table).to.equal('policy_snapshots');
        });

        it('rejects a malformed since_id / limit rather than paging from garbage', async function(){
            const doQuery = sinon.stub().resolves([]);
            const { routes } = await bootApi({ hubOverrides: { db: { doQuery, getChainTip: sinon.stub().resolves(null) } } });
            for(const path of ['/hub-db/snapshot/bridge_transfers', '/hub-db/snapshot/policy_snapshots']){
                const res = fakeRes();
                // eslint-disable-next-line no-await-in-loop
                await routes.get(path)({ query: { since_id: 'abc' } }, res);
                expect(res.status, path).to.equal(400);
            }
        });

        it('degrades a 500 rather than leaking a driver error to a mirror', async function(){
            const doQuery = sinon.stub().rejects(new Error('ER_NO_SUCH_TABLE: bridge_transfers'));
            const { routes } = await bootApi({ hubOverrides: { db: { doQuery, getChainTip: sinon.stub().resolves(null) } } });
            const res = fakeRes();
            await routes.get('/hub-db/snapshot/bridge_transfers')({ query: {} }, res);
            expect(res.status).to.equal(500);
            expect(res.payload).to.deep.equal({ error: 'snapshot error' });
        });
    });
});
