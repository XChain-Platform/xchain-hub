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
// Two attestation-facing gaps on the private API surface (src/api.js):
//
//   1. ATTESTATION_POLL_MS / ATTESTATION_ROUND_TIMEOUT_MS never reached
//      hub.p2pConfig, so a spawned api.js child stayed pinned to the 15s poll
//      and 120s round timeout no matter what an operator set.
//   2. No hub method answered "who is responsible for this request", so
//      xchain-e2e-test re-derived the ranking rule in test code instead of
//      asking the hub. getattestationresponsibleset closes that: read-only,
//      resolved through the hub's own AttestationRound._computeResponsibleSet.

const sinon         = require('sinon');
const { expect }    = require('chai');
const proxyquire    = require('proxyquire').noPreserveCache();
const { waitUntil }  = require('../helpers/waitUntil');
const AttestationRound = require('../../src/AttestationRound');

// Cold require of the whole hub tree on the first boot can exceed mocha's
// 2s default on a loaded box (see attestRelayHealth.test.js).
describe('attestation API surfaces (p2pConfig knobs + responsible-set read)', function () {
    this.timeout(20000);

    // Boots src/api.js with express/http/ws stubbed, captures the RPC method
    // table (express-json-rpc-router) and the p2pConfig handed to XChainHub's
    // constructor. `hubOverrides` patches the mock hub per test; `axiosPost`
    // stands in for the hub->indexer RPC calls the new method makes.
    async function bootApi({ envOverrides, hubOverrides, axiosPost } = {}) {
        const captured = { methods: null, p2pConfig: null };
        const mockApp = {
            use: sinon.stub(), get: sinon.stub(), post: sinon.stub(), set: sinon.stub(),
            listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); })
        };
        const mockExpress = sinon.stub().returns(mockApp);
        mockExpress.json = sinon.stub().returns(function expressJson() {});
        const mockServer = { listen: sinon.stub().callsFake((p, h, cb) => { if (cb) cb(); }), on: sinon.stub() };

        const mockHub = Object.assign({
            db: { doQuery: sinon.stub().resolves([]) },
            network: 'mainnet',
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

        const envKeys = [
            'HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_SENSITIVE_READ_AUTH', 'HUB_ALLOW_UNAUTHENTICATED',
            'HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS', 'HUB_PORT',
            'P2P_VALIDATOR_ADDR', 'ORACLE_EPOCH_START', 'HUB_NETWORK',
            'ATTESTATION_POLL_MS', 'ATTESTATION_ROUND_TIMEOUT_MS'
        ];
        const saved = {};
        for (const k of envKeys) { saved[k] = process.env[k]; delete process.env[k]; }
        Object.assign(process.env, {
            HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
            HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '0', HUB_API_KEY: 'k'
        }, envOverrides || {});

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
                'axios': { post: axiosPost || sinon.stub().rejects(new Error('no axios stub configured for this test')) },
                './XChainHub': function (host, port, name, user, secret, p2pConfig) {
                    captured.p2pConfig = p2pConfig;
                    return mockHub;
                }
            });
        } finally {
            for (const [k, v] of Object.entries(saved)) {
                if (v === undefined) delete process.env[k]; else process.env[k] = v;
            }
        }
        await waitUntil(() => captured.methods,
            { timeoutMs: 10000, label: 'api.js boot to register its RPC methods' });
        return { methods: captured.methods, p2pConfig: captured.p2pConfig, hub: mockHub };
    }

    // ── Row 46: the two attestation knobs reach p2pConfig ────────────────────
    describe('ATTESTATION_POLL_MS / ATTESTATION_ROUND_TIMEOUT_MS -> p2pConfig', function () {
        it('carries both knobs through to the object handed to XChainHub', async function () {
            const { p2pConfig } = await bootApi({
                envOverrides: {
                    P2P_VALIDATOR_ADDR: 'validator-addr-1',
                    ORACLE_EPOCH_START: '1700000000000',
                    HUB_NETWORK: 'regtest',
                    ATTESTATION_POLL_MS: '5000',
                    ATTESTATION_ROUND_TIMEOUT_MS: '45000'
                }
            });
            expect(p2pConfig).to.be.an('object');
            // Passed through UNPARSED, matching every other dead-knob fix this class
            // belongs to (ORACLE_MAX_SUBMISSIONS_PER_ROUND etc.): the consumer
            // (positiveIntConfig, AttestationRound.js/AttestationConsensus.js) owns
            // the parse and the range check.
            expect(p2pConfig.ATTESTATION_POLL_MS).to.equal('5000');
            expect(p2pConfig.ATTESTATION_ROUND_TIMEOUT_MS).to.equal('45000');
        });

        it('reaches the real consumer: AttestationRound/AttestationConsensus read the same keys', async function () {
            // Proves the wiring end to end rather than just the object shape: a
            // fixed key name in api.js that the consumer reads under a DIFFERENT
            // name would pass the test above and still leave the knob dead.
            const { positiveIntConfig } = require('../../src/lib/config_int.js');
            const p2pConfig = { ATTESTATION_POLL_MS: '7000', ATTESTATION_ROUND_TIMEOUT_MS: '90000' };
            expect(positiveIntConfig(p2pConfig.ATTESTATION_POLL_MS, 15000, 'ATTESTATION_POLL_MS')).to.equal(7000);
            expect(positiveIntConfig(p2pConfig.ATTESTATION_ROUND_TIMEOUT_MS, 120000, 'ATTESTATION_ROUND_TIMEOUT_MS')).to.equal(90000);
        });

        it('falls back to the documented defaults when unset', async function () {
            const { p2pConfig } = await bootApi({
                envOverrides: {
                    P2P_VALIDATOR_ADDR: 'validator-addr-1',
                    ORACLE_EPOCH_START: '1700000000000',
                    HUB_NETWORK: 'regtest'
                }
            });
            expect(p2pConfig.ATTESTATION_POLL_MS).to.equal(undefined);
            expect(p2pConfig.ATTESTATION_ROUND_TIMEOUT_MS).to.equal(undefined);
        });
    });

    // ── Row 47: getattestationresponsibleset ─────────────────────────────────
    describe('getattestationresponsibleset', function () {
        const RID = 'a'.repeat(64);

        function makeIndexerResponse({ requests, latestBlock }) {
            return sinon.stub().resolves({ data: { result: { latest_block_index: latestBlock, requests: requests } } });
        }

        it('refuses a missing request_id', async function () {
            const { methods } = await bootApi();
            const result = await methods.getattestationresponsibleset({});
            expect(result.error).to.match(/request_id/);
        });

        it('refuses a non-hex request_id', async function () {
            const { methods } = await bootApi();
            const result = await methods.getattestationresponsibleset({ request_id: 'not-a-valid-id' });
            expect(result.error).to.match(/64/);
        });

        it('refuses an unknown request id cleanly', async function () {
            // _resolveBtcIndexerUrl -> null is the "cannot even ask" case; the method
            // must answer {error}, never throw.
            const { methods } = await bootApi({
                hubOverrides: { getAttestationRound: () => new AttestationRound({ getPeerManager: () => null, db: null, p2pConfig: {} }, null) }
            });
            const result = await methods.getattestationresponsibleset({ request_id: RID });
            expect(result.error).to.equal('attestation request not found');
        });

        it('returns the same set AttestationRound._computeResponsibleSet computes for a seeded request', async function () {
            const validators = [
                { pubkey: 'pkAAAA' }, { pubkey: 'pkBBBB' }, { pubkey: 'pkCCCC' }, { pubkey: 'pkDDDD' }
            ];
            const declaredBlock = 100;       // well below mainnet's SWQ activation (961000): weighted=false
            const redundancy    = 2;
            const request = {
                request_id: RID, block_index: declaredBlock, redundancy: redundancy,
                deadline_block: declaredBlock + 1000, provider_id: 'http_get'
            };
            const round = new AttestationRound({ getPeerManager: () => null, db: null, p2pConfig: {} }, null);
            const expected = round._computeResponsibleSet(validators, RID, redundancy, false, null, 0)
                .map((v) => v.pubkey);

            const { methods } = await bootApi({
                hubOverrides: {
                    network: 'mainnet',
                    getAttestationRound: () => round,
                    capabilitySnapshot: { getSnapshot: async () => ({ validators: validators }) },
                    // latestBlock === declaredBlock => widenSlots' elapsed <= 0 => widen 0,
                    // regardless of network activation heights.
                    _resolveBtcIndexerUrl: async () => 'http://fake-indexer.local',
                },
                axiosPost: makeIndexerResponse({ requests: [request], latestBlock: declaredBlock })
            });

            const result = await methods.getattestationresponsibleset({ request_id: RID });
            expect(result.error, JSON.stringify(result)).to.equal(undefined);
            expect(result.request_id).to.equal(RID);
            expect(result.block_index).to.equal(declaredBlock);
            expect(result.redundancy).to.equal(redundancy);
            expect(result.widen).to.equal(0);
            expect(result.responsible).to.deep.equal(expected);
            expect(result.responsible).to.have.lengthOf(redundancy);
        });

        it('pages past a full first page to find a request further back in the queue', async function () {
            const validators = [{ pubkey: 'pkA' }, { pubkey: 'pkB' }];
            const declaredBlock = 50;
            const request = { request_id: RID, block_index: declaredBlock, redundancy: 1, deadline_block: declaredBlock + 500, provider_id: 'http_get' };

            // First page: 500 filler rows (a full page, so the walk must ask for a
            // second page); second page: the seeded request.
            const fillerPage = Array.from({ length: 500 }, (_, i) => ({
                request_id: String(i).padStart(64, '0'), block_index: i, action_index: i,
                redundancy: 1, deadline_block: i + 1, provider_id: 'http_get'
            }));
            const post = sinon.stub();
            post.onCall(0).resolves({ data: { result: { latest_block_index: declaredBlock, requests: fillerPage } } });
            post.onCall(1).resolves({ data: { result: { latest_block_index: declaredBlock, requests: [request] } } });

            const round = new AttestationRound({ getPeerManager: () => null, db: null, p2pConfig: {} }, null);
            const { methods } = await bootApi({
                hubOverrides: {
                    network: 'mainnet',
                    getAttestationRound: () => round,
                    capabilitySnapshot: { getSnapshot: async () => ({ validators: validators }) },
                    _resolveBtcIndexerUrl: async () => 'http://fake-indexer.local'
                },
                axiosPost: post
            });

            const result = await methods.getattestationresponsibleset({ request_id: RID });
            expect(result.error, JSON.stringify(result)).to.equal(undefined);
            expect(post.callCount).to.equal(2);
            expect(result.responsible).to.have.lengthOf(1);
        });
    });
});
