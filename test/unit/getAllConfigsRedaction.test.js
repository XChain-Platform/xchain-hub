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

// What the getallconfigs HANDLER actually puts on the wire.
//
// The auth tiers are covered in sensitiveReadAuth.test.js; this file covers the
// other half of the same fix: an authorized caller that does not ASK for
// credentials must not receive them, because the ordinary reads against this
// method (health probes, `curl | jq`, support pastes) are exactly the ones that
// would otherwise copy plaintext DB passwords out of the hub.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire').noPreserveCache();
const { waitUntil } = require('../helpers/waitUntil');
const redaction  = require('../../src/lib/config_redaction.js');

// The credential-bearing tree xchain-node pushes (HubService.buildHubModuleConfig).
function configTree() {
    return {
        Bitcoin: {
            regtest: {
                bitcoind: { host: 'bitcoin-node', port: '18443', user: 'rpcuser', pass: 'NODE-RPC-SECRET' },
                'xchain-indexer': {
                    host: 'indexer', port: '3000', db_host: 'mariadb', db_port: '3306',
                    name: 'XCHAIN_BTC_REGTEST', user: 'indexer_user', pass: 'INDEXER-DB-SECRET'
                }
            }
        }
    };
}

// Boot src/api.js with everything heavy stubbed and capture the JSON-RPC
// controller handed to express-json-rpc-router, so the real handler can be
// called directly against a stub hub.
async function bootController(env) {
    let controller = null;
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

    const hubStubs = {
        getAllConfigs:       sinon.stub().resolves(configTree()),
        getLastSeq:          sinon.stub().resolves(7),
        getConfigWatermark:  sinon.stub().resolves(1788121413)
    };
    const mockHub = new Proxy(hubStubs, {
        get: (target, prop) => {
            if (!(prop in target)) target[prop] = sinon.stub().callsFake(async () => ({}));
            return target[prop];
        }
    });

    const saved = {};
    for (const k of ['HUB_API_KEY', 'HUB_REORG_API_KEY', 'HUB_CONFIG_SECRETS_API_KEY',
                     'HUB_SENSITIVE_READ_AUTH', 'HUB_ALLOW_UNAUTHENTICATED',
                     'HUB_DB_HOST', 'HUB_DB_PORT', 'HUB_DB_NAME', 'HUB_DB_USER', 'HUB_DB_PASS',
                     'HUB_PORT', 'P2P_VALIDATOR_ADDR']) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    Object.assign(process.env, {
        HUB_DB_HOST: 'localhost', HUB_DB_PORT: '3306', HUB_DB_NAME: 'testdb',
        HUB_DB_USER: 'root', HUB_DB_PASS: 'pass', HUB_PORT: '9998'
    }, env || {});

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
    await waitUntil(() => mockServer.listen.called, { label: 'api.js boot to reach server.listen' });
    expect(controller, 'jsonRpcController not captured').to.not.equal(null);
    return { controller, hubStubs };
}

describe('getallconfigs credential redaction (handler)', function () {

    let controller, hubStubs;
    before(async function () {
        const booted = await bootController({ HUB_API_KEY: 'test-hub-key' });
        controller = booted.controller;
        hubStubs   = booted.hubStubs;
    });
    afterEach(function () { sinon.resetHistory(); });
    after(function () { sinon.restore(); });

    it('redacts every password when the caller does not ask for secrets', async function () {
        const out = await controller.getallconfigs({});
        const btc = out.configs.Bitcoin.regtest;
        expect(btc.bitcoind.pass).to.equal(redaction.REDACTED);
        expect(btc['xchain-indexer'].pass).to.equal(redaction.REDACTED);
        expect(JSON.stringify(out)).to.not.include('SECRET');
    });

    it('redacts with no params at all (the bare call every probe makes)', async function () {
        const out = await controller.getallconfigs();
        expect(out.configs.Bitcoin.regtest.bitcoind.pass).to.equal(redaction.REDACTED);
    });

    it('still serves the connection map, so service discovery is unchanged', async function () {
        const out = await controller.getallconfigs({});
        const idx = out.configs.Bitcoin.regtest['xchain-indexer'];
        expect(idx.db_host).to.equal('mariadb');
        expect(idx.db_port).to.equal('3306');
        expect(idx.name).to.equal('XCHAIN_BTC_REGTEST');
        expect(idx.user).to.equal('indexer_user');
    });

    it('keeps the existing envelope fields (seq, watermark, coin hashes)', async function () {
        const out = await controller.getallconfigs({});
        expect(out.seq).to.equal(7);
        expect(out.watermark).to.equal(1788121413);
        expect(out.coin_consensus_hashes).to.be.an('object');
    });

    it('says so: secrets_redacted and a redacted_params count', async function () {
        const out = await controller.getallconfigs({});
        expect(out.secrets_redacted).to.equal(true);
        expect(out.redacted_params).to.equal(2);
    });

    it('serves the real credentials when include_secrets is set', async function () {
        const out = await controller.getallconfigs({ include_secrets: true });
        expect(out.configs.Bitcoin.regtest.bitcoind.pass).to.equal('NODE-RPC-SECRET');
        expect(out.configs.Bitcoin.regtest['xchain-indexer'].pass).to.equal('INDEXER-DB-SECRET');
        expect(out.secrets_redacted).to.equal(false);
        expect(out.redacted_params).to.equal(0);
    });

    it('accepts the string form a query-built payload produces', async function () {
        const out = await controller.getallconfigs({ include_secrets: 'true' });
        expect(out.configs.Bitcoin.regtest.bitcoind.pass).to.equal('NODE-RPC-SECRET');
    });

    it('redacts on a near-miss value rather than guessing the caller meant yes', async function () {
        for (const v of ['yes', 'false', 0, null]) {
            const out = await controller.getallconfigs({ include_secrets: v });
            expect(out.configs.Bitcoin.regtest.bitcoind.pass).to.equal(redaction.REDACTED, String(v));
        }
    });

    it('passes since_updated_at through untouched (delta polls keep working)', async function () {
        await controller.getallconfigs({ since_updated_at: 1788121400 });
        expect(hubStubs.getAllConfigs.calledWith(1788121400)).to.equal(true);
    });

    it('redacts the delta response too, not just the full tree', async function () {
        const out = await controller.getallconfigs({ since_updated_at: 1788121400 });
        expect(out.configs.Bitcoin.regtest.bitcoind.pass).to.equal(redaction.REDACTED);
    });

    it('leaves the hub\'s own copy of the tree unredacted (internal readers share it)', async function () {
        const served = configTree();
        hubStubs.getAllConfigs.resolves(served);
        await controller.getallconfigs({});
        expect(served.Bitcoin.regtest.bitcoind.pass).to.equal('NODE-RPC-SECRET');
        hubStubs.getAllConfigs.resolves(configTree());
    });

    it('still answers a DB failure with the error envelope, carrying no config', async function () {
        hubStubs.getAllConfigs.rejects(new Error('db down'));
        const out = await controller.getallconfigs({ include_secrets: true });
        expect(out.error).to.be.a('string');
        expect(out.configs).to.equal(undefined);
        hubStubs.getAllConfigs.resolves(configTree());
    });
});
