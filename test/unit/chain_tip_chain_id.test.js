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
const { waitUntil } = require('../helpers/waitUntil');

const snapWrite            = require('../../src/lib/capability_snapshot_write.js');
const CrossChainDexEngine  = require('../../src/CrossChainDexEngine.js');
const CrossChainCallEngine = require('../../src/CrossChainCallEngine.js');

// A plausible regtest block-1 hash (lowercase 64 hex) and a foreign one.
const LOCAL_ID   = '00000000c937983704a73af28acdec37b049d214adbda81d7e2a3dd146f6ed09';
const FOREIGN_ID = '000000005c8ba8e1e0a4a2e6f2d3c4b5a6978869fedcba0987654321abcdef01';

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
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
    const env = {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
        HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '0',
        HUB_ALLOW_UNAUTHENTICATED: 'true', HUB_NETWORK: hubNetwork, TELEMETRY_ENABLED: 'false'
    };
    for (const k of ['HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_CONFIG_SECRETS_API_KEY',
                     'HUB_SENSITIVE_READ_AUTH', 'P2P_VALIDATOR_ADDR', ...Object.keys(env)]) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    Object.assign(process.env, env);

    try {
        proxyquireNoCache('../../src/api', {
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
    return {
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
    const Database = proxyquire('../../src/db', {
        mariadb: { createPool: sinon.stub().returns(mockPool), createConnection: sinon.stub().resolves(mockConn) },
        fs: Object.assign({ readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') }, fsOverrides || {}),
        path: require('path')
    });
    return { db: new Database('localhost', 3306, 'test_db', 'user', 'pass'), mockConn, mockPool };
}

describe('cross-chain chain identity (btc_chain_id)', function () {
    this.timeout(15000);

    afterEach(function () { sinon.restore(); });

    // ────────────────────────────────────────────────────────────────────────
    // Wire 1: indexer -> hub
    // ────────────────────────────────────────────────────────────────────────

    describe('pushchaintip carries the chain identity', function () {
        let methods, db;

        before(async function () {
            db = { setChainTip: sinon.stub().resolves(), getChainTip: sinon.stub().resolves(null) };
            ({ methods } = await bootApi(db, 'regtest'));
        });

        beforeEach(function () { db.setChainTip.resetHistory(); });

        it('stores a valid chain_id with the tip', async function () {
            let r = await methods.pushchaintip({ coin: 'BTC', network: 'regtest', block_height: 131, block_time: 1757298240, chain_id: LOCAL_ID });
            expect(r).to.deep.equal({ status: 'success' });
            expect(db.setChainTip.calledOnce).to.be.true;
            expect(db.setChainTip.firstCall.args).to.deep.equal(['BTC', 'regtest', 131, 1757298240, LOCAL_ID]);
        });

        // A malformed identity would be stamped onto every later row and would make every
        // mirror refuse rows this hub is authoritative for, so it must never reach the DB.
        const BAD = {
            'a 63-hex string':      '0'.repeat(63),
            'a 65-hex string':      '0'.repeat(65),
            'uppercase hex':        LOCAL_ID.toUpperCase(),
            'non-hex characters':   'z'.repeat(64),
            'an empty string':      '',
            'a number':             12345,
            'an object':            { hash: LOCAL_ID }
        };
        for (const [label, value] of Object.entries(BAD)) {
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
    });

    // ────────────────────────────────────────────────────────────────────────
    // Hub storage
    // ────────────────────────────────────────────────────────────────────────

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

    // ────────────────────────────────────────────────────────────────────────
    // The DDL edit IS the migration: alterTableForDrift adds a missing NULL
    // column from the .sql source on every existing install at startup.
    // ────────────────────────────────────────────────────────────────────────

    describe('schema: the column ships as DDL drift', function () {
        for (const table of CROSS_CHAIN_TABLES) {
            it(table + ' declares btc_chain_id CHAR(64) NULL', function () {
                const src = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
                expect(src).to.match(/^\s*btc_chain_id\s+CHAR\(64\)\s+NULL,/m);
            });

            it(table + ': an existing install gets the column by ALTER at startup', async function () {
                const src = fs.readFileSync(path.join(SQL_DIR, table + '.sql'), 'utf8');
                const { db, mockConn } = makeDb({ readFileSync: sinon.stub().returns(src) });
                // The live table is the pre-column shape: every source column present
                // EXCEPT btc_chain_id.
                const expected = db.parseExpectedColumns(src).filter(c => c.name !== 'btc_chain_id');
                const conn = {
                    query: sinon.stub().callsFake(async (sql) => {
                        if (/information_schema/.test(sql))
                            return expected.map(c => ({ COLUMN_NAME: c.name, IS_NULLABLE: c.nullable ? 'YES' : 'NO', COLUMN_TYPE: 'varchar(20)' }));
                        return [];
                    })
                };
                sinon.stub(console, 'log');
                await db.alterTableForDrift(table + '.sql', conn);
                const alters = conn.query.getCalls().map(c => String(c.args[0])).filter(s => /ALTER TABLE/.test(s));
                expect(alters, table + ': expected exactly one ALTER').to.have.lengthOf(1);
                expect(alters[0]).to.match(new RegExp('ALTER TABLE `' + table + '` ADD COLUMN btc_chain_id\\s+CHAR\\(64\\)\\s+NULL'));
                expect(mockConn.query.called, 'the drift ALTER must reuse the caller connection').to.be.false;
            });
        }
    });

    // ────────────────────────────────────────────────────────────────────────
    // Wire 2: hub -> indexer, the snapshot envelopes
    // ────────────────────────────────────────────────────────────────────────

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

    // ────────────────────────────────────────────────────────────────────────
    // The three writers stamp it
    // ────────────────────────────────────────────────────────────────────────

    describe('CrossChainDexEngine stamps the match row', function () {
        function engineWith(getChainTip) {
            const eng = Object.create(CrossChainDexEngine.prototype);
            eng.network = 'regtest';
            eng.db = { doQuery: sinon.stub().resolves({ affectedRows: 1 }) };
            if (getChainTip) eng.db.getChainTip = getChainTip;
            return eng;
        }
        const matchRow = () => ({
            match_id: 'm'.repeat(64), snapshot_block: 131, network: 'regtest',
            a_chain: 'BTC', a_action_index: 8, a_kind: 'swap', a_tick: 'XCH', a_amount: '1', a_filled_before: '0', a_ownership: 0, a_payout_addr: 'bc1a', a_payout_legs: null,
            b_chain: 'LTC', b_action_index: 3, b_kind: 'swap', b_tick: 'XCH', b_amount: '2', b_filled_before: '0', b_ownership: 0, b_payout_addr: 'ltc1b', b_payout_legs: null,
            effective_time: 1757298240, finalizing_view: 0, validator_signatures: '[]',
            a_push_generation: 0, b_push_generation: 0
        });

        function insertCall(eng) {
            const call = eng.db.doQuery.getCalls().find(c => /INSERT IGNORE INTO cross_chain_matches/.test(String(c.args[0])));
            expect(call, 'no INSERT was issued').to.not.equal(undefined);
            const cols = String(call.args[0]).match(/\(([^)]*)\) VALUES/)[1].split(',').map(s => s.trim());
            return { cols, vals: call.args[1], idx: cols.indexOf('btc_chain_id') };
        }

        it('writes the identity the Bitcoin indexer reported for the row network', async function () {
            const getChainTip = sinon.stub().resolves({ blockHeight: 131, blockTime: 1, chainId: LOCAL_ID });
            const eng = engineWith(getChainTip);
            await eng._insertMatchRow(matchRow());
            const { cols, vals, idx } = insertCall(eng);
            expect(idx, 'btc_chain_id missing from the INSERT column list').to.be.greaterThan(-1);
            expect(vals).to.have.lengthOf(cols.length);
            expect(vals[idx]).to.equal(LOCAL_ID);
            expect(getChainTip.firstCall.args).to.deep.equal(['bitcoin', 'regtest']);
        });

        it('writes NULL when the hub has not been told its chain', async function () {
            const eng = engineWith(sinon.stub().resolves(null));
            await eng._insertMatchRow(matchRow());
            const { vals, idx } = insertCall(eng);
            expect(vals[idx]).to.equal(null);
        });

        it('writes NULL, and still commits the match, when the identity read throws', async function () {
            const eng = engineWith(sinon.stub().rejects(new Error('configs read failed')));
            const inserted = await eng._insertMatchRow(matchRow());
            expect(inserted, 'a finalized match must never be lost to an identity lookup').to.be.true;
            const { vals, idx } = insertCall(eng);
            expect(vals[idx]).to.equal(null);
        });

        it('does not put the identity on the row object the canonical is built from', async function () {
            const eng = engineWith(sinon.stub().resolves({ chainId: LOCAL_ID }));
            const row = matchRow();
            await eng._insertMatchRow(row);
            expect(row).to.not.have.property('btc_chain_id');
        });
    });

    describe('CrossChainCallEngine stamps the call row', function () {
        function engineWith(chainId) {
            const eng = Object.create(CrossChainCallEngine.prototype);
            eng.network = 'regtest';
            eng.db = {
                doQuery: sinon.stub().resolves({ affectedRows: 1 }),
                getChainTip: sinon.stub().resolves(chainId === null ? null : { blockHeight: 131, blockTime: 1, chainId: chainId })
            };
            eng._persistCapabilitySnapshot = sinon.stub().resolves(1);
            eng._mirrorCallRow = sinon.stub().resolves();
            eng._inflight = new Map();
            eng.emit = sinon.stub();
            return eng;
        }
        const callRow = () => ({
            call_id: 'c'.repeat(64), phase: 'dispatch', snapshot_block: 131, network: 'regtest',
            source_chain: 'BTC', source_action_index: 41, source_contract_index: 5,
            target_chain: 'DOGE', target_contract_index: 99, method: 'onArrival', params_json: '["x"]',
            gas_limit: 50000, cross_hops: 1, effective_time: 1757298240,
            result_status: null, return_payload_b64: null, push_generation: 0, round_id: 'r1'
        });

        it('stamps the identity and re-stamps it on the ON DUPLICATE KEY UPDATE path', async function () {
            const eng = engineWith(LOCAL_ID);
            sinon.stub(console, 'log');
            await eng._writeFinalizedRow({ row: callRow(), signatures: [] });
            const call = eng.db.doQuery.getCalls().find(c => /INSERT INTO cross_chain_calls/.test(String(c.args[0])));
            expect(call, 'no INSERT was issued').to.not.equal(undefined);
            const sql  = String(call.args[0]);
            const cols = sql.match(/\(([^)]*)\) VALUES/)[1].split(',').map(s => s.trim());
            const idx  = cols.indexOf('btc_chain_id');
            expect(idx, 'btc_chain_id missing from the INSERT column list').to.be.greaterThan(-1);
            expect(call.args[1][idx]).to.equal(LOCAL_ID);
            // A row revived after a reorg must not keep the identity of the chain it was
            // first written on.
            expect(sql).to.include('btc_chain_id = VALUES(btc_chain_id)');
        });

        it('stamps NULL when the hub has not been told its chain', async function () {
            const eng = engineWith(null);
            sinon.stub(console, 'log');
            await eng._writeFinalizedRow({ row: callRow(), signatures: [] });
            const call = eng.db.doQuery.getCalls().find(c => /INSERT INTO cross_chain_calls/.test(String(c.args[0])));
            const cols = String(call.args[0]).match(/\(([^)]*)\) VALUES/)[1].split(',').map(s => s.trim());
            expect(call.args[1][cols.indexOf('btc_chain_id')]).to.equal(null);
        });
    });

    describe('capability_snapshots writer stamps every row', function () {
        const VALIDATORS = [
            { pubkey: 'AA'.repeat(32), weight: '10', source: 'src-a' },
            { pubkey: 'bb'.repeat(32), weight: '20', source: 'src-b' }
        ];
        function memDb(getChainTip) {
            const db = { calls: [], async doQuery(sql, params) { this.calls.push({ sql: String(sql), params }); return []; } };
            if (getChainTip) db.getChainTip = getChainTip;
            return db;
        }
        function stampedIds(db) {
            const { sql, params } = db.calls[0];
            const cols = sql.match(/\(([^)]*)\) VALUES/)[1].split(',').map(s => s.trim());
            const idx  = cols.indexOf('btc_chain_id');
            expect(idx, 'btc_chain_id missing from the INSERT column list').to.be.greaterThan(-1);
            const out = [];
            for (let i = 0; i < params.length; i += cols.length) out.push(params[i + idx]);
            return out;
        }

        it('stamps the identity the caller passes on every row of the set', async function () {
            const db = memDb();
            await snapWrite.writeCapabilitySnapshotRows(db, 'cross_chain', 131, VALIDATORS, LOCAL_ID);
            expect(stampedIds(db)).to.deep.equal([LOCAL_ID, LOCAL_ID]);
        });

        it('resolves the identity itself for a four-argument caller', async function () {
            const getChainTip = sinon.stub().resolves({ blockHeight: 131, blockTime: 1, chainId: LOCAL_ID });
            const db = memDb(getChainTip);
            await snapWrite.writeCapabilitySnapshotRows(db, 'cross_chain', 131, VALIDATORS);
            expect(stampedIds(db)).to.deep.equal([LOCAL_ID, LOCAL_ID]);
            expect(getChainTip.firstCall.args[0]).to.equal('bitcoin');
        });

        it('stamps NULL when the database layer exposes no getChainTip at all', async function () {
            const db = memDb();
            await snapWrite.writeCapabilitySnapshotRows(db, 'cross_chain', 131, VALIDATORS);
            expect(stampedIds(db)).to.deep.equal([null, null]);
        });

        it('stamps NULL, and still writes the set, when the identity read throws', async function () {
            const db = memDb(sinon.stub().rejects(new Error('configs read failed')));
            const rows = await snapWrite.writeCapabilitySnapshotRows(db, 'cross_chain', 131, VALIDATORS);
            expect(rows).to.have.lengthOf(2);
            expect(stampedIds(db)).to.deep.equal([null, null]);
        });

        it('keeps the whole set in ONE statement (the atomicity the writer exists for)', async function () {
            const db = memDb();
            await snapWrite.writeCapabilitySnapshotRows(db, 'cross_chain', 131, VALIDATORS, LOCAL_ID);
            expect(db.calls).to.have.lengthOf(1);
        });
    });

    // ────────────────────────────────────────────────────────────────────────
    // Transport, not consensus (D4 / ATr3)
    // ────────────────────────────────────────────────────────────────────────

    describe('the identity reaches no signed canonical', function () {
        it('_canonicalMatch is byte-identical with and without btc_chain_id on the row', function () {
            const eng = Object.create(CrossChainDexEngine.prototype);
            const row = {
                match_id: 'm'.repeat(64), snapshot_block: 131, network: 'regtest',
                a_chain: 'BTC', a_action_index: 8, a_tick: 'XCH', a_amount: '1', a_ownership: 0, a_payout_addr: 'bc1a',
                b_chain: 'LTC', b_action_index: 3, b_tick: 'XCH', b_amount: '2', b_ownership: 0, b_payout_addr: 'ltc1b',
                effective_time: 1757298240, a_kind: 'swap', a_filled_before: '0', b_kind: 'swap', b_filled_before: '0',
                a_payout_legs: null, b_payout_legs: null
            };
            const bare    = eng._canonicalMatch(row, 0);
            const stamped = eng._canonicalMatch(Object.assign({}, row, { btc_chain_id: FOREIGN_ID }), 0);
            expect(stamped).to.equal(bare);
            expect(bare).to.not.include(FOREIGN_ID);
        });
    });
});
