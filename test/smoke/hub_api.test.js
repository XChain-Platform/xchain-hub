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

const { expect }       = require('chai');
const sinon            = require('sinon');
const http             = require('http');
const express          = require('express');
const helmet           = require('helmet');
const cors             = require('cors');
const jsonRouter       = require('express-json-rpc-router');

const testDb           = require('../helpers/testDb');

const XChainHub        = require('../../src/XChainHub');

// ── Helpers ──────────────────────────────────────────────────────

let server  = null;
let hub     = null;
let apiPort = null;

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

                async getvalidators() {
                    try { return await hub.getValidators(); }
                    catch (err) { return { error: 'error fetching validators' }; }
                },

                async getproposals({ status }) {
                    try { return await hub.getProposals(status); }
                    catch (err) { return { error: 'error fetching proposals' }; }
                },

                async getswaps({ status, limit }) {
                    try { return await hub.getSwaps(status, limit); }
                    catch (err) { return { error: 'error fetching swaps' }; }
                },

                async getoraclesubmissions() {
                    let oracle = hub.getOracle();
                    // Mirrors src/api.js: an absent oracle ROLE is {active:false}, never an error.
                    if (!oracle) return { active: false };
                    return { active: true, ...(await oracle.getSubmissionsInfo()) };
                },

                async getattestations({ status, limit }) {
                    try {
                        let cc = hub.getCrossChain();
                        if (!cc) return { error: 'cross-chain engine not active' };
                        return await cc.getAttestations(status, limit);
                    } catch (err) { return { error: 'error fetching attestations' }; }
                }
    };
}

async function startApiSmokeServer() {
    if (!testDb.isAvailable()) {
        try { await testDb.setup(); } catch (e) {
            console.warn('MariaDB unavailable: skipping API smoke tests');
            return;
        }
    }
    let db = testDb.getDb();
    hub = new XChainHub(
        process.env.TEST_DB_HOST || '127.0.0.1',
        parseInt(process.env.TEST_DB_PORT) || 3306,
        process.env.TEST_DB_NAME || 'xchain_hub_test',
        process.env.TEST_DB_USER || 'root',
        process.env.TEST_DB_PASS || ''
    );
    hub.db = db;
    // Build Express app (mirrors api.js)
    let app = express();
    app.use(helmet());
    app.use(express.json());
    app.use(cors());
    app.use(jsonRouter({ methods: createController() }));
    await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
            apiPort = server.address().port;
            resolve();
        });
    });
}

function healthPingSuite() {
            it('ping returns success', async function () {
                let res = await callRpc('ping');
                expect(res).to.have.property('jsonrpc', '2.0');
                expect(res).to.have.property('id', 1);
                expect(res.result).to.deep.equal({ status: 'success' });
            });
        }

function methodResolutionSuite() {
            let methods = ['getallconfigs', 'getvalidators', 'getpricesnapshots', 'getproposals', 'getswaps'];

            for (let method of methods) {
                it(method + ' resolves without transport error', async function () {
                    let res = await callRpc(method);
                    expect(res).to.have.property('jsonrpc', '2.0');
                    expect(res).to.have.property('result');
                });
            }
        }

function configRoundTripSuite() {
            it('writes and reads back a config value', async function () {
                let writeRes = await callRpc('updateconfig', {
                    config: { BTC: { mainnet: { smoke: { host: 'smoke-host-value' } } } }
                });
                expect(writeRes.result.status).to.equal('success');

                let readRes = await callRpc('getallconfigs');
                expect(readRes.result.BTC).to.exist;
                expect(readRes.result.BTC.mainnet.smoke.host).to.equal('smoke-host-value');
            });
        }

function disabledSubsystemSuite() {
            // An absent oracle ROLE (standalone config-oracle hub) is a neutral
            // {active:false}, NOT an {error} envelope a health consumer would have to
            // read as a transport failure. The absent-error assertion is the load-
            // bearing half: it is what fails if the old error shape comes back.
            it('getoraclesubmissions reports active:false, not an error, when oracle inactive', async function () {
                let res = await callRpc('getoraclesubmissions');
                expect(res.result.active).to.equal(false);
                expect(res.result.error).to.equal(undefined);
            });

            it('getattestations returns structured error when cross-chain inactive', async function () {
                let res = await callRpc('getattestations', {});
                expect(res.result.error).to.include('cross-chain engine not active');
            });
        }

// ─── SMOKE-HUB-003 through 005, 010: API Server ────────────
function apiSmokeSuite() {
        before(startApiSmokeServer);

        after(async function () {
            if (server) await new Promise(r => server.close(r));
            // Only teardown if we set up in this block (testDb may already be torn down)
        });

        beforeEach(async function () {
            if (!testDb.isAvailable()) return this.skip();
            await testDb.truncateAll();
        });

        afterEach(function () { sinon.restore(); });

        // ── SMOKE-HUB-003: Health endpoint ──

        describe('SMOKE-HUB-003: Server health & ping', healthPingSuite);

        // ── SMOKE-HUB-004: Method resolution ──

        describe('SMOKE-HUB-004: JSON-RPC method resolution', methodResolutionSuite);

        // ── SMOKE-HUB-005: Config round-trip ──

        describe('SMOKE-HUB-005: Config read/write round-trip', configRoundTripSuite);

        // ── SMOKE-HUB-010: Optional subsystems ──

        describe('SMOKE-HUB-010: Graceful handling of disabled subsystems', disabledSubsystemSuite);
    }

function hubSmokeSuite() {
    describe('API smoke tests (SMOKE-HUB-003 through 005, 010)', apiSmokeSuite);
}

describe('Smoke: xchain-hub', hubSmokeSuite);
