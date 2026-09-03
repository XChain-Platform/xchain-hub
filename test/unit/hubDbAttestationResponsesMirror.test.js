'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// The two hub registration surfaces the attestation_responses mirror needs
// (the ATTEST response mirror design, §3.4): the REST bootstrap route and the
// WS ready frame's max_ids entry. There is no generic registry behind either, so
// both are hand-written and both fail SILENTLY when they are missing - a bootstrapping
// indexer simply 404s, and an absent max_ids key gates the consumer's gap catch-up
// off with no log line (the per-table catch in addSubscriber is empty by design).
//
// The route is driven through a REAL express app on a real socket rather than by
// calling the captured handler with a fake res: the express app is what carries the
// /hub-db/snapshot auth middleware and the query parsing, and a handler called
// directly exercises neither.

const http               = require('http');
const sinon              = require('sinon');
const { expect }         = require('chai');
const proxyquire         = require('proxyquire');

const TABLE = 'attestation_responses';

// One full mirror row, every column the table defines, so a column dropped from the
// route's SELECT list shows up as a missing key rather than as a silently thinner row.
const COLUMNS = [
    'id', 'network', 'request_id', 'request_action_index', 'request_block_index',
    'provider_id', 'status', 'response_payload', 'response_hash', 'meta',
    'effective_time', 'signer_pubkeys', 'signatures', 'widen', 'finalized_at'
];

function makeRow(id) {
    return {
        id:                   id,
        network:              'regtest',
        request_id:           String(id).padStart(64, 'a'),
        request_action_index: 1000 + id,
        request_block_index:  500 + id,
        provider_id:          'http_get',
        status:               'ok',
        response_payload:     'body-' + id,
        response_hash:        String(id).padStart(64, 'b'),
        meta:                 '{}',
        effective_time:       1757000000 + id,
        signer_pubkeys:       '["pk1","pk2"]',
        signatures:           '[{"pubkey":"pk1","sig":"s1"}]',
        widen:                0,
        finalized_at:         1757000100 + id
    };
}

// A db stand-in that actually honours the WHERE / ORDER BY / LIMIT the route sends,
// so paging and the limit clamp are observed rather than asserted against a stub's
// recorded arguments. Anything but a plain page-walk against a known table returns [].
//
// The id filter and the row cap are applied only when the SQL ASKS for them, not
// blindly from the bind list: a fake that filtered on params[0] regardless would keep
// paging "working" after the `id > ?` comparison was deleted from the query, which is
// the one mistake this whole test file has to be able to see.
function makeFakeDb(rowsByTable) {
    return {
        calls: [],
        async doQuery(sql, params) {
            this.calls.push({ sql: String(sql), params: params });
            let text  = String(sql);
            let table = Object.keys(rowsByTable).find(t => text.includes('FROM ' + t));
            if (!table) return [];
            if (/MAX\(id\)/i.test(text)) {
                let ids = rowsByTable[table].map(r => r.id);
                return [{ max_id: ids.length ? Math.max(...ids) : null }];
            }
            let binds = (params || []).slice();
            let since = /\bid\s*>\s*\?/.test(text) ? binds.shift() : -Infinity;
            let limit = /\bLIMIT\s+\?/i.test(text) ? binds.shift() : Infinity;
            let selected = COLUMNS;
            let m = text.match(/^SELECT\s+([\s\S]+?)\s+FROM\s/i);
            if (m) selected = m[1].split(',').map(s => s.trim());
            return rowsByTable[table]
                .filter(r => r.id > since)
                .sort((a, b) => a.id - b.id)
                .slice(0, limit)
                .map(r => {
                    if (selected.length === 1 && selected[0] === '*') return { ...r };
                    let out = {};
                    for (const col of selected) if (col in r) out[col] = r[col];
                    return out;
                });
        }
    };
}

function get(port, path, headers) {
    return new Promise((resolve, reject) => {
        let req = http.request(
            { host: '127.0.0.1', port: port, path: path, method: 'GET', headers: headers || {} },
            (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => {
                    let parsed = null;
                    try { parsed = JSON.parse(body); } catch (e) { /* non-JSON body stays null */ }
                    resolve({ status: res.statusCode, body: body, json: parsed });
                });
            }
        );
        req.on('error', reject);
        req.end();
    });
}

function waitUntil(pred, label) {
    return new Promise((resolve, reject) => {
        let deadline = Date.now() + 4000;
        let tick = () => {
            let v = pred();
            if (v) return resolve(v);
            if (Date.now() > deadline) return reject(new Error('timed out waiting for ' + label));
            setTimeout(tick, 10);
        };
        tick();
    });
}

describe('attestation_responses: the hub mirror registration surfaces', function () {
    this.timeout(15000);

    // ── The REST bootstrap route, driven over a real socket ──────────────────
    describe('GET /hub-db/snapshot/attestation_responses', function () {
        let port, fakeDb, server;

        before(async function () {
            fakeDb = makeFakeDb({ [TABLE]: [1, 2, 3, 4, 5].map(makeRow) });

            let capturedServer = null;
            let realExpress    = require('express');
            let passthrough    = () => (req, res, next) => next();
            let mockHub = {
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
                db: fakeDb
            };

            // Real express and a real http server; only the hub, the DB and the
            // WS/gossip machinery are stood in for.
            let mockHttp = {
                createServer: (app) => { capturedServer = http.createServer(app); return capturedServer; }
            };
            let mockWsLib = function () {};
            mockWsLib.Server = function () { return { on: sinon.stub(), close: sinon.stub() }; };
            mockWsLib.OPEN   = 1;

            let origEnv = {};
            let envVars = {
                HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
                HUB_DB_USER: 'root', HUB_DB_PASS: 'pass',
                HUB_PORT: '0', HUB_HOST: '127.0.0.1',
                // Keyless on purpose: the /hub-db/snapshot middleware is a pass-through
                // without a key, which is the shape this route has to work under on
                // regtest and under xchain-node-managed deploys.
                HUB_API_KEY: '', HUB_ALLOW_UNAUTHENTICATED: 'true',
                TELEMETRY_ENABLED: 'false'
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
                    './XChainHub': function () { return mockHub; }
                });
            } finally {
                for (let [k, v] of Object.entries(origEnv)) {
                    if (v === undefined) delete process.env[k];
                    else process.env[k] = v;
                }
            }

            // The listening socket is what "boot finished" means here: every route is
            // registered before server.listen() is reached.
            server = await waitUntil(
                () => (capturedServer && capturedServer.listening ? capturedServer : null),
                'api.js to boot and listen');
            port = server.address().port;
        });

        after(function () {
            if (server) { try { server.close(); } catch (e) { /* already closed */ } }
            sinon.restore();
        });

        it('serves the snapshot envelope with every mirrored column', async function () {
            let res = await get(port, '/hub-db/snapshot/' + TABLE);
            expect(res.status).to.equal(200);
            expect(res.json.table).to.equal(TABLE);
            expect(res.json.count).to.equal(5);
            expect(res.json.rows).to.have.lengthOf(5);
            expect(res.json.watermark).to.be.a('number');
            expect(res.json.schema_version).to.be.a('number');
            expect(Object.keys(res.json.rows[0]).sort()).to.deep.equal([...COLUMNS].sort());
        });

        it('issues an explicit column list, never SELECT *', async function () {
            fakeDb.calls.length = 0;
            await get(port, '/hub-db/snapshot/' + TABLE);
            let call = fakeDb.calls.find(c => c.sql.includes('FROM ' + TABLE));
            expect(call, 'the route never queried ' + TABLE).to.exist;
            // SELECT * makes the REST feed track the hub table while the WS stream keeps
            // sending whatever the broadcaster built, so the two mirrors diverge on the
            // next column the hub gains.
            expect(call.sql).to.not.match(/SELECT\s+\*/i);
            for (const col of COLUMNS) expect(call.sql, 'column ' + col + ' missing').to.include(col);
        });

        it('pages on since_id', async function () {
            let res = await get(port, '/hub-db/snapshot/' + TABLE + '?since_id=3');
            expect(res.status).to.equal(200);
            expect(res.json.count).to.equal(2);
            expect(res.json.rows.map(r => r.id)).to.deep.equal([4, 5]);
        });

        it('clamps limit to 10000 and honours a smaller one', async function () {
            let small = await get(port, '/hub-db/snapshot/' + TABLE + '?limit=2');
            expect(small.json.rows.map(r => r.id)).to.deep.equal([1, 2]);

            fakeDb.calls.length = 0;
            let capped = await get(port, '/hub-db/snapshot/' + TABLE + '?limit=10000');
            expect(capped.status).to.equal(200);
            let call = fakeDb.calls.find(c => c.sql.includes('FROM ' + TABLE));
            expect(call.params[1]).to.equal(10000);

            // Above the cap validateLimit rejects outright rather than silently clamping,
            // matching every other snapshot route.
            let over = await get(port, '/hub-db/snapshot/' + TABLE + '?limit=10001');
            expect(over.status).to.equal(400);
            expect(over.json.error).to.include('limit');
        });

        ['5junk', '1e3', '5.5', '-5', ' 5', '0x32'].forEach((bad) => {
            it('rejects a partial-integer since_id ' + JSON.stringify(bad), async function () {
                let res = await get(port, '/hub-db/snapshot/' + TABLE + '?since_id=' + encodeURIComponent(bad));
                expect(res.status).to.equal(400);
                expect(res.json.error).to.include('since_id');
            });
        });
    });

    // ── The WS ready frame ───────────────────────────────────────────────────
    describe('HubDbBroadcaster ready frame', function () {
        let HubDbBroadcaster;

        before(function () {
            HubDbBroadcaster = proxyquire('../../src/HubDbBroadcaster', { ws: { OPEN: 1 } });
        });

        function makeMockWs() {
            let ws = { readyState: 1, bufferedAmount: 0, _hubBuffered: 0, send: sinon.stub(), close: sinon.stub(), on: sinon.stub() };
            return ws;
        }

        it('advertises a numeric max_id for attestation_responses', async function () {
            let db = makeFakeDb({ [TABLE]: [1, 2, 3, 4, 5, 6, 7].map(makeRow) });
            let b  = new HubDbBroadcaster({}, db);
            let ws = makeMockWs();
            await b.addSubscriber(ws);

            expect(ws.send.calledOnce).to.be.true;
            let frame = JSON.parse(ws.send.firstCall.args[0]);
            expect(frame.type).to.equal('ready');
            // A missing key is the silent failure this test exists for: the consumer
            // skips any table the frame does not name, with nothing logged on either side.
            expect(frame.max_ids, 'ready frame omits ' + TABLE + ', so the consumer never runs its gap catch-up for it')
                .to.have.property(TABLE);
            expect(frame.max_ids[TABLE]).to.be.a('number');
            expect(frame.max_ids[TABLE]).to.equal(7);
        });

        it('asks for the ceiling unfiltered, because the table is never retracted', async function () {
            let db = makeFakeDb({ [TABLE]: [makeRow(1)] });
            let b  = new HubDbBroadcaster({}, db);
            await b.addSubscriber(makeMockWs());
            let call = db.calls.find(c => c.sql.includes('FROM ' + TABLE));
            expect(call, 'no MAX(id) query was issued for ' + TABLE).to.exist;
            // A status filter here would advertise a ceiling below what the snapshot feed
            // serves, and the consumer's local max would never reach it.
            expect(call.sql).to.not.include('status');
        });

        it('reports 0, not a missing key, when the table is empty', async function () {
            let db = makeFakeDb({ [TABLE]: [] });
            let b  = new HubDbBroadcaster({}, db);
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            let frame = JSON.parse(ws.send.firstCall.args[0]);
            expect(frame.max_ids).to.have.property(TABLE, 0);
        });
    });
});
