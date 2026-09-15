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
// Chain identity on the mirrored cross-chain tables.
//
// A regtest re-genesis leaves the hub database standing while the chain under it is
// replaced, so every fresh indexer bootstraps relic cross_chain_matches and
// capability_snapshots from a chain that no longer exists and re-evaluates them at every
// block forever. Nothing in those rows named a chain: `network` is the whole scope, and
// on regtest one network value spans every chain the venue has ever had.
//
// The identity is the hash of BITCOIN BLOCK 1, not block 0: the regtest genesis hash is a
// chainparams constant that is byte-identical across every re-genesis, while block 1
// commits to the moment the new chain started. The Bitcoin indexer reports it on the tip
// push it already makes; the hub stores it, stamps it on the rows it writes, and
// advertises it on the three snapshot envelopes so a DOGE/LTC mirror (which cannot derive
// it locally) learns what to expect.
//
// The column is TRANSPORT, never consensus: the last describe here drives the signed match
// canonical with and without it and asserts the bytes do not move.

const fs         = require('fs');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const proxyquireNoCache = require('proxyquire').noPreserveCache();
const { waitUntil } = require('../../helpers/waitUntil');

const snapWrite            = require('../../../src/lib/capability_snapshot_write.js');
const CrossChainDexEngine  = require('../../../src/cross_chain/dex_engine.js');
const CrossChainCallEngine = require('../../../src/cross_chain/call_engine.js');
const { DB_METHODS } = require('../../helpers/mockHub.js');

// A plausible regtest block-1 hash (lowercase 64 hex) and a foreign one.
const LOCAL_ID   = '00000000c937983704a73af28acdec37b049d214adbda81d7e2a3dd146f6ed09';
const FOREIGN_ID = '000000005c8ba8e1e0a4a2e6f2d3c4b5a6978869fedcba0987654321abcdef01';

const SQL_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql');
const CROSS_CHAIN_TABLES = ['cross_chain_matches', 'cross_chain_calls', 'capability_snapshots'];

// ────────────────────────────────────────────────────────────────────────────
// api.js harness: boot with everything heavy stubbed and capture both the
// JSON-RPC method table (the object handed to express-json-rpc-router) and the
// GET route handlers, so each can be driven directly.
// ────────────────────────────────────────────────────────────────────────────

function fakeRes() {
    return {
        statusCode: 200,
        body: null,
        type() { return this; },
        send(b) { this.body = b; return this; },
        status(c) { this.statusCode = c; return this; },
        json(o) { this.body = JSON.stringify(o); return this; },
        parsed() { return JSON.parse(this.body); }
    };
}

function makeChainTipApiEnv(hubNetwork) {
    return {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
        HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '0',
        HUB_ALLOW_UNAUTHENTICATED: 'true', HUB_NETWORK: hubNetwork, TELEMETRY_ENABLED: 'false'
    };
}

async function bootApi(hubDb, hubNetwork) {
    const routes  = {};
    let   methods = null;

    const mockApp = {
        use:  sinon.stub(),
        get:  sinon.stub().callsFake((p, ...rest) => { routes[p] = rest[rest.length - 1]; }),
        post: sinon.stub(),
        set:  sinon.stub(),
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); })
    };
    const mockServer = { listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); }), on: sinon.stub() };
    const mockExpress = sinon.stub().returns(mockApp);
    mockExpress.json = sinon.stub().returns(function expressJson() {});

    // Auto-stub every hub method the boot touches, but keep the two properties
    // this test actually cares about real.
    const base = { db: hubDb, network: hubNetwork };
    const mockHub = new Proxy(base, {
        get: (t, p) => {
            if (!(p in t)) t[p] = sinon.stub().callsFake(async () => ({}));
            return t[p];
        }
    });

    const saved = {};
    const env = makeChainTipApiEnv(hubNetwork);
    for (const k of ['HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_CONFIG_SECRETS_API_KEY',
                     'HUB_SENSITIVE_READ_AUTH', 'P2P_VALIDATOR_ADDR', ...Object.keys(env)]) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    Object.assign(process.env, env);

    try {
        proxyquireNoCache('../../../src/api', {
            'dotenv': { config: sinon.stub() },
            'express': mockExpress,
            'helmet': sinon.stub().returns(function helmetMw() {}),
            'cors': sinon.stub().returns(function corsMw() {}),
            'express-rate-limit': sinon.stub().returns(function rateLimitMw() {}),
            'express-json-rpc-router': (opts) => { methods = opts.methods; return function routerMw() {}; },
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

    // server.listen() is the last step of the async boot IIFE.
    await waitUntil(() => mockServer.listen.called, { label: 'api.js boot to reach server.listen' });
    return { routes, methods: methods };
}

// A db stand-in for the snapshot routes: one row per cross-chain table, plus a
// programmable getChainTip and a record of the SQL it was asked for.
function snapshotDb() {
    const seenSql = [];
    return { ...DB_METHODS,
        seenSql,
        chainTip: null,
        chainTipThrows: false,
        async getChainTip(coin, network) {
            this.lastTipArgs = [coin, network];
            if (this.chainTipThrows) throw new Error('configs read failed');
            return this.chainTip;
        },
        async doQuery(sql) {
            seenSql.push(String(sql));
            let hit = ['price_snapshots', ...CROSS_CHAIN_TABLES].find(t => String(sql).includes('FROM ' + t));
            return hit ? [{ id: 1, btc_chain_id: LOCAL_ID }] : [];
        }
    };
}

// Build src/db.js with mariadb + fs stubbed, exactly as db.coverage.test.js does.
function makeDb(fsOverrides) {
    const mockConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves(), end: sinon.stub().resolves() };
    const mockPool = { getConnection: sinon.stub().resolves(mockConn), end: sinon.stub().resolves() };
    const Database = proxyquire('../../../src/db', {
        mariadb: { createPool: sinon.stub().returns(mockPool), createConnection: sinon.stub().resolves(mockConn) },
        fs: Object.assign({ readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') }, fsOverrides || {}),
        path: require('path')
    });
    return { db: new Database('localhost', 3306, 'test_db', 'user', 'pass'), mockConn, mockPool };
}

let methods, db;
const BAD_CHAIN_TIP_IDS = {
    'a 63-hex string':      '0'.repeat(63),
    'a 65-hex string':      '0'.repeat(65),
    'uppercase hex':        LOCAL_ID.toUpperCase(),
    'non-hex characters':   'z'.repeat(64),
    'an empty string':      '',
    'a number':             12345,
    'an object':            { hash: LOCAL_ID }
};

function registerChainTipCompatibilityTests() {
['ETH', 'btc', 'BTCX', '', 0, null, undefined, {}].forEach((bad) => {
        it('refuses coin ' + JSON.stringify(bad) + ' without writing a tip', async function () {
            let thrown = null;
            try {
                await methods.pushchaintip({ coin: bad, network: 'regtest', block_height: 131, block_time: 1757298240 });
            } catch (err) { thrown = err; }
            // The falsy coins are caught one guard earlier and keep their own
            // in-result shape; only a PRESENT but unknown coin reaches validateChain.
            if (!bad) {
                expect(thrown, 'a missing coin is a returned refusal, not a throw').to.equal(null);
            } else {
                expect(thrown, 'an unknown coin must throw so the refusal lands in the error slot').to.be.an('error');
                expect(thrown.code).to.equal(-32602);
                expect(thrown.message).to.equal('chain must be one of: BTC, LTC, DOGE');
            }
            expect(db.setChainTip.called, 'no tip may be written for a refused coin').to.be.false;
        });
    });

    it('still stores a tip for every allowed coin', async function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            db.setChainTip.resetHistory();
            let r = await methods.pushchaintip({ coin: coin, network: 'regtest', block_height: 131, block_time: 1757298240 });
            expect(r).to.deep.equal({ status: 'success' });
            expect(db.setChainTip.calledOnce, coin + ' must still be accepted').to.be.true;
        }
    });
}

function registerChainTipValidationTests() {
for (const [label, value] of Object.entries(BAD_CHAIN_TIP_IDS)) {
        it('rejects ' + label + ' and writes nothing', async function () {
            let r = await methods.pushchaintip({ coin: 'BTC', network: 'regtest', block_height: 131, block_time: 1757298240, chain_id: value });
            expect(r).to.deep.equal({ error: 'invalid chain_id' });
            expect(db.setChainTip.called, 'the tip must not be written when the identity is invalid').to.be.false;
        });
    }

    it('leaves behaviour unchanged when chain_id is absent (older indexer)', async function () {
        let r = await methods.pushchaintip({ coin: 'DOGE', network: 'regtest', block_height: 900, block_time: 1757298240 });
        expect(r).to.deep.equal({ status: 'success' });
        expect(db.setChainTip.calledOnce).to.be.true;
        expect(db.setChainTip.firstCall.args[4]).to.equal(undefined);
    });

    it('leaves behaviour unchanged when chain_id is explicitly null', async function () {
        let r = await methods.pushchaintip({ coin: 'DOGE', network: 'regtest', block_height: 900, block_time: 1757298240, chain_id: null });
        expect(r).to.deep.equal({ status: 'success' });
        expect(db.setChainTip.firstCall.args[4]).to.equal(undefined);
    });
}

function registerChainTipIdentityTest() {
it('stores a valid chain_id with the tip', async function () {
        let r = await methods.pushchaintip({ coin: 'BTC', network: 'regtest', block_height: 131, block_time: 1757298240, chain_id: LOCAL_ID });
        expect(r).to.deep.equal({ status: 'success' });
        expect(db.setChainTip.calledOnce).to.be.true;
        expect(db.setChainTip.firstCall.args).to.deep.equal(['BTC', 'regtest', 131, 1757298240, LOCAL_ID]);
    });
}

function registerSnapshotEnvelopeSuite() {
describe('snapshot envelopes advertise the hub chain identity', function () {
        let routes, db;
        before(async function () {
            db = snapshotDb();
            ({ routes } = await bootApi(db, 'regtest'));
        });

        beforeEach(function () {
            db.chainTip = { blockHeight: 131, blockTime: 1757298240, chainId: LOCAL_ID };
            db.chainTipThrows = false;
            db.seenSql.length = 0;
        });
        for (const table of CROSS_CHAIN_TABLES) {
            it(table + ': the envelope carries btc_chain_id', async function () {
                const res = fakeRes();
                await routes['/hub-db/snapshot/' + table]({ query: {} }, res);
                const env = res.parsed();
                expect(env.table).to.equal(table);
                expect(env.btc_chain_id).to.equal(LOCAL_ID);
                // The identity is read for BITCOIN on the hub's own network: a DOGE mirror
                // must be told the BTC chain the rows are anchored to, not its own.
                expect(db.lastTipArgs).to.deep.equal(['bitcoin', 'regtest']);
            });

            it(table + ': btc_chain_id is null when no indexer has reported one', async function () {
                db.chainTip = null;
                const res = fakeRes();
                await routes['/hub-db/snapshot/' + table]({ query: {} }, res);
                expect(res.parsed().btc_chain_id).to.equal(null);
            });

            it(table + ': an unreadable identity serves null, never a 500', async function () {
                db.chainTipThrows = true;
                const res = fakeRes();
                await routes['/hub-db/snapshot/' + table]({ query: {} }, res);
                expect(res.statusCode).to.equal(200);
                expect(res.parsed().btc_chain_id).to.equal(null);
                expect(res.parsed().rows).to.have.lengthOf(1);
            });
        }

        // cross_chain_calls is the one route with an explicit column list; a column left
        // out there is silently dropped for every bootstrapped row while the streamed
        // (SELECT *) path keeps it, which would disarm the mirror filter on exactly the
        // path the relic rows arrive by.
        it('the cross_chain_calls explicit SELECT list includes the column', async function () {
            const res = fakeRes();
            await routes['/hub-db/snapshot/cross_chain_calls']({ query: {} }, res);
            const sql = db.seenSql.find(s => s.includes('FROM cross_chain_calls'));
            expect(sql).to.include('btc_chain_id');
        });

        it('leaves envelopes for tables outside the cross-chain set unchanged', async function () {
            const res = fakeRes();
            await routes['/hub-db/snapshot/price_snapshots']({ query: {} }, res);
            expect(res.parsed()).to.not.have.property('btc_chain_id');
        });
    });
}

function registerChainTipStorageSuite() {
describe('db.setChainTip / db.getChainTip', function () {
        it('writes chain_id as a chain_tips param under the normalized coin key', async function () {
            const { db } = makeDb();
            const setParam = sinon.stub(db, 'setParam').resolves();
            await db.setChainTip('BTC', 'regtest', 131, 1757298240, LOCAL_ID);
            expect(setParam.calledWith('bitcoin', 'regtest', 'chain_tips', 'chain_id', LOCAL_ID)).to.be.true;
        });

        it('leaves the stored chain_id alone when a push carries none', async function () {
            const { db } = makeDb();
            const setParam = sinon.stub(db, 'setParam').resolves();
            await db.setChainTip('BTC', 'regtest', 131, 1757298240);
            expect(setParam.getCalls().some(c => c.args[3] === 'chain_id'),
                   'an identity-less push must not clear the identity the mirrors filter on').to.be.false;
        });

        it('getChainTip returns chainId null when no identity has been reported', async function () {
            const { db } = makeDb();
            sinon.stub(db, 'getConfig').resolves({ block_height: '131', block_time: '1757298240' });
            expect(await db.getChainTip('BTC', 'regtest')).to.deep.equal({
                blockHeight: 131, blockTime: 1757298240, chainId: null
            });
        });

        it('getChainTip returns the stored identity', async function () {
            const { db } = makeDb();
            sinon.stub(db, 'getConfig').resolves({ block_height: '131', block_time: '1757298240', chain_id: LOCAL_ID });
            expect(await db.getChainTip('BTC', 'regtest')).to.deep.equal({
                blockHeight: 131, blockTime: 1757298240, chainId: LOCAL_ID
            });
        });
    });
}

function registerChainTipPushSuite() {
describe('pushchaintip carries the chain identity', function () {

        before(async function () {
            db = { setChainTip: sinon.stub().resolves(), getChainTip: sinon.stub().resolves(null) };
            ({ methods } = await bootApi(db, 'regtest'));
        });

        beforeEach(function () { db.setChainTip.resetHistory(); });

        registerChainTipIdentityTest();

        // A malformed identity would be stamped onto every later row and would make every
        // mirror refuse rows this hub is authoritative for, so it must never reach the DB.
        registerChainTipValidationTests();

        // An unknown coin must land in the JSON-RPC envelope's ERROR slot, not its result
        // slot. The router routes a RETURNED value to `result` and only a THROWN one to
        // `error`, so while this refusal was returned as { error: '...' } the envelope read
        // { result: { error: '...' } } and any caller checking the envelope's error field
        // alone saw an accepted push. The code matters as much as the throw: -32602 is what
        // lets a caller tell a rejected argument from a hub that failed to serve the call.
        registerChainTipCompatibilityTests();
    });
}

describe('cross-chain chain identity (btc_chain_id)', function () {
    this.timeout(15000);

    afterEach(function () { sinon.restore(); });

    // ────────────────────────────────────────────────────────────────────────
    // Wire 1: indexer -> hub
    // ────────────────────────────────────────────────────────────────────────

    registerChainTipPushSuite();

    // ────────────────────────────────────────────────────────────────────────
    // Hub storage
    // ────────────────────────────────────────────────────────────────────────

    registerChainTipStorageSuite();

    // ────────────────────────────────────────────────────────────────────────
    // The DDL edit IS the migration: alterTableForDrift adds a missing NULL
    // column from the .sql source on every existing install at startup.
    // ────────────────────────────────────────────────────────────────────────

    // ────────────────────────────────────────────────────────────────────────
    // Wire 2: hub -> indexer, the snapshot envelopes
    // ────────────────────────────────────────────────────────────────────────

    registerSnapshotEnvelopeSuite();

    // ────────────────────────────────────────────────────────────────────────
    // The three writers stamp it
    // ────────────────────────────────────────────────────────────────────────

});
