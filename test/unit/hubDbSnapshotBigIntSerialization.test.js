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
// The WS mirror stream serializes through HubDbBroadcaster's bigIntReplacer;
// every /hub-db/snapshot/* REST route used bare res.json(), which THROWS on a
// real BigInt (returning 500) rather than stringifying it the way the WS path
// does. Both were inert only because the connection pool coerces BIGINT
// columns to Number - a pool option, not a serialization fix - so a caller
// that ever sees a real BigInt (a value outside Number.MAX_SAFE_INTEGER, or a
// future pool config change) hit the throw. These tests drive a real BigInt
// through every route and confirm the response matches byte-for-byte what
// HubDbBroadcaster's own WS path produces for the identical row.

const http        = require('http');
const sinon       = require('sinon');
const { expect }  = require('chai');
const proxyquire  = require('proxyquire');
const { waitUntil } = require('../helpers/waitUntil');

// Every /hub-db/snapshot/* route, and one BigInt-bearing column seeded into
// its row: any column works to prove the point (the fault was in the
// serializer, not any particular column), so each uses a column its own
// route actually selects (see the SELECT lists in src/api.js).
const ROUTES = [
    { table: 'price_snapshots',            row: { id: 1, effective_time: 12345678901234567890n } },
    { table: 'oracle_prices',               row: { id: 1, effective_at: 12345678901234567890n } },
    { table: 'cross_chain_matches',         row: { id: 1, status: 'ok', effective_time: 12345678901234567890n } },
    { table: 'capability_snapshots',        row: { id: 1, snapshot_block: 12345678901234567890n } },
    { table: 'cross_chain_calls',           row: { id: 1, status: 'ok', effective_time: 12345678901234567890n } },
    { table: 'state_checkpoints',           row: { id: 1, checkpoint_seq: 12345678901234567890n } },
    { table: 'anchor_reward_attestations',  row: { id: 1, snapshot_block: 12345678901234567890n } },
    { table: 'attestation_responses',       row: { id: 1, effective_time: 12345678901234567890n } }
];

// A db stand-in that ignores WHERE/ORDER/LIMIT (route filtering is covered
// elsewhere, e.g. hubDbAttestationResponsesMirror.test.js) and just returns
// the one seeded row for whichever table the SQL names.
function makeFakeDb() {
    return {
        async doQuery(sql) {
            let text = String(sql);
            let hit  = ROUTES.find((r) => text.includes('FROM ' + r.table));
            return hit ? [{ ...hit.row }] : [];
        }
    };
}

function get(port, path) {
    return new Promise((resolve, reject) => {
        let req = http.request(
            { host: '127.0.0.1', port: port, path: path, method: 'GET' },
            (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => {
                    let parsed = null;
                    try { parsed = JSON.parse(body); } catch (e) { /* left null on a bad body */ }
                    resolve({ status: res.statusCode, body: body, json: parsed });
                });
            }
        );
        req.on('error', reject);
        req.end();
    });
}

function waitForServer(pred) {
    return waitUntil(pred, { timeoutMs: 4000, intervalMs: 10, label: 'api.js to boot and listen' });
}

describe('hub-db snapshot routes: BIGINT serialization matches the WS path', function () {
    this.timeout(15000);

    let port, server;

    before(async function () {
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
            getAttestationRound: sinon.stub().returns(null),
            getProviderRegistry: sinon.stub().returns(null),
            db: makeFakeDb()
        };

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

        server = await waitForServer(() => (capturedServer && capturedServer.listening ? capturedServer : null));
        port = server.address().port;
    });

    after(function () {
        if (server) { try { server.close(); } catch (e) { /* already closed */ } }
        sinon.restore();
    });

    for (const { table, row } of ROUTES) {
        it('GET /hub-db/snapshot/' + table + ' serves a real BigInt without a 500', async function () {
            let res = await get(port, '/hub-db/snapshot/' + table);
            expect(res.status, 'body: ' + res.body).to.equal(200);
            expect(res.json.table).to.equal(table);
            expect(res.json.rows).to.have.lengthOf(1);
        });

        it(table + ': REST BigInt column matches the WS bigIntReplacer stringification', async function () {
            let res = await get(port, '/hub-db/snapshot/' + table);
            let restRow = res.json.rows[0];

            // The real WS broadcaster, undoubled: proxyquire only replaces `ws`
            // (never loaded, just needs its OPEN constant) so bigIntReplacer
            // itself is the actual production module-private function.
            let HubDbBroadcaster = proxyquire('../../src/HubDbBroadcaster', { ws: { OPEN: 1 } });
            let broadcaster = new HubDbBroadcaster({}, { doQuery: async () => [] });
            let ws = { readyState: 1, bufferedAmount: 0, _hubBuffered: 0, send: sinon.stub(), close: sinon.stub(), on: sinon.stub() };
            await broadcaster.addSubscriber(ws);
            ws.send.resetHistory();

            broadcaster.broadcastRow({ table: table, row: row });
            expect(ws.send.calledOnce, table + ': WS never broadcast the row').to.be.true;
            let wsFrame = JSON.parse(ws.send.firstCall.args[0]);

            // Every BigInt column must have become the SAME string on both paths;
            // a numeric drift here (one side truncating to a JS double, the other
            // preserving full precision as a string) is exactly the fork risk row 38
            // exists to close.
            for (const col of Object.keys(row)) {
                if (typeof row[col] === 'bigint') {
                    expect(restRow[col], table + '.' + col + ' (REST)').to.equal(row[col].toString());
                    expect(wsFrame.row[col], table + '.' + col + ' (WS)').to.equal(row[col].toString());
                }
            }
            expect(restRow).to.deep.equal(wsFrame.row);
        });
    }
});

describe('hub-db snapshots: REST and WS share ONE replacer, not two copies', function () {
    // The fault these routes were fixed for is the two feeds disagreeing about a BIGINT.
    // A duplicated one-line replacer would let them drift apart again silently, so the
    // identity is asserted structurally: same function object, not merely same behaviour.
    const HubDbBroadcaster = require('../../src/HubDbBroadcaster');

    it('exports the replacer the broadcaster signs its frames with', function () {
        expect(typeof HubDbBroadcaster.bigIntReplacer).to.equal('function');
        expect(JSON.stringify({ v: 10n }, HubDbBroadcaster.bigIntReplacer)).to.equal('{"v":"10"}');
    });

    it('api.js holds no second copy of it', function () {
        const fs  = require('fs');
        const src = fs.readFileSync(require.resolve('../../src/api.js'), 'utf8');
        expect(src).to.not.match(/const\s+bigIntReplacer\s*=/);
        expect(src).to.match(/\{\s*bigIntReplacer\s*\}\s*=\s*require\(/);
    });
});
