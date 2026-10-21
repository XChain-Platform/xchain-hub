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

// How the oracle epoch travels today, from the raw ORACLE_EPOCH_START env string to
// the number the hub is built with. Two halves: the boot refusal, called directly with
// a stubbed process.exit and a recording logger, and src/api.js booted through
// proxyquire to see what p2pConfig carries. The refusal tests only presence, so a
// non-numeric string passes it and parseInt turns it into NaN downstream.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();

const { refuseInvalidNetwork } = require('../../../../src/api/boot_guard.js');
const { waitUntil } = require('../../../helpers/waitUntil');
const { DB_METHODS } = require('../../../helpers/mockHub');

const EPOCH_ERROR = 'Missing required environment variable: ORACLE_EPOCH_START (Unix ms timestamp anchoring oracle round numbering; all hubs must share the same value)';
const NETWORK_ERROR = 'Missing/invalid required environment variable: HUB_NETWORK (must be one of mainnet|testnet|regtest; names the deployment network for consensus activation gating; must match the indexers this hub federates)';

const ENV_KEYS = ['HUB_API_KEY', 'HUB_FEED_API_KEY', 'HUB_REORG_API_KEY', 'HUB_SENSITIVE_READ_AUTH', 'HUB_ALLOW_UNAUTHENTICATED',
                  'HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS', 'HUB_PORT',
                  'P2P_VALIDATOR_ADDR', 'HUB_NETWORK', 'ORACLE_EPOCH_START',
                  'ORACLE_ROUND_INTERVAL', 'ORACLE_SUBMISSION_WINDOW'];

describe('boot_guard refuseInvalidNetwork on the raw ORACLE_EPOCH_START env', function () {
    let exits, errors, logger;

    beforeEach(function () {
        exits = [];
        errors = [];
        logger = { error: (m) => errors.push(m), warn: () => {}, info: () => {} };
        sinon.stub(process, 'exit').callsFake((code) => { exits.push(code); });
    });
    afterEach(function () { sinon.restore(); });

    function run(epoch, network, validator = 'bc1qexample') {
        refuseInvalidNetwork({ logger, hubConfig: { ORACLE_EPOCH_START: epoch },
            P2P_VALIDATOR_ADDR: validator, HUB_NETWORK: network });
    }

    it('exits 1 with the one-line epoch message when testnet has an undefined epoch', function () {
        run(undefined, 'testnet');
        expect(exits).to.deep.equal([1]);
        expect(errors).to.deep.equal([EPOCH_ERROR]);
    });

    it('exits 1 with the one-line epoch message when testnet has an empty-string epoch', function () {
        run('', 'testnet');
        expect(exits).to.deep.equal([1]);
        expect(errors).to.deep.equal([EPOCH_ERROR]);
    });

    it('accepts the non-empty string not-a-number without parsing it', function () {
        run('not-a-number', 'testnet');
        expect(exits).to.deep.equal([]);
        expect(errors).to.deep.equal([]);
    });

    it('does not refuse a standalone hub with no validator address and no epoch', function () {
        run(undefined, '', '');
        expect(exits).to.deep.equal([]);
        expect(errors).to.deep.equal([]);
    });

    it('reports the epoch error first, then the HUB_NETWORK error, for a missing epoch and an invalid network', function () {
        run(undefined, 'bogusnet');
        expect(exits).to.deep.equal([1, 1]);
        expect(errors).to.deep.equal([EPOCH_ERROR, NETWORK_ERROR]);
    });
});

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

// Boot src/api.js in validator mode; a refusal is recorded, not fatal, so the boot runs on.
async function boot(env) {
    const captured = { p2pConfig: undefined, methods: null, exits: [] };
    const saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    Object.assign(process.env, {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb', HUB_DB_USER: 'root',
        HUB_DB_PASS: 'pass', HUB_PORT: '9998', HUB_API_KEY: 'k', P2P_VALIDATOR_ADDR: 'bc1qexample',
        HUB_NETWORK: 'regtest'
    }, env);
    const exitStub = sinon.stub(process, 'exit').callsFake((code) => { captured.exits.push(code); });
    try {
        proxyquire('../../../../src/api', apiStubs(captured));
        await waitUntil(() => captured.methods, { label: 'api.js boot to serve' });
    } finally {
        exitStub.restore();
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
    return captured;
}

// Only an unpinned network reads the raw env here; oracle_epoch_pin.test.js covers testnet.
describe('src/api.js p2pConfig ORACLE_EPOCH_START from the raw env', function () {
    // The first proxyquire of api.js loads its whole require graph.
    this.timeout(20000);
    afterEach(function () { sinon.restore(); });

    for (const network of ['mainnet', 'regtest']) {
        it(`hands p2pConfig the number 1700000000000 on ${network} for the string 1700000000000`, async function () {
            const { p2pConfig, exits } = await boot({ HUB_NETWORK: network, ORACLE_EPOCH_START: '1700000000000' });
            expect(exits).to.deep.equal([]);
            expect(p2pConfig.ORACLE_EPOCH_START).to.equal(1700000000000);
        });
    }

    it('truncates 1700000000999.7 to 1700000000999 through parseInt', async function () {
        const { p2pConfig, exits } = await boot({ HUB_NETWORK: 'mainnet', ORACLE_EPOCH_START: '1700000000999.7' });
        expect(exits).to.deep.equal([]);
        expect(p2pConfig.ORACLE_EPOCH_START).to.equal(1700000000999);
    });

    it('boots mainnet on not-a-number with 0 exits and hands the hub NaN', async function () {
        const { p2pConfig, exits } = await boot({ HUB_NETWORK: 'mainnet', ORACLE_EPOCH_START: 'not-a-number' });
        expect(exits).to.have.lengthOf(0);
        expect(Number.isNaN(p2pConfig.ORACLE_EPOCH_START)).to.equal(true);
    });

    it('calls process.exit with 1 first when mainnet boots with the epoch unset', async function () {
        const { exits } = await boot({ HUB_NETWORK: 'mainnet' });
        expect(exits[0]).to.equal(1);
    });
});
