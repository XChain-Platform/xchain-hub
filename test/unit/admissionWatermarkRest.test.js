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
// The admission height watermark must ride EVERY carrier a mirror can learn it from, and
// the REST snapshot pages are the carrier a poll-mode consumer has instead of a
// heartbeat: a page with no `heights` leaves a poll-mode bootstrap with no baseline at
// all, so every height-keyed barrier on that node defers forever rather than for one
// interval. Ten pages serve the mirror and all ten are driven here against a real
// express app, because the only way a page can be missed is by being the one nobody
// asserted.

const http        = require('http');
const sinon       = require('sinon');
const { expect }  = require('chai');
const proxyquire  = require('proxyquire');
const { waitUntil } = require('../helpers/waitUntil');

// Every /hub-db/snapshot/* page the mirror reads, in the order api.js declares them.
const PAGES = [
    'price_snapshots',
    'oracle_prices',
    'cross_chain_matches',
    'capability_snapshots',
    'cross_chain_calls',
    'state_checkpoints',
    'bridge_transfers',
    'policy_snapshots',
    'anchor_reward_attestations',
    'attestation_responses',
];

// What the stubbed broadcaster claims. Distinct per table and per chain so a page serving
// another table's entry, or a single shared object, would fail rather than pass.
const CLAIM = {
    cross_chain_matches:        { BTC: 899001, LTC: 2899001 },
    cross_chain_calls:          { BTC: 899002 },
    bridge_transfers:           { BTC: 899003 },
    policy_snapshots:           { BTC: 899004 },
    price_snapshots:            { BTC: 899005 },
    oracle_prices:              { BTC: 899006 },
    attestation_responses:      { BTC: 899007 },
    anchor_reward_attestations: { BTC: 898863 },
};

function get(port, path) {
    return new Promise((resolve, reject) => {
        let req = http.request({ host: '127.0.0.1', port: port, path: path, method: 'GET' }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(body); } catch (e) { /* left null on a bad body */ }
                resolve({ status: res.statusCode, body: body, json: parsed });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// One api.js boot over a hub stand-in whose broadcaster serves `heights`. `heightsMode`
// picks what the broadcaster does, so the fail-closed case runs the same routes.
async function bootApi(heightsMode) {
    let capturedServer = null;
    let realExpress    = require('express');
    let passthrough    = () => (req, res, next) => next();

    let broadcaster;
    if (heightsMode === 'absent')      broadcaster = null;
    else if (heightsMode === 'throws') broadcaster = { admissionHeights: () => { throw new Error('watermark unreadable'); } };
    else if (heightsMode === 'empty')  broadcaster = { admissionHeights: () => ({}) };
    else                               broadcaster = { admissionHeights: () => JSON.parse(JSON.stringify(CLAIM)) };

    let mockHub = {
        network: 'regtest',
        start: sinon.stub().resolves(),
        startP2P: sinon.stub().resolves(),
        startConsensus: sinon.stub().resolves(),
        startOracle: sinon.stub().resolves(),
        startCrossChain: sinon.stub().resolves(),
        startReorgHandler: sinon.stub().resolves(),
        startGovernance: sinon.stub().resolves(),
        startAttestation: sinon.stub().resolves(),
        startCapabilities: sinon.stub().resolves(),
        getPriceSnapshots: sinon.stub().resolves([]),
        _oracleMaxAgeSeconds: sinon.stub().returns(900),
        getPrice: sinon.stub().resolves(null),
        getFeeQuote: sinon.stub().resolves({}),
        getOracle: sinon.stub().returns(null),
        getCrossChain: sinon.stub().returns(null),
        getAllConfigs: sinon.stub().resolves({}),
        getValidators: sinon.stub().resolves([]),
        getReorgHistory: sinon.stub().resolves([]),
        getSwaps: sinon.stub().resolves([]),
        initiateSwap: sinon.stub().resolves(),
        getSwap: sinon.stub().resolves({}),
        requestAttestation: sinon.stub().resolves({}),
        reportReorg: sinon.stub().resolves(),
        getAttestationRound: sinon.stub().returns(null),
        getProviderRegistry: sinon.stub().returns(null),
        hubDbBroadcaster: broadcaster,
        db: {
            // One row per page, whichever table the SELECT names: the page's own filtering is
            // covered elsewhere and is not what is under test here.
            async doQuery(sql) {
                let text = String(sql);
                let hit  = PAGES.find((t) => text.includes('FROM ' + t));
                return hit ? [{ id: 1 }] : [];
            },
            getChainTip: async () => null,
        },
    };

    let mockHttp  = { createServer: (app) => { capturedServer = http.createServer(app); return capturedServer; } };
    let mockWsLib = function () {};
    mockWsLib.Server = function () { return { on: sinon.stub(), close: sinon.stub() }; };
    mockWsLib.OPEN   = 1;

    let origEnv = {};
    let envVars = {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
        HUB_DB_USER: 'root', HUB_DB_PASS: 'pass',
        HUB_PORT: '0', HUB_HOST: '127.0.0.1',
        HUB_API_KEY: '', HUB_ALLOW_UNAUTHENTICATED: 'true',
        TELEMETRY_ENABLED: 'false',
    };
    for (let [k, v] of Object.entries(envVars)) { origEnv[k] = process.env[k]; process.env[k] = v; }
    try {
        proxyquire('../../src/api', {
            'dotenv': { config: sinon.stub() },
            'express': realExpress,
            'helmet': sinon.stub().callsFake(passthrough),
            'cors': sinon.stub().callsFake(passthrough),
            'express-rate-limit': sinon.stub().callsFake(passthrough),
            'express-json-rpc-router': sinon.stub().callsFake(passthrough),
            'http': mockHttp,
            'ws': mockWsLib,
            'geoip-lite': { lookup: sinon.stub().returns(null) },
            './XChainHub': function () { return mockHub; },
        });
    } finally {
        for (let [k, v] of Object.entries(origEnv)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }

    let server = await waitUntil(() => (capturedServer && capturedServer.listening ? capturedServer : null),
        { timeoutMs: 4000, intervalMs: 10, label: 'api.js to boot and listen' });
    return { server: server, port: server.address().port, hub: mockHub };
}

describe('hub-db snapshot pages carry the admission height watermark', function () {
    this.timeout(20000);

    let port, server;

    before(async function () {
        let booted = await bootApi('claim');
        server = booted.server;
        port   = booted.port;
    });

    after(function () {
        if (server) { try { server.close(); } catch (e) { /* already closed */ } }
        sinon.restore();
    });

    it('serves all TEN pages, which is the count the mirror reads', async function () {
        expect(PAGES).to.have.lengthOf(10);
        for (const table of PAGES) {
            let res = await get(port, '/hub-db/snapshot/' + table);
            expect(res.status, table + ' body: ' + res.body).to.equal(200);
            expect(res.json.table).to.equal(table);
        }
    });

    for (const table of PAGES) {
        it(table + ': the page carries heights beside the stream watermark', async function () {
            let res = await get(port, '/hub-db/snapshot/' + table);
            expect(res.status).to.equal(200);
            // The stream watermark (wall clock seconds) is untouched and still there.
            expect(res.json.watermark, 'the stream watermark went missing').to.be.a('number');
            expect(res.json, 'no heights object on this page').to.have.property('heights');
            // The WHOLE map rides every page, keyed table then chain: a consumer bootstrapping
            // one table still needs the entry for the tables it is about to poll.
            expect(res.json.heights).to.deep.equal(CLAIM);
            expect(res.json.heights.cross_chain_matches.LTC).to.equal(2899001);
            expect(res.json.schema_version).to.be.a('number');
        });
    }

    it('the keys are table then chain, with integer heights', async function () {
        let res = await get(port, '/hub-db/snapshot/cross_chain_matches');
        for (const [tbl, entry] of Object.entries(res.json.heights)) {
            expect(tbl).to.match(/^[a-z_]+$/);
            for (const [chain, h] of Object.entries(entry)) {
                expect(chain, tbl).to.match(/^[A-Z0-9]{1,10}$/);
                expect(Number.isSafeInteger(h), tbl + '.' + chain + ' = ' + h).to.equal(true);
                expect(h).to.be.at.least(0);
            }
        }
    });
});

describe('hub-db snapshot pages fail CLOSED on the watermark', function () {
    this.timeout(20000);

    afterEach(function () { sinon.restore(); });

    // A hub whose broadcaster is not up, and one whose watermark read throws, must both
    // serve an EMPTY map rather than a partial one or a 500: an empty map reads as no claim
    // on every chain, which defers the barrier, where a 500 would break the bootstrap the
    // page exists for.
    for (const mode of ['absent', 'throws', 'empty']) {
        it('serves heights {} when the watermark is ' + mode + ', and still serves the rows', async function () {
            let booted = await bootApi(mode);
            try {
                for (const table of ['cross_chain_matches', 'attestation_responses', 'oracle_prices']) {
                    let res = await get(booted.port, '/hub-db/snapshot/' + table);
                    expect(res.status, table + ' body: ' + res.body).to.equal(200);
                    expect(res.json.heights, table).to.deep.equal({});
                    expect(res.json.rows, table).to.have.lengthOf(1);
                }
            } finally {
                try { booted.server.close(); } catch (e) { /* already closed */ }
            }
        });
    }
});
