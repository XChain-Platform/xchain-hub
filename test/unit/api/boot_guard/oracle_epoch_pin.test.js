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

// The oracle epoch as src/api.js hands it to a validator hub: a pinned network takes
// its constants.js pin whatever the env says, warns when the env differs, and boots
// with the env unset; an unpinned network keeps the env value.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();

const { getLogger } = require('../../../../src/observability');
const { ORACLE_EPOCH_START_PINS } = require('../../../../src/constants.js');
const { waitUntil } = require('../../../helpers/waitUntil');
const { DB_METHODS } = require('../../../helpers/mockHub');

const ENV_KEYS = ['HUB_API_KEY', 'HUB_FEED_API_KEY', 'HUB_REORG_API_KEY', 'HUB_SENSITIVE_READ_AUTH', 'HUB_ALLOW_UNAUTHENTICATED',
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
        // A fresh resolver per boot: the shared module may hold a value cached by an earlier suite.
        './oracle/round_cadence.js': proxyquire('../../../../src/oracle/round_cadence.js', {}),
        './XChainHub': function () { captured.p2pConfig = arguments[5]; return makeHub(); }
    };
}

// Boot src/api.js in validator mode; returns the p2pConfig, the process.exit codes and
// every epoch warning logged during the boot.
async function boot(env) {
    const captured = { p2pConfig: undefined, methods: null, exits: [], warnings: [] };
    const saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb', HUB_DB_USER: 'root',
        HUB_DB_PASS: 'pass', HUB_PORT: '9998', HUB_API_KEY: 'k', P2P_VALIDATOR_ADDR: 'bc1qexample'
    }, env);
    const exitStub = sinon.stub(process, 'exit').callsFake((code) => { captured.exits.push(code); });
    const warnStub = sinon.stub(getLogger(), 'warn').callsFake((msg) => {
        if (String(msg).includes('ORACLE_EPOCH_START')) captured.warnings.push(String(msg));
    });
    try {
        proxyquire('../../../../src/api', apiStubs(captured));
        await waitUntil(() => captured.methods, { label: 'api.js boot to serve' });
    } finally {
        exitStub.restore();
        warnStub.restore();
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
    return captured;
}

describe('src/api.js p2pConfig ORACLE_EPOCH_START through the network pin', function () {
    // The first proxyquire of api.js loads its whole require graph.
    this.timeout(20000);
    afterEach(function () { sinon.restore(); });

    it('hands a testnet validator the pin, not a differing env epoch, and warns once', async function () {
        const differing = String(ORACLE_EPOCH_START_PINS.testnet + 1000);
        const { p2pConfig, exits, warnings } = await boot({ HUB_NETWORK: 'testnet', ORACLE_EPOCH_START: differing });
        expect(exits).to.deep.equal([]);
        expect(p2pConfig.ORACLE_EPOCH_START).to.equal(ORACLE_EPOCH_START_PINS.testnet);
        expect(warnings).to.have.lengthOf(1);
        expect(warnings[0]).to.include('IGNORED on testnet');
        expect(warnings[0]).to.include(differing);
    });

    it('hands a testnet validator the pin without a warning when the env equals it', async function () {
        const { p2pConfig, exits, warnings } = await boot({ HUB_NETWORK: 'testnet',
            ORACLE_EPOCH_START: String(ORACLE_EPOCH_START_PINS.testnet) });
        expect(exits).to.deep.equal([]);
        expect(p2pConfig.ORACLE_EPOCH_START).to.equal(ORACLE_EPOCH_START_PINS.testnet);
        expect(warnings).to.deep.equal([]);
    });

    it('boots a testnet validator with ORACLE_EPOCH_START unset and hands it the pin', async function () {
        const { p2pConfig, exits, warnings } = await boot({ HUB_NETWORK: 'testnet' });
        expect(exits).to.deep.equal([]);
        expect(p2pConfig.ORACLE_EPOCH_START).to.equal(ORACLE_EPOCH_START_PINS.testnet);
        expect(warnings).to.deep.equal([]);
    });

    it('keeps the env epoch on regtest, which is never pinned', async function () {
        const { p2pConfig, exits, warnings } = await boot({ HUB_NETWORK: 'regtest', ORACLE_EPOCH_START: '1700000000000' });
        expect(exits).to.deep.equal([]);
        expect(p2pConfig.ORACLE_EPOCH_START).to.equal(1700000000000);
        expect(warnings).to.deep.equal([]);
    });

    it('still refuses a mainnet validator with the env unset, since mainnet has no pin', async function () {
        expect(ORACLE_EPOCH_START_PINS).to.not.have.property('mainnet');
        const { exits } = await boot({ HUB_NETWORK: 'mainnet' });
        expect(exits[0]).to.equal(1);
    });
});
