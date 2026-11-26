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
 * A JSON-RPC id that is not a string, number or null is refused with -32600
 * before dispatch. Left alone, the router runs the method and then echoes the
 * id, and a deeply nested id overflows the stack in JSON.stringify: a 500 and a
 * logged stack trace per call, after the method already ran.
 *
 **********************************************************************/

'use strict';

const { expect } = require('chai');
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const http       = require('http');
const { createApp } = require('../../../../src/api/server.js');

function buildCtx(extra) {
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    return Object.assign({
        express, helmet, cors, rateLimit,
        hub: new Proxy({}, { get: (t, p) => (p === 'then' ? undefined : async () => ({})) }),
        hubConfig: {},
        logger: quiet,
        CORS_ORIGIN: '*',
        HUB_RATE_LIMIT_RPM: 100000,
        HUB_RATE_LIMIT_EXEMPT_LOCAL: true,
        WRITE_METHODS: new Set(),
        REORG_WRITE_METHODS: new Set(),
        SENSITIVE_READ_METHODS: new Set(),
        SENSITIVE_READ_AUTH: false
    }, extra);
}

async function call(server, { headers = {}, body } = {}) {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/', { method: 'POST', headers, body });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

function postJson(server, payload) {
    return call(server, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}

const TITLE = 'JSON-RPC ids that are not string, number or null are refused before dispatch';
const invalid = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };

// Starts a hub app whose ping records each dispatch and whose logger records each error.
function useServer(suite) {
    suite.timeout(10000);
    const calls = [];
    const logged = [];
    const logger = { info() {}, warn() {}, debug() {}, error: (...args) => logged.push(args) };
    let server;
    const srv = () => server;
    before(async () => {
        server = http.createServer(createApp(buildCtx({ logger, rpcController: {
            ping: () => { calls.push('ping'); return 'pong'; }
        } })).app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    });
    after((done) => { server.close(() => done()); });
    beforeEach(() => { calls.length = 0; logged.length = 0; });
    return { calls, logged, srv };
}

describe(TITLE, function () {
    const { calls, logged, srv } = useServer(this);

    it('refuses a 20000-deep nested id with -32600, never runs the method and logs nothing', async () => {
        const deep = '['.repeat(20000) + ']'.repeat(20000);
        const r = await call(srv(), {
            headers: { 'content-type': 'application/json' },
            body: '{"jsonrpc":"2.0","id":' + deep + ',"method":"ping","params":[]}'
        });
        expect(r.status).to.equal(400);
        expect(r.json).to.deep.equal(invalid);
        expect(calls).to.have.length(0);
        expect(logged).to.have.length(0);
    });

    it('refuses array, object and boolean ids without running the method', async () => {
        for (const id of [[1], {}, { a: 1 }, true, false]) {
            const r = await postJson(srv(), { jsonrpc: '2.0', method: 'ping', id });
            expect(r.status, JSON.stringify(id)).to.equal(400);
            expect(r.json, JSON.stringify(id)).to.deep.equal(invalid);
        }
        expect(calls).to.have.length(0);
    });
});

describe(TITLE, function () {
    const { calls, srv } = useServer(this);

    it('still dispatches string, number, 0 and null ids', async () => {
        for (const id of ['a', '', 5, 0]) {
            const r = await postJson(srv(), { jsonrpc: '2.0', method: 'ping', id });
            expect(r.json).to.deep.equal({ jsonrpc: '2.0', result: 'pong', id });
        }
        await postJson(srv(), { jsonrpc: '2.0', method: 'ping', id: null });
        expect(calls).to.have.length(5);
    });

    it('in a batch refuses only the bad entry', async () => {
        const r = await postJson(srv(), [
            { jsonrpc: '2.0', method: 'ping', id: 1 },
            { jsonrpc: '2.0', method: 'ping', id: [[]] },
            { jsonrpc: '2.0', method: 'ping', id: 2 }
        ]);
        expect(r.json).to.have.length(3);
        expect(r.json).to.deep.include({ jsonrpc: '2.0', result: 'pong', id: 1 });
        expect(r.json).to.deep.include({ jsonrpc: '2.0', result: 'pong', id: 2 });
        expect(r.json).to.deep.include(invalid);
        expect(calls).to.have.length(2);

        const onlyBad = await postJson(srv(), [{ jsonrpc: '2.0', method: 'ping', id: {} }]);
        expect(onlyBad.json).to.deep.equal([invalid]);
    });
});
