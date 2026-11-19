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
const cors = require('cors');
const express = require('express');
const helmet = require('helmet');
const http = require('http');
const proxyquire = require('proxyquire');
const rateLimit = require('express-rate-limit');
const { _resetObservability: resetObservability } = require('../../../src/observability');
const { createApp } = require('../../../src/api/server');

const TIMING_ENV = {
    METRICS_ENABLED: '0',
    SQL_TIMING_ENABLED: '1',
    SQL_TIMING_URL: 'https://timing.invalid/api/v1/sql-timing',
    SQL_TIMING_KEY: 'test-key',
    SQL_TIMING_PROJECT: 'xchain-platform',
    SQL_TIMING_INTERVAL_MS: '999999',
    SQL_TIMING_STATEMENT_RATE: '0'
};

function stubHub() {
    return new Proxy({}, {
        get(target, prop) {
            if (prop === 'then') return undefined;
            if (!(prop in target)) target[prop] = async () => ({});
            return target[prop];
        }
    });
}

function buildContext(rpcController) {
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    return {
        express,
        helmet,
        cors,
        rateLimit,
        hub: stubHub(),
        hubConfig: {},
        logger: quiet,
        CORS_ORIGIN: '*',
        HUB_RATE_LIMIT_RPM: 100000,
        HUB_RATE_LIMIT_EXEMPT_LOCAL: true,
        WRITE_METHODS: new Set(),
        REORG_WRITE_METHODS: new Set(),
        SENSITIVE_READ_METHODS: new Set(),
        SENSITIVE_READ_AUTH: false,
        rpcController
    };
}

function listen(app) {
    const server = http.createServer(app);
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function postRpc(server, method) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method });
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1',
            port: server.address().port,
            path: '/',
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body)
            }
        }, (response) => {
            let responseBody = '';
            response.on('data', chunk => { responseBody += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(responseBody) }));
        });
        request.on('error', reject);
        request.end(body);
    });
}

function restoreEnv(previous) {
    for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
}

let previousEnv;
let previousFetch;
let server;
let installed;

function registerLifecycleHooks() {
    beforeEach(function () {
        previousEnv = Object.fromEntries(Object.keys(TIMING_ENV).map(name => [name, process.env[name]]));
        Object.assign(process.env, TIMING_ENV);
        previousFetch = global.fetch;
        resetObservability();
    });

    afterEach(async function () {
        if (installed) await installed.shutdown();
        if (server) await new Promise(resolve => server.close(resolve));
        restoreEnv(previousEnv);
        global.fetch = previousFetch;
        resetObservability();
        installed = null;
        server = null;
    });
}

function registerRpcTimingTest() {
    it('emits the RPC method route with its wrapped pool query count', async function () {
        const requests = [];
        global.fetch = async (url, options) => {
            requests.push({ url, options });
            return { status: 200, body: { cancel: () => Promise.resolve() } };
        };

        const pool = { query: () => Promise.resolve([{ ok: true }]), end: () => Promise.resolve() };
        const Database = proxyquire('../../../src/db', {
            mariadb: { createPool: () => pool }
        });
        const database = new Database('127.0.0.1', 3306, 'xchain_hub', 'user', 'pass');
        const rpcController = {
            timed: async () => {
                await database.pool.query('SELECT 1');
                return { ok: true };
            }
        };

        const built = createApp(buildContext(rpcController));
        installed = built.observability;
        server = await listen(built.app);

        const response = await postRpc(server, 'timed');
        expect(response.status).to.equal(200);
        expect(response.body.result).to.deep.equal({ ok: true });
        await installed.shutdown();
        installed = null;

        expect(requests).to.have.lengthOf(1);
        const line = JSON.parse(requests[0].options.body.trim());
        expect(line.route).to.equal('POST /xchain-hub/rpc/timed');
        expect(line.query_count).to.equal(1);
    });
}

function registerInheritedNameTest() {
    it('keeps inherited names out of the wrapped RPC method table', async function () {
        global.fetch = async () => ({ status: 200, body: { cancel: () => Promise.resolve() } });
        const rpcController = Object.assign(Object.create(null), { ping: async () => ({ ok: true }) });

        const built = createApp(buildContext(rpcController));
        installed = built.observability;
        server = await listen(built.app);

        for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
            const response = await postRpc(server, name);
            expect(response.body.error && response.body.error.code, name).to.equal(-32601);
            expect(response.body, name).to.not.have.property('result');
        }
        const ping = await postRpc(server, 'ping');
        expect(ping.body.result).to.deep.equal({ ok: true });
    });
}

describe('SQL timing application wiring', function () {
    this.timeout(10000);
    registerLifecycleHooks();
    registerRpcTimingTest();
    registerInheritedNameTest();
});
