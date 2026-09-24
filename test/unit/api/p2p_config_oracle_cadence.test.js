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

// The oracle cadence knobs as src/api.js puts them on the p2pConfig a validator hub is
// built with. The interval divides elapsed time into federation round numbers, so a
// non-positive value must degrade to the shared default rather than reach OracleRound.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();

const { waitUntil } = require('../../helpers/waitUntil');
const { DB_METHODS } = require('../../helpers/mockHub');
const { DEFAULT_ORACLE_ROUND_INTERVAL_MS, DEFAULT_ORACLE_SUBMISSION_WINDOW_MS } = require('../../../src/constants.js');

const ENV_KEYS = ['HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_SENSITIVE_READ_AUTH', 'HUB_ALLOW_UNAUTHENTICATED',
                  'HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS', 'HUB_PORT',
                  'P2P_VALIDATOR_ADDR', 'HUB_NETWORK', 'ORACLE_EPOCH_START',
                  'ORACLE_ROUND_INTERVAL', 'ORACLE_SUBMISSION_WINDOW'];

function makeHub() {
    const noop = async () => {};
    return {
        db: { ...DB_METHODS, doQuery: sinon.stub().resolves([]), circuitState: 'closed' },
        capabilitySnapshot: null, stateAnchorPublisher: null, attestationPublisher: null,
        start: noop, startP2P: noop, startConsensus: noop, startOracle: noop, startCrossChain: noop,
        startReorgHandler: noop, startGovernance: noop, startAttestation: noop, startCapabilities: noop,
        on: () => {}
    };
}

function apiStubs(captured) {
    const app = { use: sinon.stub(), get: sinon.stub(), post: sinon.stub(), set: sinon.stub(),
                  listen: sinon.stub().callsFake((p, h, cb) => { if (cb) cb(); }) };
    const express = sinon.stub().returns(app);
    express.json = sinon.stub().returns(function expressJson() {});
    const server = { listen: sinon.stub().callsFake((p, h, cb) => { if (cb) cb(); }), on: sinon.stub() };
    return {
        'dotenv': { config: sinon.stub() },
        'express': express,
        'helmet': sinon.stub().returns(function helmetMw() {}),
        'cors': sinon.stub().returns(function corsMw() {}),
        'express-rate-limit': sinon.stub().returns(function rateLimitMw() {}),
        'express-json-rpc-router': (opts) => { captured.methods = opts.methods; return function routerMw() {}; },
        'http': { createServer: sinon.stub().returns(server) },
        'ws': { Server: sinon.stub().returns({ on: sinon.stub() }) },
        'geoip-lite': { lookup: sinon.stub().returns(null) },
        './XChainHub': function () { captured.p2pConfig = arguments[5]; return makeHub(); }
    };
}

// Boot src/api.js in validator mode and return the p2pConfig it hands the hub.
async function bootP2pConfig(env) {
    const captured = { p2pConfig: undefined, methods: null, exits: [] };
    const saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb', HUB_DB_USER: 'root',
        HUB_DB_PASS: 'pass', HUB_PORT: '9998', HUB_API_KEY: 'k', P2P_VALIDATOR_ADDR: 'bc1qexample',
        HUB_NETWORK: 'regtest', ORACLE_EPOCH_START: '1700000000000'
    }, env);
    const exitStub = sinon.stub(process, 'exit').callsFake((code) => { captured.exits.push(code); });
    try {
        proxyquire('../../../src/api', apiStubs(captured));
        await waitUntil(() => captured.methods || captured.exits.length > 0,
            { label: 'api.js boot to serve or refuse' });
    } finally {
        exitStub.restore();
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
    expect(captured.exits, 'validator boot refused').to.deep.equal([]);
    return captured.p2pConfig;
}

describe('src/api.js p2pConfig oracle cadence', function () {
    // The first proxyquire of api.js loads its whole require graph.
    this.timeout(20000);
    afterEach(function () { sinon.restore(); });

    it('carries a positive operator interval and window through unchanged', async function () {
        const cfg = await bootP2pConfig({ ORACLE_ROUND_INTERVAL: '60000', ORACLE_SUBMISSION_WINDOW: '20000' });
        expect(cfg.ORACLE_ROUND_INTERVAL).to.equal(60000);
        expect(cfg.ORACLE_SUBMISSION_WINDOW).to.equal(20000);
    });

    it('lands on the shared defaults when both knobs are unset', async function () {
        const cfg = await bootP2pConfig({});
        expect(cfg.ORACLE_ROUND_INTERVAL).to.equal(DEFAULT_ORACLE_ROUND_INTERVAL_MS);
        expect(cfg.ORACLE_SUBMISSION_WINDOW).to.equal(DEFAULT_ORACLE_SUBMISSION_WINDOW_MS);
    });

    it('degrades a negative interval and window to the shared defaults', async function () {
        const cfg = await bootP2pConfig({ ORACLE_ROUND_INTERVAL: '-600000', ORACLE_SUBMISSION_WINDOW: '-1' });
        expect(cfg.ORACLE_ROUND_INTERVAL).to.equal(DEFAULT_ORACLE_ROUND_INTERVAL_MS);
        expect(cfg.ORACLE_SUBMISSION_WINDOW).to.equal(DEFAULT_ORACLE_SUBMISSION_WINDOW_MS);
    });
});
