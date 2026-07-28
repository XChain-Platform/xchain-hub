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
// : /health carries the hub DB stream heartbeat.
//
// Consumers gate their price-sync barriers on the watermark this hub
// broadcasts, and the only place its cadence was ever visible was the
// consumer's own barrier-timeout log line. Fixing the barrier removed that
// line, and with it the only instrument for "the watermark sits within one
// heartbeat of wall clock". These tests pin the producer-side replacement:
// the cadence is reported on /health, and it is telemetry only, never a
// reason to 503 a hub whose DB and oracle are fine.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();

const { ConsensusInputMonitor } = require('../../src/lib/consensus_input_monitor.js');

describe('/health hub DB stream heartbeat ', function () {

    // Boot src/api.js with everything heavy stubbed and capture its RPC methods.
    async function bootApi(broadcaster) {
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
            capabilitySnapshot: { monitor: new ConsensusInputMonitor({ throttleMs: 60000, log: () => {} }) },
            stateAnchorPublisher: null,
            attestationPublisher:  null,
            hubDbBroadcaster:      broadcaster,
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
            HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9997', HUB_API_KEY: 'k'
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
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { methods: captured.methods, hub: mockHub };
    }

    function makeRes() {
        return { statusCode: 200, status(code) { this.statusCode = code; return this; } };
    }

    function makeBroadcaster(stats) {
        return { getWatermarkStats: sinon.stub().returns(stats) };
    }

    afterEach(function () { sinon.restore(); });

    it('reports the heartbeat cadence on a hub that has a broadcaster', async function () {
        const stats = {
            interval_ms: 10000, late_threshold_ms: 20000, ticks: 42, sent: 42, late_ticks: 0,
            last_gap_ms: 10001, max_gap_ms: 10004, last_watermark_ts: 1785176300,
            last_tick_age_ms: 3000, subscribers: 6, last_delivered: 6, healthy: true
        };
        const boot = await bootApi(makeBroadcaster(stats));
        const res  = makeRes();
        const body = await boot.methods.health({}, { res });

        expect(body.hub_db_stream).to.deep.equal(stats);
        expect(body.status).to.equal('healthy');
        expect(res.statusCode).to.equal(200);
    });

    it('stays 200 when the heartbeat is stalled: telemetry, not a health verdict', async function () {
        const boot = await bootApi(makeBroadcaster({
            interval_ms: 10000, late_threshold_ms: 20000, ticks: 7, sent: 7, late_ticks: 3,
            last_gap_ms: 640000, max_gap_ms: 640000, last_watermark_ts: 1785175660,
            last_tick_age_ms: 640000, subscribers: 6, last_delivered: 6, healthy: false
        }));
        const res  = makeRes();
        const body = await boot.methods.health({}, { res });

        expect(body.hub_db_stream.healthy).to.equal(false);
        expect(body.hub_db_stream.late_ticks).to.equal(3);
        expect(body.status).to.equal('healthy');
        expect(res.statusCode).to.equal(200);
    });

    it('omits the field entirely on a hub with no broadcaster', async function () {
        const boot = await bootApi(null);
        const res  = makeRes();
        const body = await boot.methods.health({}, { res });

        expect(body).to.not.have.property('hub_db_stream');
        expect(res.statusCode).to.equal(200);
    });

    it('tolerates an older broadcaster that predates getWatermarkStats', async function () {
        const boot = await bootApi({ getSubscriberCount: () => 0 });
        const res  = makeRes();
        const body = await boot.methods.health({}, { res });

        expect(body).to.not.have.property('hub_db_stream');
        expect(body.status).to.equal('healthy');
    });
});
