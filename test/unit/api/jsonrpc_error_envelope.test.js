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
 * A JSON-RPC error answer carries jsonrpc "2.0" and the request's id, and 0
 * is a valid id. express-json-rpc-router writes its error envelopes as
 * `{ jsonrpc, error, id: id || null }`, so an id-0 error came back with id
 * null (its success path keeps 0) and a versionless request got an answer
 * with no jsonrpc member. The key gate made the same id-0 mistake.
 *
 * These drive the hub's own app builder (createApp) with the real router
 * over a real listener, with a stubbed controller and hub.
 *
 **********************************************************************/

'use strict';

const { expect } = require('chai');
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const http       = require('http');
const { createApp } = require('../../../src/api/server.js');
const { requestId, repairEnvelope } = require('../../../src/api/jsonrpc_envelope.js');

const KEY = 'envelope-test-key';

function stubHub() {
    return new Proxy({}, {
        get: (target, prop) => {
            if (prop === 'then') return undefined;
            if (!(prop in target)) target[prop] = async () => ({});
            return target[prop];
        }
    });
}

function buildCtx(extra) {
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    return Object.assign({
        express, helmet, cors, rateLimit,
        hub: stubHub(),
        hubConfig: {},
        logger: quiet,
        CORS_ORIGIN: '*',
        HUB_RATE_LIMIT_RPM: 100000,
        HUB_RATE_LIMIT_EXEMPT_LOCAL: true,
        WRITE_METHODS: new Set(['updateconfig']),
        REORG_WRITE_METHODS: new Set(),
        SENSITIVE_READ_METHODS: new Set(),
        SENSITIVE_READ_AUTH: false,
        rpcController: {
            ping: () => 'pong',
            fail: () => { const e = new Error('boom'); e.code = -32000; throw e; },
            updateconfig: () => 'ok'
        }
    }, extra);
}

async function listen(app) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
}

async function listenAsFeed(app) {
    const server = http.createServer((req, res) => {
        req.xchainFeedOrigin = true;
        app(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
}

async function call(server, { method = 'POST', path = '/', headers = {}, body } = {}) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers, body });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : undefined };
}

function postJson(server, payload, headers) {
    return call(server, {
        headers: Object.assign({ 'content-type': 'application/json' }, headers),
        body: JSON.stringify(payload)
    });
}

// Registers a listener over createApp for the enclosing describe block and
// returns a getter for it.
function serveApp(extraCtx) {
    let server;
    before(async () => { server = await listen(createApp(buildCtx(extraCtx)).app); });
    after((done) => { server.close(() => done()); });
    return () => server;
}

describe('JSON-RPC router errors keep id and jsonrpc', function () {
    this.timeout(10000);
    const srv = serveApp();

    it('control: a success with id 0 keeps id 0', async () => {
        const r = await postJson(srv(), { jsonrpc: '2.0', method: 'ping', id: 0 });
        expect(r.json).to.deep.equal({ jsonrpc: '2.0', result: 'pong', id: 0 });
    });

    it('keeps id 0 on a method-not-found error', async () => {
        const r = await postJson(srv(), { jsonrpc: '2.0', method: 'nosuch', id: 0 });
        expect(r.json.error.code).to.equal(-32601);
        expect(r.json.id).to.equal(0);
        expect(r.json.jsonrpc).to.equal('2.0');
    });

    it('keeps id 0 on a handler error', async () => {
        const r = await postJson(srv(), { jsonrpc: '2.0', method: 'fail', id: 0 });
        expect(r.json).to.deep.equal({ jsonrpc: '2.0', error: { code: -32000, message: 'boom' }, id: 0 });

        const logged = [];
        const logger = { info() {}, warn() {}, debug() {}, error: (message) => logged.push(message) };
        const jsonRouter = () => (req, res, next) => next(new Error('router failure /secret/path.js:1'));
        const terminalServer = await listen(createApp(buildCtx({ logger, jsonRouter })).app);
        try {
            const terminal = await postJson(terminalServer, { jsonrpc: '2.0', method: 'ping', id: 0 });
            expect(terminal.status).to.equal(500);
            expect(terminal.json).to.deep.equal({ jsonrpc: '2.0', id: null,
                error: { code: -32603, message: 'internal error' } });
            expect(terminal.text).to.not.match(/secret|node_modules|<html|<pre>|\.js:\d+/);
            expect(logged).to.have.length(1);
        } finally {
            await new Promise((resolve) => terminalServer.close(resolve));
        }
    });

    it('keeps a string id on an error', async () => {
        const r = await postJson(srv(), { jsonrpc: '2.0', method: 'nosuch', id: 'a' });
        expect(r.json.id).to.equal('a');
    });
});

describe('JSON-RPC router errors on versionless, bodyless and batch requests', function () {
    this.timeout(10000);
    const srv = serveApp();

    it('sets jsonrpc 2.0 on a versionless request and keeps its id', async () => {
        const r = await postJson(srv(), { method: 'ping', id: 1 });
        expect(r.json.error.code).to.equal(-32600);
        expect(r.json.jsonrpc).to.equal('2.0');
        expect(r.json.id).to.equal(1);
    });

    it('does not let a versionless request succeed', async () => {
        const r = await postJson(srv(), { method: 'ping', id: 0 });
        expect(r.json).to.not.have.property('result');
        expect(r.json.id).to.equal(0);
    });

    it('sets jsonrpc 2.0 and id null on an empty POST, GET / and text/plain', async () => {
        const cases = [
            { method: 'POST' },
            { method: 'GET' },
            { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"id":5}' }
        ];
        for (const c of cases) {
            const r = await call(srv(), c);
            expect(r.json, c.method).to.include({ jsonrpc: '2.0', id: null });
            expect(r.json.error.code, c.method).to.equal(-32600);
        }
        const telemetry = await call(srv(), { method: 'GET', path: '/telemetry/summary' });
        expect(telemetry.status).to.equal(200);
        expect(telemetry.json).to.deep.equal({ enabled: false });
        expect(telemetry.headers.get('x-content-type-options')).to.equal('nosniff');
    });

});

describe('JSON-RPC router errors on versionless, bodyless and batch requests', function () {
    this.timeout(10000);
    const srv = serveApp();

    it('pairs batch errors with their own ids, 0 included', async () => {
        const r = await postJson(srv(), [
            { jsonrpc: '2.0', method: 'ping', id: 7 },
            { jsonrpc: '2.0', method: 'ping' },
            { jsonrpc: '2.0', method: 'nosuch', id: 0 },
            { method: 'ping', id: 'x' }
        ]);
        expect(r.json).to.have.length(3);
        expect(r.json[0]).to.deep.equal({ jsonrpc: '2.0', result: 'pong', id: 7 });
        expect(r.json[1]).to.include({ jsonrpc: '2.0', id: 0 });
        expect(r.json[1].error.code).to.equal(-32601);
        expect(r.json[2]).to.include({ jsonrpc: '2.0', id: 'x' });
        expect(r.json[2].error.code).to.equal(-32600);

        const overCap = await postJson(srv(), Array.from({ length: 21 }, (_, id) =>
            ({ jsonrpc: '2.0', method: 'ping', id })));
        expect(overCap.status).to.equal(400);
        expect(overCap.json.error.code).to.equal(-32600);
    });

    it('returns parser errors through the full createApp chain', async () => {
        const malformed = await call(srv(), {
            headers: { 'content-type': 'application/json' }, body: '{bad'
        });
        expect(malformed.status).to.equal(400);
        expect(malformed.json.error).to.deep.equal({ code: -32700, message: 'invalid JSON body' });
        expect(malformed.text).to.not.match(/<html|<pre>|node_modules|\.js:\d+/);

        const batch = Array.from({ length: 3000 }, (_, id) =>
            ({ jsonrpc: '2.0', method: 'ping', id }));
        expect(Buffer.byteLength(JSON.stringify(batch))).to.be.greaterThan(100 * 1024);
        const oversized = await postJson(srv(), batch);
        expect(oversized.status).to.equal(413);
        expect(oversized.json.error).to.deep.equal({ code: -32600, message: 'request entity too large' });
    });
});

describe('JSON-RPC null params normalization', function () {
    this.timeout(10000);
    const srv = serveApp({ rpcController: {
        ping: () => 'pong',
        echo: ({ limit }) => ({ limit: limit === undefined ? null : limit })
    } });

    it('treats null params like omitted params for a destructuring handler', async () => {
        const r = await postJson(srv(), { jsonrpc: '2.0', method: 'echo', params: null, id: 1 });
        expect(r.json).to.deep.equal({ jsonrpc: '2.0', result: { limit: null }, id: 1 });
        expect(r.text).to.not.match(/Cannot destructure|TypeError/);
    });

    it('keeps no-argument methods working with null params', async () => {
        const r = await postJson(srv(), { jsonrpc: '2.0', method: 'ping', params: null, id: 2 });
        expect(r.json).to.deep.equal({ jsonrpc: '2.0', result: 'pong', id: 2 });
    });

    it('normalizes only null params in a batch', async () => {
        const r = await postJson(srv(), [
            { jsonrpc: '2.0', method: 'echo', params: null, id: 1 },
            { jsonrpc: '2.0', method: 'echo', params: { limit: 5 }, id: 2 }
        ]);
        expect(r.json).to.deep.equal([
            { jsonrpc: '2.0', result: { limit: null }, id: 1 },
            { jsonrpc: '2.0', result: { limit: 5 }, id: 2 }
        ]);
    });
});

describe('createApp ingress middleware order', function () {
    it('registers every security layer in its required runtime order', () => {
        const { app } = createApp(buildCtx());
        const stack = app.router.stack;
        const names = stack.map((layer) => layer.name);
        const position = (name) => {
            expect(names, name).to.include(name);
            return names.indexOf(name);
        };
        expect(position('bodyParserErrorHandler')).to.equal(position('jsonParser') + 1);
        expect(names.filter((name) => name === 'rpcBatchSurcharge')).to.have.length(2);
        expect(names.lastIndexOf('rpcBatchSurcharge')).to.be.lessThan(position('authGateMiddleware'));
        expect(position('authGateMiddleware')).to.be.lessThan(position('feedPortAllowlistMiddleware'));
        const firstRoute = stack.findIndex((layer) => layer.route);
        expect(position('feedPortAllowlistMiddleware')).to.be.lessThan(firstRoute);
        expect(firstRoute).to.be.lessThan(position('rpcBatchGuard'));
        expect(position('rpcBatchGuard')).to.be.lessThan(position('reqBodyShim'));
        expect(position('reqBodyShim')).to.be.lessThan(position('rpcNullParamsShim'));
        expect(position('rpcNullParamsShim')).to.be.lessThan(position('jsonRpcEnvelopeRepair'));
        expect(names[names.length - 1]).to.equal('handleTerminalError');
    });

    it('runs the per-call surcharge before the key gate', async () => {
        const app = createApp(buildCtx({ HUB_API_KEY: KEY,
            HUB_RATE_LIMIT_RPM: 100, HUB_RATE_LIMIT_EXEMPT_LOCAL: false })).app;
        const server = await listen(app);
        try {
            const batch = Array.from({ length: 150 }, (_, id) => ({
                jsonrpc: '2.0', method: id === 149 ? 'updateconfig' : 'ping', id
            }));
            const refused = await postJson(server, batch);
            expect(refused.status).to.equal(429);
            expect(refused.json.error.code).to.equal(-32029);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('runs the public-port allowlist before JSON-RPC dispatch', async () => {
        let writes = 0;
        const ctx = buildCtx({ HUB_API_KEY: KEY, rpcController: {
            ping: () => 'pong', updateconfig: () => { writes += 1; return 'ok'; }
        } });
        const server = await listenAsFeed(createApp(ctx).app);
        try {
            const refused = await postJson(server,
                { jsonrpc: '2.0', method: 'updateconfig', id: 1 }, { 'x-api-key': KEY });
            expect(refused.status).to.equal(404);
            expect(refused.json.error.code).to.equal(-32601);
            expect(writes).to.equal(0);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});

describe('JSON-RPC key gate refusals keep id 0', function () {
    this.timeout(10000);
    const srv = serveApp({ HUB_API_KEY: KEY });

    it('answers an unkeyed write with id 0 as a 401 carrying id 0', async () => {
        const r = await postJson(srv(), { jsonrpc: '2.0', method: 'updateconfig', id: 0 });
        expect(r.status).to.equal(401);
        expect(r.json).to.deep.equal({ jsonrpc: '2.0', id: 0, error: { code: -32001, message: 'Unauthorized' } });

        const batch = Array.from({ length: 21 }, (_, id) =>
            ({ jsonrpc: '2.0', method: id === 20 ? 'updateconfig' : 'ping', id }));
        const overCap = await postJson(srv(), batch);
        expect(overCap.status).to.equal(401);
        expect(overCap.json.error.code).to.equal(-32001);
    });

    it('answers a non-string method with id 0 as a 400 carrying id 0', async () => {
        const r = await postJson(srv(), { jsonrpc: '2.0', method: 42, id: 0 });
        expect(r.status).to.equal(400);
        expect(r.json).to.deep.equal({ jsonrpc: '2.0', id: 0, error: { code: -32600, message: 'Invalid Request' } });
    });

    it('still serves the keyed write with id 0', async () => {
        const r = await postJson(srv(), { jsonrpc: '2.0', method: 'updateconfig', id: 0 }, { 'x-api-key': KEY });
        expect(r.json).to.deep.equal({ jsonrpc: '2.0', result: 'ok', id: 0 });
    });
});

describe('JSON-RPC requestId and repairEnvelope', function () {
    this.timeout(10000);

    it('echoes only a string or number id of a single call', () => {
        expect(requestId({ id: 0 })).to.equal(0);
        expect(requestId({ id: '' })).to.equal('');
        expect(requestId({ id: { a: 1 } })).to.equal(null);
        expect(requestId({ id: true })).to.equal(null);
        expect(requestId([{ id: 1 }])).to.equal(null);
        expect(requestId(undefined)).to.equal(null);
    });

    it('passes strings, null and non-envelope objects through', () => {
        expect(repairEnvelope({}, '{"a":1}')).to.equal('{"a":1}');
        expect(repairEnvelope({}, null)).to.equal(null);
        expect(repairEnvelope({}, { other: 1 })).to.deep.equal({ other: 1 });
    });
});
