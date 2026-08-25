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
//
// getoraclesubmissions distinguishes an absent oracle ROLE from a failure.
//
// A standalone config-oracle hub (P2P_VALIDATOR_ADDR empty, CONFIGURATION.md)
// never mints an OracleRound, so getOracle() is null forever. Answering that with
// an {error} envelope made it indistinguishable from a transport failure to a
// health consumer, which pinned such a hub at 'degraded' on every poll for its
// whole life. These tests pin the replacement against the REAL src/api.js
// controller: the neutral state is {active:false}, the running state carries
// active:true, and neither carries an error field.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();

const { waitUntil } = require('../helpers/waitUntil');

describe('getoraclesubmissions role reporting', function () {

    // The first proxyquire boot pays the cold require of the whole hub tree.
    this.timeout(20000);

    // Boot src/api.js with everything heavy stubbed and capture its RPC methods.
    async function bootApi(oracle) {
        const captured = { methods: null };
        const mockApp = {
            use: sinon.stub(), get: sinon.stub(), post: sinon.stub(), set: sinon.stub(),
            listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); })
        };
        const mockExpress = sinon.stub().returns(mockApp);
        mockExpress.json = sinon.stub().returns(function expressJson() {});
        const mockServer = { listen: sinon.stub().callsFake((p, h, cb) => { if (cb) cb(); }), on: sinon.stub() };

        const mockHub = {
            db: { doQuery: sinon.stub().resolves([]), circuitState: 'closed' },
            stateAnchorPublisher: null,
            attestationPublisher: null,
            attestationRelay:     null,
            hubDbBroadcaster:     null,
            getOracle: () => oracle,
            _oracleMaxAgeSeconds: () => 1800,
            start: async () => {}, startP2P: async () => {}, startConsensus: async () => {},
            startOracle: async () => {}, startCrossChain: async () => {}, startReorgHandler: async () => {},
            startGovernance: async () => {}, startAttestation: async () => {}, startCapabilities: async () => {},
            on: () => {}
        };

        const saved = {};
        for (const k of ['HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_SENSITIVE_READ_AUTH', 'HUB_ALLOW_UNAUTHENTICATED',
                         'HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS',
                         'HUB_PORT', 'P2P_VALIDATOR_ADDR']) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
        Object.assign(process.env, {
            HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
            HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9995', HUB_API_KEY: 'k'
        });

        try {
            proxyquire('../../src/api', {
                'dotenv': { config: sinon.stub() },
                'express': mockExpress,
                'helmet': sinon.stub().returns(function helmetMw() {}),
                'cors': sinon.stub().returns(function corsMw() {}),
                'express-rate-limit': sinon.stub().returns(function rateLimitMw() {}),
                'express-json-rpc-router': (opts) => { captured.methods = opts.methods; return function routerMw() {}; },
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
        await waitUntil(() => captured.methods,
            { timeoutMs: 10000, label: 'api.js boot to register its RPC methods' });
        return captured.methods;
    }

    afterEach(function () { sinon.restore(); });

    it('answers active:false, with no error field, on a hub that runs no oracle round', async function () {
        const methods = await bootApi(null);
        const result  = await methods.getoraclesubmissions({});

        expect(result.active).to.equal(false);
        // The load-bearing half: an {error} body is what a health consumer cannot
        // tell apart from a transport failure, so its ABSENCE is the contract.
        expect(result.error).to.equal(undefined);
    });

    it('answers active:true with the submissions payload on a hub that runs the round', async function () {
        const info = { currentRound: 42, submissions: { 42: { addr1: {} } }, roundInterval: 600000 };
        const methods = await bootApi({ getSubmissionsInfo: async () => info });
        const result  = await methods.getoraclesubmissions({});

        expect(result.active).to.equal(true);
        expect(result.error).to.equal(undefined);
        expect(result.currentRound).to.equal(42);
        expect(result.submissions).to.deep.equal(info.submissions);
        expect(result.oracleMaxPriceAgeSeconds).to.equal(1800);
    });
});
