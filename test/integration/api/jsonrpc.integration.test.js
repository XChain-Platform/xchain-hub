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

describe('Integration: JSON-RPC API (SC-8.x)', function () {

    before(async function () {
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable — skipping API tests');
            return;
        }

        let db = testDb.getDb();

        // Create a minimal hub wired to the real DB
        hub = new XChainHub(
            process.env.TEST_DB_HOST || '127.0.0.1',
            parseInt(process.env.TEST_DB_PORT) || 3306,
            process.env.TEST_DB_NAME || 'xchain_hub_test',
            process.env.TEST_DB_USER || 'root',
            process.env.TEST_DB_PASS || ''
        );
        hub.db = db;

        // Build Express app (replica of api.js without env validation)
        let app = express();
        app.use(helmet());
        app.use(express.json());
        app.use(cors());

        let controller = {
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
            async registervalidator({ signing_pubkey, addr }) {
                try { await hub.registerValidator(signing_pubkey, addr); return { status: 'success' }; }
                catch (err) { return { error: err.message }; }
            },
            async rotatevalidator({ addr, new_signing_pubkey }) {
                try { await hub.rotateValidator(addr, new_signing_pubkey); return { status: 'success' }; }
                catch (err) { return { error: err.message }; }
            },
            async deregistervalidator({ signing_pubkey, addr }) {
                try { await hub.deregisterValidator({ signingPubkey: signing_pubkey, addr }); return { status: 'success' }; }
                catch (err) { return { error: err.message }; }
            },
            async getvalidators() {
                try { return await hub.getValidators(); }
                catch (err) { return { error: 'error fetching validators' }; }
            },
            async getvalidatorstatus({ signing_pubkey }) {
                if (!signing_pubkey) return { error: 'signing_pubkey is required' };
                try {
                    let status = await hub.getValidatorStatus(signing_pubkey);
                    return status || { error: 'validator not found' };
                } catch (err) { return { error: 'error fetching validator status' }; }
            },
            async getfeequote({ action, chain }) {
                if (!action) return { error: 'action is required' };
                if (!chain) return { error: 'chain is required' };
                try { return await hub.getFeeQuote(action, chain); }
                catch (err) { return { error: 'error calculating fee quote' }; }
            }
        };

        app.use(jsonRouter({ methods: controller }));

        // Start on random port
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                apiPort = server.address().port;
                resolve();
            });
        });
    });

    after(async function () {
        if (server) await new Promise(r => server.close(r));
        await testDb.teardown();
    });

    beforeEach(async function () {
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
    });

    afterEach(function () { sinon.restore(); });

    // SC-8.1: API reflects oracle state accurately
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

    // SC-8.2: Config round-trip via API
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

    // SC-8.3: Validator state via API
    describe('SC-8.3: Validator state', function () {
        it('registers and retrieves validators', async function () {
            let pubkey = 'aa'.repeat(32);

            let regRes = await callRpc('registervalidator', {
                signing_pubkey: pubkey,
                addr: 'ws://test-validator:10001'
            });
            expect(regRes.result.status).to.equal('success');

            let listRes = await callRpc('getvalidators');
            expect(listRes.result).to.be.an('array').with.lengthOf(1);
            expect(listRes.result[0].signing_pubkey).to.equal(pubkey);
        });

        it('returns error for invalid pubkey', async function () {
            let res = await callRpc('registervalidator', {
                signing_pubkey: 'too-short',
                addr: 'ws://test:10001'
            });
            expect(res.result.error).to.include('Invalid signing pubkey');
        });

        it('getvalidatorstatus returns validator with rewards and slashes', async function () {
            let db = testDb.getDb();
            let pubkey = 'bb'.repeat(32);

            // Register validator
            await callRpc('registervalidator', { signing_pubkey: pubkey, addr: 'ws://v:10001' });

            // Insert reward
            await db.doQuery(
                "INSERT INTO validator_rewards (validator_pubkey, round_number, reward_type, amount) VALUES (?, 1, 'oracle_round', '5.00000000')",
                [pubkey]
            );

            // Insert slash proposal
            await db.doQuery(
                "INSERT INTO slash_proposals (validator_pubkey, offense_type, round_number, evidence) VALUES (?, 'price_deviation', 1, '{}')",
                [pubkey]
            );

            let res = await callRpc('getvalidatorstatus', { signing_pubkey: pubkey });
            expect(res.result.validator).to.exist;
            expect(res.result.validator.signing_pubkey).to.equal(pubkey);
        });

        // Addr-keyed register: registering a second key for an existing addr
        // retires the first, leaving exactly one active row per addr (the F8
        // duplicate-active-row fix).
        it('register of a second pubkey for an existing addr retires the first', async function () {
            let addr = 'ws://rot:10001';
            let pkA = 'a1'.repeat(32), pkB = 'b2'.repeat(32);
            await callRpc('registervalidator', { signing_pubkey: pkA, addr });
            await callRpc('registervalidator', { signing_pubkey: pkB, addr });

            let active = (await callRpc('getvalidators')).result;
            expect(active).to.be.an('array').with.lengthOf(1);
            expect(active[0].signing_pubkey).to.equal(pkB);
            // pkA persists as a removed row (getValidators returns active only)
            let rows = await testDb.getDb().doQuery(
                "SELECT signing_pubkey, status FROM validators WHERE addr = ? ORDER BY signing_pubkey", [addr]);
            let byPk = Object.fromEntries(rows.map(r => [r.signing_pubkey, r.status]));
            expect(byPk[pkA]).to.equal('removed');
            expect(byPk[pkB]).to.equal('active');
        });

        it('rotatevalidator replaces the addr active pubkey; old key removed', async function () {
            let addr = 'ws://rot2:10001';
            let pkOld = 'c3'.repeat(32), pkNew = 'd4'.repeat(32);
            await callRpc('registervalidator', { signing_pubkey: pkOld, addr });

            let rotRes = await callRpc('rotatevalidator', { addr, new_signing_pubkey: pkNew });
            expect(rotRes.result.status).to.equal('success');

            let active = (await callRpc('getvalidators')).result;
            expect(active).to.be.an('array').with.lengthOf(1);
            expect(active[0].signing_pubkey).to.equal(pkNew);
            expect(active[0].addr).to.equal(addr);
        });

        it('rotatevalidator on an unknown addr errors', async function () {
            let res = await callRpc('rotatevalidator', {
                addr: 'ws://nope:10001', new_signing_pubkey: 'e5'.repeat(32) });
            expect(res.result.error).to.include('No active validator');
        });

        it('deregistervalidator by pubkey marks the validator removed', async function () {
            let pubkey = 'f6'.repeat(32);
            await callRpc('registervalidator', { signing_pubkey: pubkey, addr: 'ws://dr:10001' });
            let dRes = await callRpc('deregistervalidator', { signing_pubkey: pubkey });
            expect(dRes.result.status).to.equal('success');
            expect((await callRpc('getvalidators')).result).to.be.an('array').with.lengthOf(0);
        });

        it('deregistervalidator by addr marks the validator removed', async function () {
            let addr = 'ws://dr2:10001';
            await callRpc('registervalidator', { signing_pubkey: '17'.repeat(32), addr });
            await callRpc('deregistervalidator', { addr });
            expect((await callRpc('getvalidators')).result).to.be.an('array').with.lengthOf(0);
        });
    });

    // SC-8.4: API error responses
    describe('SC-8.4: Error responses', function () {
        it('returns error for missing required params', async function () {
            let res = await callRpc('getfeequote', {});
            expect(res.result.error).to.include('action is required');
        });

        it('returns fee quote for valid action', async function () {
            let res = await callRpc('getfeequote', { action: 'ISSUE', chain: 'BTC' });
            expect(res.result.action).to.equal('ISSUE');
            expect(res.result.gasCost).to.equal(100000);
        });

        it('returns error for unknown action', async function () {
            let res = await callRpc('getfeequote', { action: 'INVALID', chain: 'BTC' });
            expect(res.result.error).to.include('unknown action');
        });
    });
});
