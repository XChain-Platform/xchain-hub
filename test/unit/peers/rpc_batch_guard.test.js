/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

// Regression test for the unbounded JSON-RPC batch fan-out on the hub.
//
// express-json-rpc-router runs every element of a batch array concurrently,
// while the per-IP rate limiter in front of it charges one token per HTTP
// REQUEST. A single ~100 KB body of ~1,400 small call objects therefore
// amplified into ~1,400 concurrent handlers on the shared MariaDB pool for the
// price of one token, and on a keyless deploy that set included the push*
// write rails.
//
// The chain is rebuilt from THIS service's own dependency versions and handler
// invocations are COUNTED, so the control case demonstrates the amplification
// rather than asserting a status code against nothing.

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const jsonRouter = require('express-json-rpc-router');

const { resolveMaxBatch, makeRpcBatchGuard } = require('../../../src/peers/rpc_batch_guard.js');

const CAP = 20;

function buildApp(withGuard, counter) {
    const app = express();
    app.use(express.json());
    if (withGuard) app.use(makeRpcBatchGuard(CAP));
    app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
    app.use(jsonRouter({ methods: { getprice: () => { counter.calls++; return { price: 1 }; } } }));
    app.use((err, req, res, next) => { res.status(500).json({ error: 'internal' }); }); // eslint-disable-line no-unused-vars
    return app;
}

async function post(app, body) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return { status: res.status, text: await res.text() };
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

const batch = (n) => Array.from({ length: n }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'getprice' }));

{

    const reproducesTheFanOutWithoutTheTest2 = async () => {
        const counter = { calls: 0 };
        const r = await post(buildApp(false, counter), batch(CAP + 1));
        assert.strictEqual(r.status, 200, 'unguarded router should have served the oversize batch');
        assert.strictEqual(counter.calls, CAP + 1, 'every element should have reached a handler without the guard');
    };

    const rejectsAnOverCapBatchWithTest3 = async () => {
        const counter = { calls: 0 };
        const r = await post(buildApp(true, counter), batch(CAP + 1));
        assert.strictEqual(r.status, 400);
        const body = JSON.parse(r.text);
        assert.strictEqual(body.error.code, -32600);
        assert.match(body.error.message, /Batch too large \(max 20 requests per call\)/);
        assert.strictEqual(counter.calls, 0, 'no handler may run once the batch is refused');
    };

    const passesAnAtCapBatchThroughTest4 = async () => {
        const counter = { calls: 0 };
        const r = await post(buildApp(true, counter), batch(CAP));
        assert.strictEqual(r.status, 200);
        assert.strictEqual(counter.calls, CAP);
        assert.strictEqual(JSON.parse(r.text).length, CAP);
    };

    const leavesASingleNonArrayCallTest5 = async () => {
        const counter = { calls: 0 };
        const r = await post(buildApp(true, counter), { jsonrpc: '2.0', id: 1, method: 'getprice' });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(JSON.parse(r.text).result, { price: 1 });
        assert.strictEqual(counter.calls, 1);
    };

    const leavesABodilessGetToTheTest6 = async () => {
        const server = http.createServer(buildApp(true, { calls: 0 }));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/`);
            assert.notStrictEqual(res.status, 500, 'the batch guard must not disturb the bodiless-GET path');
            assert.notStrictEqual(res.status, 400);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    };

    const rejectsNonObjectElementsCleanly = async () => {
        const bodies = [
            [null],
            [{ jsonrpc: '2.0', method: 'getprice', id: 1 }, null],
            [1, 2], [true], ['x'], [[]]
        ];
        for (const b of bodies) {
            const counter = { calls: 0 };
            const server = http.createServer(buildApp(true, counter));
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            try {
                const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(b)
                });
                const text = await res.text();
                const label = JSON.stringify(b);
                assert.strictEqual(res.status, 400, label);
                assert.match(res.headers.get('content-type'), /application\/json/, label);
                const parsed = JSON.parse(text);
                assert.strictEqual(parsed.jsonrpc, '2.0', label);
                assert.strictEqual(parsed.id, null, label);
                assert.strictEqual(parsed.error.code, -32600, label);
                assert.ok(!/TypeError|node_modules/.test(text), label);
                assert.strictEqual(counter.calls, 0, 'router must not dispatch: ' + label);
            } finally {
                await new Promise((resolve) => server.close(resolve));
            }
        }
    };

    const rejectsEmptyAndMethodlessBatches = async () => {
        const bodies = [
            [],
            [{}],
            [{ jsonrpc: '2.0', method: 'getprice', id: 1 }, {}],
            [{ jsonrpc: '2.0', id: 1 }],
            [{ jsonrpc: '2.0', method: 5, id: 1 }]
        ];
        for (const b of bodies) {
            const label = JSON.stringify(b);
            let nextCalled = false;
            let status = null;
            let payload = null;
            const res = {
                status(s) { status = s; return this; },
                json(p) { payload = p; return this; }
            };
            makeRpcBatchGuard(CAP)({ body: b }, res, () => { nextCalled = true; });
            assert.strictEqual(nextCalled, false, label);
            assert.strictEqual(status, 400, label);
            assert.deepStrictEqual(payload, {
                jsonrpc: '2.0', id: null,
                error: { code: -32600, message: 'Invalid Request' }
            }, label);
        }
        // Valid batch and single call object still pass.
        for (const ok of [[{ jsonrpc: '2.0', method: 'ping', id: 1 }], { jsonrpc: '2.0', method: 'ping', id: 1 }]) {
            let nextCalled = false;
            makeRpcBatchGuard(CAP)({ body: ok }, { status() { throw new Error('refused'); } }, () => { nextCalled = true; });
            assert.strictEqual(nextCalled, true);
        }
    };

    let registerresolvemaxbatch7;

    {

        const keepsTheDefaultForMissingUnparseableTest9 = () => {
            for (const raw of [undefined, null, '', 'abc', '0', '-5'])
                assert.strictEqual(resolveMaxBatch(raw, 20), 20, `raw=${JSON.stringify(raw)}`);
        };

        const takesAnExplicitPositiveOverrideTest10 = () => {
            assert.strictEqual(resolveMaxBatch('50', 20), 50);
        };

        const resolvemaxbatchSuite8 = () => {
            it('keeps the default for missing, unparseable and non-positive values', keepsTheDefaultForMissingUnparseableTest9);
            it('takes an explicit positive override', takesAnExplicitPositiveOverrideTest10);
        }

        registerresolvemaxbatch7 = function registerSuite() {
            describe('resolveMaxBatch', resolvemaxbatchSuite8);
        };

    }

    const srcApiJsMountsTheGuardTest11 = () => {
        const boot = fs.readFileSync(path.join(__dirname, '../../../src/api.js'), 'utf8');
        const src = fs.readFileSync(path.join(__dirname, '../../../src/api/server.js'), 'utf8');
        const guardIdx = src.indexOf('makeRpcBatchGuard(');
        const routerIdx = src.indexOf('jsonRouter({');
        assert.notStrictEqual(boot.indexOf('createApp(ctx)'), -1, 'api.js must use the shared app builder');
        assert.notStrictEqual(guardIdx, -1, 'batch guard mount missing from the shared app builder');
        assert.notStrictEqual(routerIdx, -1, 'jsonRouter mount missing from the shared app builder');
        assert.ok(guardIdx < routerIdx, 'the batch guard must be registered before the jsonRouter mount');
    };

    function jsonRpcBatchCapSuite1() {
        this.timeout(10000);
        it('reproduces the fan-out WITHOUT the guard (21 calls dispatch 21 handlers)', reproducesTheFanOutWithoutTheTest2);
        it('rejects an over-cap batch with 400 / -32600 and dispatches nothing', rejectsAnOverCapBatchWithTest3);
        it('passes an at-cap batch through to the dispatcher', passesAnAtCapBatchThroughTest4);
        it('answers a batch with a null or non-object element with a clean JSON 400 / -32600', rejectsNonObjectElementsCleanly);
        it('answers an empty batch or a method-less member with 400 / -32600 and calls next() for valid input', rejectsEmptyAndMethodlessBatches);
        it('leaves a single (non-array) call untouched',leavesASingleNonArrayCallTest5);
        it('leaves a bodiless GET to the req.body shim (no 500, no 400)', leavesABodilessGetToTheTest6);
        registerresolvemaxbatch7();
        it('createApp mounts the guard before the jsonRouter mount', srcApiJsMountsTheGuardTest11);
    }

    describe('JSON-RPC batch cap', jsonRpcBatchCapSuite1);

}

// Memory amplification through batched getpricesnapshots pages.
//
// The batch cap bounds members per call, not what each member reads: unbounded, one
// 20-member batch at limit=10000 reads 200,000 rows (about 174 MB of JSON). The bound
// is the hub-wide in-flight gate on getpricesnapshots, which sheds members past it at
// admission, so a batch serializes at most the gate's worth of full pages and
// concurrent batches share that one budget.
//
// The full chain is rebuilt from this service's own dependencies: express JSON
// parsing, the batch guard, the body shim and express-json-rpc-router over the real
// oracle handlers, with only the hub's page read stubbed.
{
    const { buildOracleRpc } = require('../../../src/api/rpc/oracle.js');

    const BATCH = 20;
    const PAGE = 10000;
    const SNAPSHOT_GATE = 3;   // the oracle gate's default in-flight bound
    const RATE_LIMIT_CODE = -32029;

    // A hub whose page reads build a full PAGE of rows and hold them across a
    // scheduler turn, the way a pool read keeps its result live until it resolves.
    // The gate admits or sheds every batch member before its first await, so one
    // turn is enough to keep the admitted reads in flight together.
    function rowCountingHub() {
        const state = { reads: 0, rows: 0, inFlight: 0, peak: 0 };
        const hub = {
            network: 'regtest',
            async getPriceSnapshots(limit) {
                state.reads++;
                state.inFlight++;
                state.peak = Math.max(state.peak, state.inFlight);
                try {
                    const rows = Array.from({ length: limit }, (_, i) => ({ id: i, coin_pair: 'BTC/USD', price: '1.00' }));
                    state.rows += rows.length;
                    await new Promise((r) => setTimeout(r, 0));
                    return rows;
                } finally {
                    state.inFlight--;
                }
            },
            async oracleMaxAgeSecondsInForce() { return 600; }
        };
        return { hub, state };
    }

    function buildSnapshotApp(hub) {
        const app = express();
        app.use(express.json({ limit: '1mb' }));
        app.use(makeRpcBatchGuard(CAP));
        app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
        app.use(jsonRouter({ methods: buildOracleRpc({ hub, hubConfig: {} }) }));
        return app;
    }

    async function postMany(app, bodies) {
        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        try {
            return await Promise.all(bodies.map(async (body) => {
                const res = await fetch(`http://127.0.0.1:${port}/`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                return { status: res.status, text: await res.text() };
            }));
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }

    const snapshotBatch = (limit) => Array.from({ length: BATCH }, (_, i) =>
        ({ jsonrpc: '2.0', id: i, method: 'getpricesnapshots', params: { limit } }));

    function splitMembers(text) {
        const members = JSON.parse(text);
        assert.ok(Array.isArray(members), 'a batch answers with an array');
        const served = members.filter((m) => Array.isArray(m.result));
        const shed = members.filter((m) => m.result && m.result.code === RATE_LIMIT_CODE);
        return { members, served, shed };
    }

    const boundsOneFullPageBatch = async () => {
        const { hub, state } = rowCountingHub();
        const [r] = await postMany(buildSnapshotApp(hub), [snapshotBatch(PAGE)]);
        assert.strictEqual(r.status, 200);
        const { members, served, shed } = splitMembers(r.text);
        assert.strictEqual(members.length, BATCH, 'every member gets an answer');
        assert.ok(served.length >= 1, 'the batch still serves pages');
        assert.ok(served.length <= SNAPSHOT_GATE, 'served ' + served.length + ' full pages in one batch');
        assert.strictEqual(served.length + shed.length, BATCH, 'every unserved member is shed in-band');
        for (const m of shed) assert.ok(m.result.data.retryAfterSeconds >= 1);
        assert.ok(state.rows <= SNAPSHOT_GATE * PAGE,
            'one request materialized ' + state.rows + ' rows (unbounded: ' + BATCH * PAGE + ')');
        // One full page serializes to roughly 0.5 MB with these rows; the unbounded
        // batch was 20 of them.
        const onePage = JSON.stringify(served[0].result).length;
        assert.ok(r.text.length < (SNAPSHOT_GATE + 1) * onePage,
            'response was ' + r.text.length + ' bytes for a page of ' + onePage);
    };

    const boundsConcurrentFullPageBatches = async () => {
        const clients = 10;
        const { hub, state } = rowCountingHub();
        const results = await postMany(buildSnapshotApp(hub), Array.from({ length: clients }, () => snapshotBatch(PAGE)));
        let servedTotal = 0;
        for (const r of results) {
            assert.strictEqual(r.status, 200);
            const { members, served, shed } = splitMembers(r.text);
            assert.strictEqual(members.length, BATCH);
            assert.strictEqual(served.length + shed.length, BATCH);
            servedTotal += served.length;
        }
        assert.ok(state.peak <= SNAPSHOT_GATE,
            'concurrent batches held ' + state.peak + ' full pages live at once');
        assert.strictEqual(state.reads, servedTotal, 'a shed member never reaches the page read');
        assert.ok(servedTotal < clients * BATCH, 'concurrent batches were all served in full');
    };

    const servesASingleFullPageCall = async () => {
        const { hub, state } = rowCountingHub();
        const [r] = await postMany(buildSnapshotApp(hub),
            [{ jsonrpc: '2.0', id: 1, method: 'getpricesnapshots', params: { limit: PAGE } }]);
        assert.strictEqual(r.status, 200);
        const body = JSON.parse(r.text);
        assert.ok(Array.isArray(body.result));
        assert.strictEqual(body.result.length, PAGE);
        assert.strictEqual(state.rows, PAGE);
    };

    describe('JSON-RPC batched getpricesnapshots memory bound', function () {
        this.timeout(20000);
        it('a 20-member batch at limit 10000 materializes at most the in-flight gate of full pages', boundsOneFullPageBatch);
        it('ten concurrent full-page batches share one in-flight budget', boundsConcurrentFullPageBatches);
        it('a single call at limit 10000 is still served in full', servesASingleFullPageCall);
    });
}
