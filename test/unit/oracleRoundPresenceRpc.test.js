'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// The `getoracleroundpresence` RPC leg. Boots src/api.js with
// everything heavy stubbed and captures the real jsonRpcController handed to
// express-json-rpc-router, so these drive the SHIPPED handler rather than a copy
// of it (same boot technique as test/unit/slashProposalsRpc.test.js).
//
// This is the surface an operator polls across the fleet to answer "did we all
// see round 26?", so what matters here is that it is public (no key), that it
// forwards the caller's range unchanged, and that a garbage range is refused
// before it reaches the DB.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();
const { waitUntil }  = require('../helpers/waitUntil');
const { MAX_RANGE }  = require('../../src/lib/oracle_round_presence.js');

async function bootController(getOracleRoundPresence) {
    const mockApp = {
        use: sinon.stub(), get: sinon.stub(), post: sinon.stub(), set: sinon.stub(),
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); })
    };
    const mockServer = {
        listen: sinon.stub().callsFake((port, host, cb) => { if (cb) cb(); }),
        on: sinon.stub()
    };
    const mockExpress = sinon.stub().returns(mockApp);
    mockExpress.json = sinon.stub().returns(function expressJson() {});

    const mockHub = new Proxy({ getOracleRoundPresence }, {
        get: (target, prop) => {
            if (!(prop in target)) target[prop] = sinon.stub().callsFake(async () => ({}));
            return target[prop];
        }
    });

    let controller = null;
    const saved = {};
    for (const k of ['HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_SENSITIVE_READ_AUTH',
                     'HUB_ALLOW_UNAUTHENTICATED', 'HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME',
                     'HUB_DB_USER', 'HUB_DB_PASS', 'HUB_PORT', 'P2P_VALIDATOR_ADDR']) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    Object.assign(process.env, {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
        HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9997',
        HUB_ALLOW_UNAUTHENTICATED: 'true'
    });
    try {
        proxyquire('../../src/api', {
            'dotenv': { config: sinon.stub() },
            'express': mockExpress,
            'helmet': sinon.stub().returns(function helmetMw() {}),
            'cors': sinon.stub().returns(function corsMw() {}),
            'express-rate-limit': sinon.stub().returns(function rateLimitMw() {}),
            'express-json-rpc-router': (opts) => { controller = opts.methods; return function routerMw() {}; },
            'http': { createServer: sinon.stub().returns(mockServer) },
            'ws': { Server: sinon.stub().returns({ on: sinon.stub() }) },
            'geoip-lite': { lookup: sinon.stub().returns(null) },
            './XChainHub': function () { return mockHub; }
        });
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
    await waitUntil(() => controller !== null, { label: 'api.js boot to register the JSON-RPC controller' });
    return controller;
}

const ANSWER = {
    from_round: 25, to_round: 27, digest: 'a'.repeat(64),
    missing: [26, 27],
    rounds: [{ round: 25, status: 'finalized' }, { round: 26, status: 'missing' },
             { round: 27, status: 'missing' }]
};

describe('getoracleroundpresence JSON-RPC method', function () {

    this.timeout(20000);

    afterEach(function () { sinon.restore(); });

    it('is registered on the JSON-RPC controller', async function () {
        const c = await bootController(sinon.stub().resolves(ANSWER));
        expect(c.getoracleroundpresence).to.be.a('function');
    });

    it('is a PUBLIC read: it is not in the keyed write or sensitive-read tiers', async function () {
        // A divergence probe an operator can only run with the hub's write key is a
        // probe nobody runs. Asserted against the shipped sets, not a copy.
        const fs  = require('fs');
        const src = fs.readFileSync(require.resolve('../../src/api.js'), 'utf8');
        const writeBlock = src.slice(src.indexOf('WRITE_METHODS'), src.indexOf(']', src.indexOf('WRITE_METHODS')));
        const sensIdx    = src.indexOf('SENSITIVE_READ_METHODS = new Set(');
        const sensBlock  = src.slice(sensIdx, src.indexOf(')', sensIdx));
        expect(writeBlock).to.not.contain('getoracleroundpresence');
        expect(sensBlock).to.not.contain('getoracleroundpresence');
    });

    it('forwards the caller range to the hub unchanged', async function () {
        const impl = sinon.stub().resolves(ANSWER);
        const c = await bootController(impl);
        const out = await c.getoracleroundpresence({ from_round: 25, to_round: 27 });
        expect(impl.firstCall.args.slice(0, 2)).to.deep.equal([25, 27]);
        expect(out).to.deep.equal(ANSWER);
    });

    it('lets the hub resolve an omitted range', async function () {
        const impl = sinon.stub().resolves(ANSWER);
        const c = await bootController(impl);
        await c.getoracleroundpresence({});
        expect(impl.firstCall.args).to.deep.equal([undefined, undefined, undefined]);
    });

    it('refuses a non-numeric bound before touching the hub', async function () {
        const impl = sinon.stub().resolves(ANSWER);
        const c = await bootController(impl);
        expect((await c.getoracleroundpresence({ from_round: '25; DROP TABLE price_snapshots' })).error)
            .to.contain('from_round');
        expect((await c.getoracleroundpresence({ to_round: 'soon' })).error).to.contain('to_round');
        expect(impl.called).to.equal(false);
    });

    it('refuses a limit outside the supported span before touching the hub', async function () {
        const impl = sinon.stub().resolves(ANSWER);
        const c = await bootController(impl);
        expect((await c.getoracleroundpresence({ limit: 0 })).error).to.contain('limit');
        expect((await c.getoracleroundpresence({ limit: MAX_RANGE + 1 })).error).to.contain(String(MAX_RANGE));
        expect(impl.called).to.equal(false);
    });

    it('reports an error rather than leaking a DB failure to the caller', async function () {
        const c = await bootController(sinon.stub().rejects(new Error('ER_ACCESS_DENIED root@db')));
        const out = await c.getoracleroundpresence({});
        expect(out.error).to.equal('error fetching oracle round presence');
        expect(JSON.stringify(out)).to.not.contain('ACCESS_DENIED');
    });
});
