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
const proxyquire = require('proxyquire').noPreserveCache();
const { waitUntil } = require('../../../helpers/waitUntil');

const PK = 'a'.repeat(64);

// ---------------------------------------------------------------------
// The RPC leg. Boots src/api.js with everything heavy stubbed and captures
// the real jsonRpcController object handed to express-json-rpc-router, so
// these drive the SHIPPED handler rather than a copy of it (same boot
// technique as test/unit/sensitiveReadAuth.test.js).
// ---------------------------------------------------------------------

async function bootController(slashDetector) {
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

    const mockHub = new Proxy({ slashDetector }, {
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
    // HUB_ALLOW_UNAUTHENTICATED: api.js refuses to boot with neither that nor
    // HUB_API_KEY set. This suite is about the PUBLIC read tier, so the keyless
    // shape is the one to boot; test/unit/sensitiveReadAuth.test.js owns the
    // keyed-tier behavior.
    Object.assign(process.env, {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
        HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9998',
        HUB_ALLOW_UNAUTHENTICATED: 'true'
    });
    try {
        proxyquire('../../../../src/api', {
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

describe('getslashproposals JSON-RPC method', function () {

    this.timeout(20000);

    afterEach(function () { sinon.restore(); });

    registerSlashRpcForwardingTests();
    registerSlashRpcContractTests();
});

function registerSlashRpcForwardingTests() {
    it('is registered on the JSON-RPC controller', async function () {
        const c = await bootController({ getSlashProposals: sinon.stub().resolves([]) });
        expect(c.getslashproposals).to.be.a('function');
    });

    it('forwards status and maps validator_pubkey to the detector argument name', async function () {
        const getSlashProposals = sinon.stub().resolves([]);
        const c = await bootController({ getSlashProposals });
        await c.getslashproposals({ status: 'pending', validator_pubkey: PK, limit: 100 });
        expect(getSlashProposals.firstCall.args[0]).to.deep.equal({
            status: 'pending', validatorPubkey: PK, limit: 100
        });
    });

    it('returns the detector rows verbatim (evidence already stripped hub-side)', async function () {
        const rows = [{
            id: 7, validator_pubkey: PK, offense_type: 'non_participation',
            round_number: 412, evidence_hash: 'f'.repeat(64), status: 'pending',
            created_at: '2026-08-20T00:00:00.000Z'
        }];
        const c = await bootController({ getSlashProposals: sinon.stub().resolves(rows) });
        const out = await c.getslashproposals({});
        expect(out).to.deep.equal(rows);
        expect(JSON.stringify(out)).to.not.contain('"evidence"');
    });
}

function registerSlashRpcContractTests() {
    it('rejects a limit above the shared validateLimit ceiling before touching the detector', async function () {
        const getSlashProposals = sinon.stub().resolves([]);
        const c = await bootController({ getSlashProposals });
        const out = await c.getslashproposals({ limit: 10001 });
        expect(out.error).to.contain('10000');
        expect(getSlashProposals.called).to.equal(false);
    });

    it('rejects a non-integer limit', async function () {
        const c = await bootController({ getSlashProposals: sinon.stub().resolves([]) });
        expect((await c.getslashproposals({ limit: '50junk' })).error).to.contain('limit');
    });

    it('reports a clear error when the slash detector is not active', async function () {
        const c = await bootController(undefined);
        expect((await c.getslashproposals({})).error).to.contain('slash detector not active');
    });

    it('surfaces the detector argument-validation message to the caller', async function () {
        const c = await bootController({
            getSlashProposals: sinon.stub().rejects(new Error('status must be one of: pending, approved, rejected, expired'))
        });
        expect((await c.getslashproposals({ status: 'guilty' })).error).to.contain('status must be one of');
    });

    it('is a PUBLIC read: not keyed as a write and not in the sensitive-read tier', async function () {
        // The rows carry no credential and no mesh-internal connection state, so
        // (per the seam contract, section 5) no auth-set change is needed. This
        // pins that decision: a later edit that adds it to WRITE_METHODS would
        // break every unauthenticated explorer read, and one that adds it to
        // SENSITIVE_READ_METHODS would 401 the explorer whenever HUB_API_KEY is set.
        const fs  = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '../../../../src/api.js'), 'utf8');
        const writeBlock = src.slice(src.indexOf('WRITE_METHODS'), src.indexOf(']', src.indexOf('WRITE_METHODS')));
        const sensIdx    = src.indexOf('SENSITIVE_READ_METHODS = new Set(');
        const sensBlock  = src.slice(sensIdx, src.indexOf(')', sensIdx));
        expect(writeBlock).to.not.contain('getslashproposals');
        expect(sensBlock).to.not.contain('getslashproposals');
    });

    it('is documented in the published OpenRPC contract as a non-auth method', function () {
        const doc = require('../../../../docs/openrpc.json');
        const m = doc.methods.find(x => x.name === 'getslashproposals');
        expect(m, 'regenerate with: node docs/openrpc.build.js').to.be.an('object');
        expect(m['x-auth']).to.equal(undefined);
        expect(m.params.map(p => p.name)).to.deep.equal(['status', 'validator_pubkey', 'limit']);
        // The contract has to say what a 'pending' row means, because a JSON
        // consumer sees only the word 'pending' otherwise.
        expect(m.summary.toLowerCase()).to.contain('unadjudicated');
        expect(m.summary).to.contain('evidence_hash');
    });
}
