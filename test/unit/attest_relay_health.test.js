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
// /health carries the attestation relay's stats.
//
// The relay drives the v3 request / v4 response legs across chains and its
// only instrument was the process log, so the one failure that costs a real
// user an answer (a finalized v4 held for want of an origin-chain broadcast
// rail) was invisible to every probe. These tests pin the replacement: the
// counters are on /health, they are telemetry rather than a health verdict,
// and the field is absent rather than half-formed on a hub that has no relay.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();

const { ConsensusInputMonitor } = require('../../src/lib/consensus_input_monitor.js');
const { waitUntil } = require('../helpers/waitUntil');

describe('/health attestation relay stats', function () {

    // The first proxyquire boot pays the cold require of the whole hub tree,
    // which can exceed mocha's 2s default on its own.
    this.timeout(20000);

    // Boot src/api.js with everything heavy stubbed and capture its RPC methods.
    async function bootApi(relay) {
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
            attestationRelay:      relay,
            hubDbBroadcaster:      null,
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
            HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9996', HUB_API_KEY: 'k'
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
        // The boot is an async IIFE, so the RPC methods land some ticks after
        // proxyquire returns; poll for them rather than sizing a settle against
        // the cold-require boot this file's timeout comment already flags.
        await waitUntil(() => captured.methods,
            { timeoutMs: 10000, label: 'api.js boot to register its RPC methods' });
        return { methods: captured.methods, hub: mockHub };
    }

    function makeRes() {
        return { statusCode: 200, status(code) { this.statusCode = code; return this; } };
    }

    // The shape AttestationRelay.getStats() actually returns.
    function relayStats(over) {
        return Object.assign({
            enabled:             true,
            broadcast_succeeded: 12,
            broadcast_failed:    0,
            wal_failures:        0,
            relayed_count:       12,
            responses_relayed:   11,
            awaiting_broadcast:  1,
            inflight_rounds:     0,
            spend_guard: { label: 'AttestationRelay', paused: false, window_spend_usd_cents: 400 }
        }, over || {});
    }

    function makeRelay(stats) {
        return { getStats: sinon.stub().returns(stats) };
    }

    afterEach(function () { sinon.restore(); });

    it('reports the relay counters beside attest on a hub that runs a relay', async function () {
        const stats = relayStats();
        const boot  = await bootApi(makeRelay(stats));
        const res   = makeRes();
        const body  = await boot.methods.health({}, { res });

        expect(body.attest_relay).to.deep.equal(stats);
        expect(body.status).to.equal('healthy');
        expect(res.statusCode).to.equal(200);
    });

    it('surfaces the held-v4 signature: awaiting_broadcast up, responses_relayed flat', async function () {
        // No LTC broadcast rail configured, so every finalized response piles up.
        const boot = await bootApi(makeRelay(relayStats({
            responses_relayed: 0, awaiting_broadcast: 9, broadcast_succeeded: 9
        })));
        const res  = makeRes();
        const body = await boot.methods.health({}, { res });

        expect(body.attest_relay.awaiting_broadcast).to.equal(9);
        expect(body.attest_relay.responses_relayed).to.equal(0);
    });

    it('stays 200 when the relay is disabled or failing: telemetry, not a health verdict', async function () {
        const boot = await bootApi(makeRelay(relayStats({
            enabled: false, broadcast_failed: 4, wal_failures: 2, awaiting_broadcast: 6
        })));
        const res  = makeRes();
        const body = await boot.methods.health({}, { res });

        expect(body.attest_relay.enabled).to.equal(false);
        expect(body.attest_relay.broadcast_failed).to.equal(4);
        expect(body.status).to.equal('healthy');
        expect(res.statusCode).to.equal(200);
    });

    it('omits the field entirely on a hub with no relay', async function () {
        const boot = await bootApi(null);
        const res  = makeRes();
        const body = await boot.methods.health({}, { res });

        expect(body).to.not.have.property('attest_relay');
        expect(res.statusCode).to.equal(200);
    });

    it('tolerates a relay object that predates getStats()', async function () {
        const boot = await bootApi({ start: async () => {} });
        const res  = makeRes();
        const body = await boot.methods.health({}, { res });

        expect(body).to.not.have.property('attest_relay');
        expect(body.status).to.equal('healthy');
    });
});
