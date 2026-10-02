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

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();

const { ConsensusInputMonitor } = require('../../../src/validators/consensus_input_monitor.js');
const { waitUntil } = require('../../helpers/waitUntil');
const { DB_METHODS } = require('../../helpers/mockHub');

function makeBatchHealthServer() {
    const mockApp = {
        use: sinon.stub(), get: sinon.stub(), post: sinon.stub(), set: sinon.stub(),
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); })
    };
    const mockExpress = sinon.stub().returns(mockApp);
    mockExpress.json = sinon.stub().returns(function expressJson() {});
    const mockServer = {
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); }),
        on: sinon.stub()
    };
    return { mockExpress, mockServer };
}

function makeBatchPublisher(stats) {
    return { getStats: sinon.stub().returns(stats) };
}

function makeRes() {
    return { statusCode: 200, status(code) { this.statusCode = code; return this; } };
}

async function bootApi(batchPublisher, options) {
    const captured = { methods: null };
    const { mockExpress, mockServer } = makeBatchHealthServer();
    const dbProbe = options && options.dbHealthy === false
        ? sinon.stub().rejects(new Error('database unavailable'))
        : sinon.stub().resolves([]);
    const mockHub = {
        db: {
            ...DB_METHODS, doQuery: sinon.stub().resolves([]), circuitState: 'closed',
            getDatabaseLivenessProbe: dbProbe
        },
        capabilitySnapshot: { monitor: new ConsensusInputMonitor({ throttleMs: 60000, log: () => {} }) },
        stateAnchorPublisher: null,
        attestationPublisher: null,
        attestationBatchPublisher: batchPublisher,
        attestationRelay: null,
        hubDbBroadcaster: null,
        start: async () => {}, startP2P: async () => {}, startConsensus: async () => {},
        startOracle: async () => {}, startCrossChain: async () => {}, startReorgHandler: async () => {},
        startGovernance: async () => {}, startAttestation: async () => {}, startCapabilities: async () => {},
        on: () => {}
    };

    const saved = {};
    for (const key of ['HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_SENSITIVE_READ_AUTH',
                       'HUB_ALLOW_UNAUTHENTICATED', 'HUB_DB_HOST', 'HUB_DB_PORT',
                       'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS', 'HUB_PORT',
                       'P2P_VALIDATOR_ADDR']) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
    Object.assign(process.env, {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
        HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9995', HUB_API_KEY: 'k'
    });

    try {
        proxyquire('../../../src/api', {
            'dotenv': { config: sinon.stub() },
            'express': mockExpress,
            'helmet': sinon.stub().returns(function helmetMw() {}),
            'cors': sinon.stub().returns(function corsMw() {}),
            'express-rate-limit': sinon.stub().returns(function rateLimitMw() {}),
            'express-json-rpc-router': (opts) => {
                captured.methods = opts.methods;
                return function routerMw() {};
            },
            'http': { createServer: sinon.stub().returns(mockServer) },
            'ws': { Server: sinon.stub().returns({ on: sinon.stub() }) },
            'geoip-lite': { lookup: sinon.stub().returns(null) },
            './XChainHub': function () { return mockHub; }
        });
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
    await waitUntil(() => captured.methods,
        { timeoutMs: 10000, label: 'api.js boot to register its RPC methods' });
    return { methods: captured.methods };
}

describe('/health attestation batch stats', function () {
    this.timeout(20000);

    afterEach(function () { sinon.restore(); });

    it('reports batch publisher stats on a healthy hub', async function () {
        const stats = { publishedWindows: 12, publishFailures: 0, pendingWindows: 1 };
        const boot = await bootApi(makeBatchPublisher(stats));
        const res = makeRes();
        const body = await boot.methods.health({}, { res });

        expect(body.attest_batch).to.equal(stats);
        expect(body.status).to.equal('healthy');
        expect(res.statusCode).to.equal(200);
    });

    it('keeps batch stats on a degraded hub without changing the verdict', async function () {
        const stats = { publishedWindows: 4, publishFailures: 2, pendingWindows: 3 };
        const boot = await bootApi(makeBatchPublisher(stats), { dbHealthy: false });
        const res = makeRes();
        const body = await boot.methods.health({}, { res });

        expect(body.attest_batch).to.equal(stats);
        expect(body.status).to.equal('degraded');
        expect(res.statusCode).to.equal(503);
    });

    it('omits attest_batch when the hub has no batch publisher', async function () {
        const boot = await bootApi(null);
        const res = makeRes();
        const body = await boot.methods.health({}, { res });

        expect(body).to.not.have.property('attest_batch');
        expect(res.statusCode).to.equal(200);
    });

    it('passes chain reconciliation counters through unchanged', async function () {
        const stats = {
            publishedWindows: 8,
            publishFailures: 1,
            pendingWindows: 2,
            chainReconcileLandedWindows: { BTC: 5, LTC: 2, DOGE: 1 }
        };
        const boot = await bootApi(makeBatchPublisher(stats));
        const res = makeRes();
        const body = await boot.methods.health({}, { res });

        expect(body.attest_batch).to.equal(stats);
        expect(body.attest_batch.chainReconcileLandedWindows).to.equal(
            stats.chainReconcileLandedWindows
        );
    });
});
