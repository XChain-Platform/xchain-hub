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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const http = require('http');
const wire = require('../../../../src/lib/attest_batch_wire.js');
const {
    installTransportMiddleware,
    DEFAULT_BODY_LIMIT_BYTES,
    ATTEST_BATCH_BODY_LIMIT_BYTES
} = require('../../../../src/api/middleware.js');

const KEY = 'bulk-key';
const PREVIOUS_KEY = 'previous-bulk-key';
const FEED_KEY = 'feed-key';
let server;

function boot(overrides) {
    const app = express();
    installTransportMiddleware(app, Object.assign({
        hubConfig: {},
        logger: { info() {}, warn() {}, debug() {} },
        express, helmet, cors, rateLimit,
        CORS_ORIGIN: '*',
        HUB_RATE_LIMIT_RPM: 100000,
        HUB_RATE_LIMIT_EXEMPT_LOCAL: true,
        HUB_API_KEY: KEY,
        HUB_API_KEY_PREVIOUS: PREVIOUS_KEY,
        HUB_FEED_API_KEY: FEED_KEY
    }, overrides));
    app.post('/', (req, res) => res.json({ reached: true, bytes: req.jsonBodyBytes }));
    return new Promise(resolve => {
        server = app.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

function post(port, body, key) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) };
        if (key !== undefined) headers['x-api-key'] = key;
        const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'POST', headers }, res => {
            let response = '';
            res.on('data', chunk => { response += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(response) }));
        });
        req.on('error', reject);
        req.end(text);
    });
}

function largeCall(method, size) {
    return { jsonrpc: '2.0', id: 1, method, params: { padding: 'x'.repeat(size) } };
}

function largestWireCall() {
    const row = {
        network: 'regtest', request_id: 'ab'.repeat(32), request_action_index: 1,
        request_block_index: 1, provider_id: 'http_get', status: 'ok', response_payload: '',
        response_hash: 'cd'.repeat(32), meta: '', effective_time: 1,
        signer_pubkeys: '[]', signatures: '[]', widen: 0
    };
    const window = {
        network: 'regtest', window_start: 1, window_end: 2, row_count: 1,
        btc_block_height: 1, rows: [row], sigs: []
    };
    const baseBytes = Buffer.byteLength(wire.buildAttestBatchBody(window, () => false));
    row.response_payload = crypto.randomBytes(Math.ceil(
        (wire.ATTEST_BATCH_MAX_INFLATED_BYTES - baseBytes) * 3 / 4))
        .toString('base64').slice(0, wire.ATTEST_BATCH_MAX_INFLATED_BYTES - baseBytes);
    const encoded = wire.encodeAttestBatch(window, () => false);
    expect(encoded.ok).to.equal(true);
    expect(encoded.inflatedBytes).to.equal(wire.ATTEST_BATCH_MAX_INFLATED_BYTES);
    const body = JSON.parse(encoded.body);
    return {
        jsonrpc: '2.0', id: 1, method: 'pushattestbatch',
        params: Object.assign({ source_chain: 'BTC' }, body, {
            action_index: 1, block_index: 1, block_time: 1, push_generation: 1
        })
    };
}

describe('pushattestbatch ingress body allowance @regression', function () {
    this.timeout(10000);

    afterEach(done => server.close(() => { server = null; done(); }));

    it('accepts the largest protocol body with bounded RPC overhead', async function () {
        const port = await boot();
        const call = largestWireCall();
        const bytes = Buffer.byteLength(JSON.stringify(call));
        expect(bytes).to.be.greaterThan(wire.ATTEST_BATCH_MAX_INFLATED_BYTES);
        expect(bytes).to.be.at.most(ATTEST_BATCH_BODY_LIMIT_BYTES);
        const response = await post(port, call, KEY);
        expect(response.status).to.equal(200);
        expect(response.body).to.include({ reached: true, bytes });
    });

    it('accepts large single attest pushes only for current and previous bulk keys', async function () {
        const port = await boot();
        const call = largeCall('pushattestbatch', 141200);
        for (const key of [KEY, PREVIOUS_KEY]) {
            expect((await post(port, call, key)).status).to.equal(200);
        }
        for (const key of [undefined, 'wrong-key', FEED_KEY]) {
            const response = await post(port, call, key);
            expect(response.status).to.equal(413);
            expect(response.body.error).to.deep.equal({ code: -32600, message: 'request entity too large' });
        }
    });

    it('keeps other methods and JSON-RPC arrays at 100 KB for bulk-key callers', async function () {
        const port = await boot();
        const other = await post(port, largeCall('getattestations', 141200), KEY);
        expect(other.status).to.equal(413);
        const array = await post(port, [largeCall('pushattestbatch', 141200)], KEY);
        expect(array.status).to.equal(413);
        expect(other.body.error.code).to.equal(-32600);
        expect(array.body.error.code).to.equal(-32600);
    });

    it('enforces the derived upper bound and preserves small requests', async function () {
        const port = await boot();
        const tooLarge = await post(port,
            largeCall('pushattestbatch', ATTEST_BATCH_BODY_LIMIT_BYTES), KEY);
        expect(tooLarge.status).to.equal(413);
        const small = largeCall('ping', 100);
        const accepted = await post(port, small);
        expect(accepted.status).to.equal(200);
        expect(accepted.body.bytes).to.be.below(DEFAULT_BODY_LIMIT_BYTES);
    });

    it('supports explicitly keyless hubs without widening other methods', async function () {
        const port = await boot({ HUB_API_KEY: '', HUB_API_KEY_PREVIOUS: '' });
        expect((await post(port, largeCall('pushattestbatch', 141200))).status).to.equal(200);
        expect((await post(port, largeCall('ping', 141200))).status).to.equal(413);
    });
});
