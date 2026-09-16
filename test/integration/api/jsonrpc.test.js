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

const sinon        = require('sinon');
const { expect }   = require('chai');
const http         = require('http');
const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const jsonRouter   = require('express-json-rpc-router');
const testDb       = require('../../helpers/testDb');
const XChainHub    = require('../../../src/XChainHub');

let server  = null;
let hub     = null;
let apiPort = null;

/**
 * Send a JSON-RPC request to the test server.
 */
function callRpc(method, params) {
    return new Promise((resolve, reject) => {
        let body = JSON.stringify({
            jsonrpc: '2.0',
            id:      1,
            method:  method,
            params:  params || {}
        });

        let req = http.request({
            hostname: '127.0.0.1',
            port:     apiPort,
            path:     '/',
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve({ raw: data, statusCode: res.statusCode }); }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function createTestHub(db) {
    // Create a minimal hub wired to the real DB
    let testHub = new XChainHub(
        process.env.TEST_DB_HOST || '127.0.0.1',
        parseInt(process.env.TEST_DB_PORT) || 3306,
        process.env.TEST_DB_NAME || 'xchain_hub_test',
        process.env.TEST_DB_USER || 'root',
        process.env.TEST_DB_PASS || ''
    );
    testHub.db = db;
    return testHub;
}

function createController() {
    return {
        async ping() { return { status: 'success' }; },
        async getallconfigs() {
            try { return await hub.getAllConfigs(); }
            catch (err) { return { error: 'error getting configs' }; }
        },
        async updateconfig({ config }) {
            try { await hub.applyConfig(config); return { status: 'success' }; }
            catch (err) { return { error: err.message }; }
        },
        async getpricesnapshots({ limit }) {
            try { return await hub.getPriceSnapshots(limit || 50); }
            catch (err) { return { error: 'error fetching snapshots' }; }
        },
        async getprice({ coin_pair }) {
            if (!coin_pair) return { error: 'coin_pair is required' };
            try {
                let price = await hub.getPrice(coin_pair);
                return price || { error: 'no price data for ' + coin_pair };
            } catch (err) { return { error: 'error fetching price' }; }
        },
        // Mirrors api.js pushchaintip. It was missing here entirely, so the four
        // block_height/block_time validation cases below hit method-not-found and
        // failed on `res.result` being undefined rather than on the validation
        // they were written to cover.
        async pushchaintip({ coin, network, block_height, block_time }) {
            if (!coin) return { error: 'coin is required' };
            if (block_height === undefined || block_height === null)
                return { error: 'block_height is required' };
            if (block_time === undefined || block_time === null)
                return { error: 'block_time is required' };
            let height = parseInt(block_height, 10);
            if (!Number.isFinite(height) || height < 0)
                return { error: 'invalid block_height' };
            let time = parseInt(block_time, 10);
            if (!Number.isFinite(time) || time < 0)
                return { error: 'invalid block_time' };
            try {
                await hub.db.setChainTip(coin, network, height, time);
                return { status: 'success' };
            } catch (err) { return { error: err.message }; }
        }
    };
}

async function setupApi() {
    try { await testDb.setup(); } catch (e) {
        console.warn('MariaDB unavailable, skipping API tests');
        return;
    }
    hub = createTestHub(testDb.getDb());
    // Build Express app (replica of api.js without env validation)
    let app = express();
    app.use(helmet());
    app.use(express.json());
    app.use(cors());
    app.use(jsonRouter({ methods: createController() }));
    // Start on random port
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
            apiPort = server.address().port;
            resolve();
        });
    });
}

function registerApiHooks() {
    before(setupApi);
    after(async function () {
        if (server) await new Promise(r => server.close(r));
        await testDb.teardown();
    });
    beforeEach(async function () {
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
    });
    afterEach(function () { sinon.restore(); });
}

describe('Integration: JSON-RPC API (SC-8.x)', function () {
    registerApiHooks();
    registerOracleStateTests();
    registerChainTipTests();
    registerConfigTests();
});

// SC-8.1: API reflects oracle state accurately
function registerOracleStateTests() {
    describe('SC-8.1: Oracle state via API', function () {
        it('ping returns success', async function () {
            let res = await callRpc('ping');
            expect(res.result).to.deep.equal({ status: 'success' });
        });

        it('getprice returns latest finalized snapshot', async function () {
            let db = testDb.getDb();
            await db.doQuery(
                `INSERT INTO price_snapshots
                    (round_number, coin_pair, price, reference_block, reference_chain,
                     block_timestamp, validator_count, consensus_round, consensus_proof, status)
                 VALUES (1, 'BTC/USD', '100000.12345678', 0, 'BTC', ?, 3, 1, '[]', 'finalized')`,
                [Date.now()]
            );

            let res = await callRpc('getprice', { coin_pair: 'BTC/USD' });
            expect(res.result.price).to.equal('100000.12345678');
            expect(res.result.coin_pair).to.equal('BTC/USD');
        });

        it('getprice returns error for missing coin pair', async function () {
            let res = await callRpc('getprice', {});
            expect(res.result.error).to.include('coin_pair is required');
        });

        it('getpricesnapshots returns ordered results', async function () {
            let db = testDb.getDb();
            for (let r = 1; r <= 3; r++) {
                await db.doQuery(
                    `INSERT INTO price_snapshots
                        (round_number, coin_pair, price, reference_block, reference_chain,
                         block_timestamp, validator_count, consensus_round, consensus_proof, status)
                     VALUES (?, 'BTC/USD', ?, 0, 'BTC', ?, 3, 1, '[]', 'finalized')`,
                    [r, (100000 + r * 100).toFixed(8), Date.now() + r]
                );
            }

            let res = await callRpc('getpricesnapshots', { limit: 10 });
            expect(res.result).to.be.an('array').with.lengthOf(3);
            expect(res.result[0].round_number).to.equal(3);
        });
    });
}

// pushchaintip: input validation on network-supplied block_height/block_time
function registerChainTipTests() {
    describe('pushchaintip: block_height/block_time validation', function () {
        it('rejects a non-numeric block_height without writing a poisoned chain_tips row', async function () {
            let res = await callRpc('pushchaintip', {
                coin: 'BTC', network: 'mainnet', block_height: 'abc', block_time: Date.now()
            });
            expect(res.result.error).to.include('invalid block_height');
        });

        it('rejects a non-numeric block_time', async function () {
            let res = await callRpc('pushchaintip', {
                coin: 'BTC', network: 'mainnet', block_height: 800000, block_time: 'not-a-time'
            });
            expect(res.result.error).to.include('invalid block_time');
        });

        it('rejects a negative block_height', async function () {
            let res = await callRpc('pushchaintip', {
                coin: 'BTC', network: 'mainnet', block_height: -5, block_time: Date.now()
            });
            expect(res.result.error).to.include('invalid block_height');
        });

        it('accepts a valid numeric block_height/block_time', async function () {
            let res = await callRpc('pushchaintip', {
                coin: 'BTC', network: 'mainnet', block_height: 800000, block_time: Date.now()
            });
            expect(res.result.status).to.equal('success');
        });
    });
}

// SC-8.2: Config round-trip via API
function registerConfigTests() {
    describe('SC-8.2: Config via API', function () {
        it('updates and retrieves config', async function () {
            // Write config
            let writeRes = await callRpc('updateconfig', {
                config: { BTC: { mainnet: { decoder: { host: 'btc-node', port: '8332' } } } }
            });
            expect(writeRes.result.status).to.equal('success');

            // Read config
            let readRes = await callRpc('getallconfigs');
            expect(readRes.result.BTC).to.exist;
            expect(readRes.result.BTC.mainnet.decoder.host).to.equal('btc-node');
            expect(readRes.result.BTC.mainnet.decoder.port).to.equal('8332');
        });
    });
}
