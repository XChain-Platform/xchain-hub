/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 *
 * XChain Hub - the rate limit counts a request before the body parser answers it.
 *
 * A POST the JSON parser refuses (400 malformed, 413 oversize) used to be answered
 * ahead of the per-IP limiter, so any source could send them at any rate. These
 * tests drive the real transport stack with a tiny budget and assert that such
 * requests spend it and are then refused with a 429, while a valid call routes.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const http       = require('http');
const { installTransportMiddleware } = require('../../../src/api/middleware.js');

const BUDGET = 3;
let server = null;
let port   = 0;

function boot() {
    const app = express();
    installTransportMiddleware(app, {
        hubConfig: {},
        logger: { info() {}, warn() {} },
        express, helmet, cors, rateLimit,
        CORS_ORIGIN: '*',
        HUB_RATE_LIMIT_RPM: BUDGET,
        HUB_RATE_LIMIT_EXEMPT_LOCAL: false
    });
    app.post('/echo', (req, res) => res.json({ got: req.body }));
    return new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
    });
}

function post(body) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/echo', method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, text }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

async function statuses(body, count) {
    const out = [];
    for (let i = 0; i < count; i++) out.push((await post(body)).status);
    return out;
}

describe('hub rate limit ahead of the JSON body parser', () => {
    beforeEach(async () => { await boot(); });
    afterEach((done) => { server.close(() => done()); });

    it('counts malformed JSON and refuses it with a 429 once the budget is spent', async () => {
        expect(await statuses('{bad', BUDGET + 2)).to.deep.equal([400, 400, 400, 429, 429]);
    });

    it('counts oversize bodies and refuses them with a 429 once the budget is spent', async () => {
        const big = JSON.stringify({ p: 'x'.repeat(200 * 1024) });
        expect(await statuses(big, BUDGET + 1)).to.deep.equal([413, 413, 413, 429]);
    });

    it('lets parser failures spend the budget a valid call would have used', async () => {
        expect(await statuses('{bad', BUDGET)).to.deep.equal([400, 400, 400]);
        const r = await post('{"a":1}');
        expect(r.status).to.equal(429);
        expect(JSON.parse(r.text).error.code).to.be.a('number');
    });

    it('keeps the parser envelope and still routes a valid call within budget', async () => {
        const bad = await post('{bad');
        expect(JSON.parse(bad.text)).to.deep.equal({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON body' } });
        const ok = await post('{"a":1}');
        expect(ok.status).to.equal(200);
        expect(JSON.parse(ok.text)).to.deep.equal({ got: { a: 1 } });
    });

    it('still charges a batch one token per call after parsing', async () => {
        const batch = JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
        expect((await post(batch)).status).to.equal(429);
    });
});
