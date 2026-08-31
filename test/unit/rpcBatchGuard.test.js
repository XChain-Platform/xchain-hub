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

const { resolveMaxBatch, makeRpcBatchGuard } = require('../../src/rpcBatchGuard.js');

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

describe('JSON-RPC batch cap', function () {
    this.timeout(10000);

    it('reproduces the fan-out WITHOUT the guard (21 calls dispatch 21 handlers)', async () => {
        const counter = { calls: 0 };
        const r = await post(buildApp(false, counter), batch(CAP + 1));
        assert.strictEqual(r.status, 200, 'unguarded router should have served the oversize batch');
        assert.strictEqual(counter.calls, CAP + 1, 'every element should have reached a handler without the guard');
    });

    it('rejects an over-cap batch with 400 / -32600 and dispatches nothing', async () => {
        const counter = { calls: 0 };
        const r = await post(buildApp(true, counter), batch(CAP + 1));
        assert.strictEqual(r.status, 400);
        const body = JSON.parse(r.text);
        assert.strictEqual(body.error.code, -32600);
        assert.match(body.error.message, /Batch too large \(max 20 requests per call\)/);
        assert.strictEqual(counter.calls, 0, 'no handler may run once the batch is refused');
    });

    it('passes an at-cap batch through to the dispatcher', async () => {
        const counter = { calls: 0 };
        const r = await post(buildApp(true, counter), batch(CAP));
        assert.strictEqual(r.status, 200);
        assert.strictEqual(counter.calls, CAP);
        assert.strictEqual(JSON.parse(r.text).length, CAP);
    });

    it('leaves a single (non-array) call untouched', async () => {
        const counter = { calls: 0 };
        const r = await post(buildApp(true, counter), { jsonrpc: '2.0', id: 1, method: 'getprice' });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(JSON.parse(r.text).result, { price: 1 });
        assert.strictEqual(counter.calls, 1);
    });

    it('leaves a bodiless GET to the req.body shim (no 500, no 400)', async () => {
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
    });

    describe('resolveMaxBatch', () => {
        it('keeps the default for missing, unparseable and non-positive values', () => {
            for (const raw of [undefined, null, '', 'abc', '0', '-5'])
                assert.strictEqual(resolveMaxBatch(raw, 20), 20, `raw=${JSON.stringify(raw)}`);
        });
        it('takes an explicit positive override', () => {
            assert.strictEqual(resolveMaxBatch('50', 20), 50);
        });
    });

    it('src/api.js mounts the guard before the jsonRouter mount', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
        const guardIdx = src.indexOf('makeRpcBatchGuard(');
        const routerIdx = src.indexOf('jsonRouter({');
        assert.notStrictEqual(guardIdx, -1, 'batch guard mount missing from src/api.js');
        assert.notStrictEqual(routerIdx, -1, 'jsonRouter mount missing from src/api.js');
        assert.ok(guardIdx < routerIdx, 'the batch guard must be registered before the jsonRouter mount');
    });
});
