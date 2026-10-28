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

// Names inherited from Object.prototype (constructor, toString, __proto__ ...) are
// not methods. express-json-rpc-router validates with `method in controller`, so a
// controller that inherits from Object.prototype dispatched them as handlers. Every
// unknown or hostile name must answer a fixed-shape -32601 and run nothing.

const http = require('http');
const { expect } = require('chai');
const express = require('express');
const bodyParser = require('body-parser');
const jsonRouter = require('express-json-rpc-router');
const { buildRpcController } = require('../../../src/api/rpc');

const HOSTILE = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf'];

// Family builders only close over ctx; any property read yields an inert stub.
function stubCtx() {
    const inert = new Proxy(function () {}, { get: () => inert, apply: () => inert });
    return new Proxy({}, { get: () => inert });
}

async function post(controller, method) {
    const app = express();
    app.use(bodyParser.json());
    app.use(jsonRouter({ methods: controller }));
    app.use((err, req, res, next) => { res.status(500).json({ error: 'internal' }); }); // eslint-disable-line no-unused-vars
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: `{"jsonrpc":"2.0","method":${JSON.stringify(method)},"params":{"echo":"x"},"id":1}`,
        });
        return { status: res.status, body: await res.json() };
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

describe('buildRpcController prototype-inherited method names', () => {
    let controller;
    before(() => { controller = buildRpcController(stubCtx()); });

    it('has no prototype, so inherited names are not in the method table', () => {
        expect(Object.getPrototypeOf(controller)).to.equal(null);
        for (const name of HOSTILE) expect(name in controller, name).to.equal(false);
        expect(typeof controller.ping).to.equal('function');
    });

    for (const name of HOSTILE) {
        it(`answers -32601 for ${name} and never a result`, async () => {
            const { status, body } = await post(controller, name);
            expect(status).to.equal(200);
            expect(body.error && body.error.code).to.equal(-32601);
            expect(body).to.not.have.property('result');
        });
    }

    it('still dispatches a real method', async () => {
        const { body } = await post(controller, 'ping');
        expect(body.error).to.equal(undefined);
        expect(body).to.have.property('result');
    });
});
