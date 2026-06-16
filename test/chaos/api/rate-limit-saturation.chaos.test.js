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

const sinon      = require('sinon');
const { expect } = require('chai');
const http       = require('http');
const express    = require('express');
const rateLimit  = require('express-rate-limit');

describe('Chaos: API Rate Limit Saturation (RES-4)', function () {
    this.timeout(15000);

    let app, server, port;

    beforeEach(function (done) {
        sinon.stub(console, 'log');

        app = express();
        app.use(express.json());

        let limiter = rateLimit({
            windowMs: 60000,
            limit:    10,
            standardHeaders: true,
            legacyHeaders:   false,
            message:  { error: 'Too many requests' }
        });
        app.use(limiter);

        app.post('/', (req, res) => {
            res.json({ jsonrpc: '2.0', result: 'ok', id: req.body.id || 1 });
        });

        server = app.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            done();
        });
    });

    afterEach(function (done) {
        sinon.restore();
        server.close(done);
    });

    function sendRequest(id) {
        return new Promise((resolve, reject) => {
            let body = JSON.stringify({ jsonrpc: '2.0', method: 'getconfig', id: id });
            let req = http.request({
                hostname: '127.0.0.1',
                port:     port,
                path:     '/',
                method:   'POST',
                headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    resolve({ status: res.statusCode, headers: res.headers, body: data });
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    it('requests within limit succeed with 200', async function () {
        let results = [];
        for (let i = 0; i < 10; i++) {
            results.push(await sendRequest(i));
        }

        for (let r of results) {
            expect(r.status).to.equal(200);
        }
    });

    it('requests exceeding limit receive 429', async function () {
        let results = [];
        for (let i = 0; i < 15; i++) {
            results.push(await sendRequest(i));
        }

        let successes = results.filter(r => r.status === 200);
        let rejected  = results.filter(r => r.status === 429);

        expect(successes.length).to.equal(10);
        expect(rejected.length).to.equal(5);
    });

    it('429 response includes rate limit headers', async function () {
        // Exhaust limit
        for (let i = 0; i < 10; i++) {
            await sendRequest(i);
        }

        let result = await sendRequest(11);
        expect(result.status).to.equal(429);
        expect(result.headers).to.have.property('ratelimit-limit');
        expect(result.headers['ratelimit-limit']).to.equal('10');
    });

    it('concurrent burst: rate limiter handles parallel requests', async function () {
        let promises = [];
        for (let i = 0; i < 20; i++) {
            promises.push(sendRequest(i));
        }

        let results = await Promise.all(promises);

        let successes = results.filter(r => r.status === 200);
        let rejected  = results.filter(r => r.status === 429);

        expect(successes.length).to.be.lte(10);
        expect(rejected.length).to.be.gte(10);
    });

    it('rate limiter does not leak memory from rejected requests', async function () {
        let before = process.memoryUsage().heapUsed;

        for (let i = 0; i < 50; i++) {
            await sendRequest(i);
        }

        let after = process.memoryUsage().heapUsed;
        let growth = after - before;

        // Memory growth should be < 10MB for 50 tiny requests
        expect(growth).to.be.lt(10 * 1024 * 1024);
    });
});
