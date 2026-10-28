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
 * A malformed or oversized JSON body must not echo internal state.
 *
 * NODE_ENV is unset in a deployed hub container, so Express's default
 * finalhandler runs in development mode and renders err.stack as HTML, leaking
 * the install path and dependency file:line numbers. These tests keep NODE_ENV
 * unset and drive the real middleware stack over a real listener.
 *
 **********************************************************************/

'use strict';

const { expect } = require('chai');
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const http       = require('http');
const { installTransportMiddleware } = require('../../../src/api/middleware.js');

const LEAK = /node_modules|body-parser|raw-body|\bat .*\(|SyntaxError|PayloadTooLargeError|\.js:\d+/;

let server = null;
let port   = 0;
let savedEnv;

function boot() {
    const app = express();
    installTransportMiddleware(app, {
        hubConfig: {},
        logger: { info() {}, warn() {} },
        express, helmet, cors, rateLimit,
        CORS_ORIGIN: '*',
        HUB_RATE_LIMIT_RPM: 100000,
        HUB_RATE_LIMIT_EXEMPT_LOCAL: true
    });
    app.post('/echo', (req, res) => res.json({ got: req.body }));
    app.post('/boom', () => { throw new Error('route failure /secret/path.js:1'); });
    return new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
    });
}

function post(path, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', text }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

describe('hub JSON body parser errors', () => {
    before(async () => { savedEnv = process.env.NODE_ENV; delete process.env.NODE_ENV; await boot(); });
    after((done) => {
        if (savedEnv !== undefined) process.env.NODE_ENV = savedEnv;
        server.close(() => done());
    });

    it('answers malformed JSON with a 400 JSON body and no internals', async () => {
        for (const path of ['/echo', '/hub-db/snapshot/price_snapshots']) {
            const r = await post(path, '{bad');
            expect(r.status).to.equal(400);
            expect(r.type).to.match(/application\/json/);
            expect(r.type).to.not.match(/text\/html/);
            expect(r.text).to.not.match(LEAK);
            expect(JSON.parse(r.text)).to.have.property('error');
        }
    });

    it('answers an oversized body with a 413 JSON body and no internals', async () => {
        const r = await post('/echo', JSON.stringify({ p: 'x'.repeat(200 * 1024) }));
        expect(r.status).to.equal(413);
        expect(r.type).to.match(/application\/json/);
        expect(r.text).to.not.match(LEAK);
        expect(JSON.parse(r.text)).to.have.property('error');
    });

    it('still passes a valid JSON body to the route', async () => {
        const r = await post('/echo', '{"a":1}');
        expect(r.status).to.equal(200);
        expect(JSON.parse(r.text)).to.deep.equal({ got: { a: 1 } });
    });

    it('does not swallow a route error into the parser error shape', async () => {
        const r = await post('/boom', '{"a":1}');
        expect(r.status).to.equal(500);
        expect(r.type).to.not.match(/application\/json/);
    });
});
