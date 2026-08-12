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
// , both halves:
//   1. boot REFUSES while the write surface is unauthenticated and undeclared
//      (it used to warn and serve on every non-validator hub);
//   2. /health reports the consensus-input alarm and degrades on it, so a hub
//      that has fallen out of every consensus round is visible to a probe.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();

const { evaluateAuthPosture } = require('../../src/lib/auth_posture.js');
const { ConsensusInputMonitor, REASONS } = require('../../src/lib/consensus_input_monitor.js');
const { waitUntil } = require('../helpers/waitUntil');

describe('boot auth posture ', function () {

    describe('evaluateAuthPosture()', function () {

        it('REFUSES a keyless config-oracle hub (the fail-open default that shipped)', function () {
            const p = evaluateAuthPosture({ apiKey: '', allowUnauthenticated: false, validatorMode: false });
            expect(p.refuse).to.equal(true);
            expect(p.fatal).to.contain('REFUSING TO BOOT');
            expect(p.fatal).to.contain('HUB_API_KEY');
            expect(p.fatal).to.contain('HUB_ALLOW_UNAUTHENTICATED');
            expect(p.fatal).to.contain('config oracle');
        });

        it('REFUSES a keyless validator hub, naming the consensus risk', function () {
            const p = evaluateAuthPosture({ apiKey: '', allowUnauthenticated: false, validatorMode: true });
            expect(p.refuse).to.equal(true);
            expect(p.fatal).to.contain('VALIDATOR');
        });

        it('boots keyless when the operator DECLARES it, still warning loudly', function () {
            const p = evaluateAuthPosture({ apiKey: '', allowUnauthenticated: true, validatorMode: false });
            expect(p.refuse).to.equal(false);
            expect(p.warnings.join(' ')).to.contain('UNAUTHENTICATED');
        });

        it('flags a declared-keyless VALIDATOR extra loudly', function () {
            const p = evaluateAuthPosture({ apiKey: '', allowUnauthenticated: true, validatorMode: true });
            expect(p.refuse).to.equal(false);
            expect(p.warnings.join(' ')).to.contain('ON A VALIDATOR HUB');
        });

        it('boots clean with a key and no warnings', function () {
            const p = evaluateAuthPosture({ apiKey: 'k', allowUnauthenticated: false, validatorMode: true });
            expect(p.refuse).to.equal(false);
            expect(p.warnings).to.deep.equal([]);
        });

        it('notes a stale HUB_ALLOW_UNAUTHENTICATED left on a keyed hub', function () {
            const p = evaluateAuthPosture({ apiKey: 'k', allowUnauthenticated: true });
            expect(p.refuse).to.equal(false);
            expect(p.warnings.join(' ')).to.contain('has no effect');
        });

        it('keeps the AU-4 sensitive-read warning on a keyed hub with the hatch open', function () {
            const p = evaluateAuthPosture({ apiKey: 'k', sensitiveReadAuth: false });
            expect(p.refuse).to.equal(false);
            expect(p.warnings.join(' ')).to.contain('HUB_SENSITIVE_READ_AUTH=0');
        });

        it('does not double-report the read hatch on a hub that is already refusing', function () {
            // The refusal is the actionable line; appending a second warning
            // about a read tier that will never serve is noise.
            const p = evaluateAuthPosture({ apiKey: '', sensitiveReadAuth: false });
            expect(p.refuse).to.equal(true);
            expect(p.warnings).to.deep.equal([]);
        });
    });

    // Boot src/api.js with everything heavy stubbed. process.exit is stubbed so
    // a refusal is observable instead of taking the test runner down with it.
    async function bootApi(env) {
        const captured = { methods: null, exits: [] };
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
            HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9998'
        }, env);

        const exitStub = sinon.stub(process, 'exit').callsFake((code) => { captured.exits.push(code); });
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
        // The boot is an async IIFE with two terminal outcomes: it either
        // registers the JSON-RPC methods or refuses via process.exit. Poll for
        // whichever arrives; a fixed settle has to be sized for the slower one
        // on the slowest box, which is dead time on every other run.
        try {
            await waitUntil(() => captured.methods || captured.exits.length > 0,
                { label: 'api.js boot to serve or refuse' });
        } finally {
            exitStub.restore();
        }
        return { exits: captured.exits, methods: captured.methods, hub: mockHub };
    }

    describe('src/api.js boot', function () {

        afterEach(function () { sinon.restore(); });

        it('refuses to boot with no key and no declaration', async function () {
            const err = sinon.stub(console, 'error');
            const boot = await bootApi({});
            expect(boot.exits).to.deep.equal([1]);
            expect(err.getCalls().some(c => String(c.args[0]).indexOf('REFUSING TO BOOT') === 0))
                .to.equal(true, 'expected the refusal on stderr');
        });

        it('refuses a keyless VALIDATOR hub too (unchanged from before)', async function () {
            const err = sinon.stub(console, 'error');
            const boot = await bootApi({ P2P_VALIDATOR_ADDR: 'bc1qexample' });
            // process.exit is stubbed, so the module keeps running and trips the
            // later validator-mode env requirements too. What matters is that the
            // auth posture exited FIRST, before anything served.
            expect(boot.exits[0]).to.equal(1);
            expect(String(err.firstCall.args[0])).to.contain('REFUSING TO BOOT');
            expect(String(err.firstCall.args[0])).to.contain('VALIDATOR');
        });

        it('boots when keyless is declared', async function () {
            sinon.stub(console, 'warn');
            const boot = await bootApi({ HUB_ALLOW_UNAUTHENTICATED: 'true' });
            expect(boot.exits).to.deep.equal([]);
            expect(boot.methods).to.not.equal(null);
        });

        it('boots with a key', async function () {
            const boot = await bootApi({ HUB_API_KEY: 'a-strong-key' });
            expect(boot.exits).to.deep.equal([]);
        });
    });

    describe('/health consensus-input wiring', function () {

        afterEach(function () { sinon.restore(); });

        function makeRes() {
            return { statusCode: 200, status(code) { this.statusCode = code; return this; } };
        }

        it('reports the consensus-input telemetry on a healthy hub', async function () {
            const boot = await bootApi({ HUB_API_KEY: 'k' });
            const res  = makeRes();
            const body = await boot.methods.health({}, { res });

            expect(body.consensus_input).to.be.an('object');
            expect(body.consensus_input.alerting).to.equal(false);
            expect(body.status).to.equal('healthy');
            expect(res.statusCode).to.equal(200);
        });

        it('degrades to 503 once consensus-input fetches are alerting', async function () {
            const boot = await bootApi({ HUB_API_KEY: 'k' });
            const monitor = boot.hub.capabilitySnapshot.monitor;
            for (let i = 0; i < 3; i++) monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE, 'down');

            const res  = makeRes();
            const body = await boot.methods.health({}, { res });

            expect(body.consensus_input.alerting).to.equal(true);
            expect(body.consensus_input.by_reason.unreachable).to.equal(3);
            expect(body.consensus_input.last_failure.reason).to.equal('unreachable');
            expect(body.status).to.equal('degraded');
            expect(res.statusCode).to.equal(503);
        });

        it('recovers to healthy once a fetch succeeds again', async function () {
            const boot = await bootApi({ HUB_API_KEY: 'k' });
            const monitor = boot.hub.capabilitySnapshot.monitor;
            for (let i = 0; i < 3; i++) monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE, 'down');
            monitor.recordSuccess('getactivevalidators');

            const res  = makeRes();
            const body = await boot.methods.health({}, { res });
            expect(body.status).to.equal('healthy');
            expect(res.statusCode).to.equal(200);
        });
    });
});
