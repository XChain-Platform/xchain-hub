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

const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');

function registerInvalidConfigTests(getXChainHub) {
    it('applyConfig() throws when config is a string', async function () {
        let XChainHub = getXChainHub();
        let h = new XChainHub('h', 3306, 'db', 'u', 'p');
        await h.start();
        try {
            await h.applyConfig('string-value');
            expect.fail('should have thrown');
        } catch (e) {
            expect(e.message).to.include('non-null object');
        }
    });

    it('applyConfig() throws when config is null', async function () {
        let XChainHub = getXChainHub();
        let h = new XChainHub('h', 3306, 'db', 'u', 'p');
        await h.start();
        try {
            await h.applyConfig(null);
            expect.fail('should have thrown');
        } catch (e) {
            expect(e.message).to.include('non-null object');
        }
    });

    it('applyConfig() throws when config is an array', async function () {
        let XChainHub = getXChainHub();
        let h = new XChainHub('h', 3306, 'db', 'u', 'p');
        await h.start();
        try {
            await h.applyConfig([1, 2, 3]);
            expect.fail('should have thrown');
        } catch (e) {
            expect(e.message).to.include('non-null object');
        }
    });

    it('applyConfig() throws when value exceeds 1024 chars', async function () {
        let XChainHub = getXChainHub();
        let h = new XChainHub('h', 3306, 'db', 'u', 'p');
        await h.start();
        let config = { BTC: { mainnet: { indexer: { host: 'x'.repeat(1025) } } } };
        try {
            await h.applyConfig(config);
            expect.fail('should have thrown');
        } catch (e) {
            expect(e.message).to.include('1024');
        }
    });
}

// =================================================================
// XChainHub: Config structure validation
// =================================================================
function configStructureSuite() {
        // Use proxyquire to get XChainHub without real DB
        let XChainHub;

        before(function () {
            XChainHub = proxyquire('../../src/XChainHub', {
                './db': function () {
                    return {
                        createDatabase: sinon.stub().resolves(),
                        verifyTables: sinon.stub().resolves(),
                        runMigrations: sinon.stub().resolves(),
                        setParam: sinon.stub().resolves(),
                        setParams: sinon.stub().resolves(0),
                        doQuery: sinon.stub().resolves([]),
                        getAllConfigs: sinon.stub().resolves({}),
                        close: sinon.stub().resolves()
                    };
                }
            });
        });

        registerInvalidConfigTests(() => XChainHub);

        it('applyConfig() coerces non-string values to strings', async function () {
            let h = new XChainHub('h', 3306, 'db', 'u', 'p');
            await h.start();
            let config = { BTC: { mainnet: { indexer: { port: 8080 } } } };
            await h.applyConfig(config);
            expect(h.db.setParams.calledOnce).to.be.true;
            let rows = h.db.setParams.getCall(0).args[0];
            let row = rows.find(r => r.paramName === 'port');
            expect(row).to.not.be.undefined;
            expect(row.paramValue).to.equal('8080');
        });

        it('applyConfig() accepts valid config', async function () {
            let h = new XChainHub('h', 3306, 'db', 'u', 'p');
            await h.start();
            let config = { BTC: { mainnet: { indexer: { host: 'localhost', port: '8080' } } } };
            await h.applyConfig(config);
            expect(h.db.setParams.calledOnce).to.be.true;
            let rows = h.db.setParams.getCall(0).args[0];
            expect(rows).to.have.lengthOf(2);
        });

        it('applyConfig() ignores non-object nested levels', async function () {
            let h = new XChainHub('h', 3306, 'db', 'u', 'p');
            await h.start();
            let config = { BTC: 'invalid' };
            await h.applyConfig(config);
            expect(h.db.setParams.callCount).to.equal(0);
        });
    }

// =================================================================
// PriceFetcher: Response validation
// =================================================================
function priceResponseSuite() {
        const PriceFetcher = require('../../src/oracle/price_fetcher');

        it('rejects prices >= 1e12 (upper bound) from CoinGecko', async function () {
            let pf = new PriceFetcher({ COINGECKO_API_KEY: '', PRICE_FETCH_TIMEOUT: 5000 });
            let axios = require('axios');
            sinon.stub(axios, 'get').resolves({
                data: {
                    bitcoin: { usd: 1e12 },
                    litecoin: { usd: 85 },
                    dogecoin: { usd: 0.15 }
                }
            });
            let result = await pf.fetchFromCoinGecko();
            expect(result['BTC/USD']).to.be.undefined;
            expect(result['LTC/USD']).to.equal(85);
            expect(result['DOGE/USD']).to.equal(0.15);
        });

        it('rejects negative prices from CoinGecko', async function () {
            let pf = new PriceFetcher({ COINGECKO_API_KEY: '', PRICE_FETCH_TIMEOUT: 5000 });
            let axios = require('axios');
            sinon.stub(axios, 'get').resolves({
                data: {
                    bitcoin: { usd: -100 },
                    litecoin: { usd: 85 },
                    dogecoin: { usd: 0 }
                }
            });
            let result = await pf.fetchFromCoinGecko();
            expect(result['BTC/USD']).to.be.undefined;
            expect(result['LTC/USD']).to.equal(85);
            expect(result['DOGE/USD']).to.be.undefined;
        });

        it('handles null data in CoinGecko response', async function () {
            let pf = new PriceFetcher({ COINGECKO_API_KEY: '', PRICE_FETCH_TIMEOUT: 5000 });
            let axios = require('axios');
            sinon.stub(axios, 'get').resolves({
                data: { bitcoin: null, litecoin: { usd: 85 } }
            });
            let result = await pf.fetchFromCoinGecko();
            expect(result['BTC/USD']).to.be.undefined;
            expect(result['LTC/USD']).to.equal(85);
        });
    }

// =================================================================
// db: Query timeout configuration
// =================================================================
function queryTimeoutSuite() {

        it('connectionPoolParams includes queryTimeout', function () {
            let mockPool = { getConnection: sinon.stub(), end: sinon.stub() };
            let mariadbStub = { createPool: sinon.stub().returns(mockPool) };
            let Database = proxyquire('../../src/db', { 'mariadb': mariadbStub });

            let origEnv = process.env.DB_QUERY_TIMEOUT;
            process.env.DB_QUERY_TIMEOUT = '45000';
            let db = new Database('host', 3306, 'testdb', 'user', 'pass');
            let poolArgs = mariadbStub.createPool.getCall(0).args[0];
            expect(poolArgs.queryTimeout).to.equal(45000);
            if (origEnv === undefined) delete process.env.DB_QUERY_TIMEOUT;
            else process.env.DB_QUERY_TIMEOUT = origEnv;
        });

        it('connectionPoolParams defaults queryTimeout to 30000', function () {
            let mockPool = { getConnection: sinon.stub(), end: sinon.stub() };
            let mariadbStub = { createPool: sinon.stub().returns(mockPool) };
            let Database = proxyquire('../../src/db', { 'mariadb': mariadbStub });

            let origEnv = process.env.DB_QUERY_TIMEOUT;
            delete process.env.DB_QUERY_TIMEOUT;
            let db = new Database('host', 3306, 'testdb', 'user', 'pass');
            let poolArgs = mariadbStub.createPool.getCall(0).args[0];
            expect(poolArgs.queryTimeout).to.equal(30000);
            if (origEnv !== undefined) process.env.DB_QUERY_TIMEOUT = origEnv;
        });
    }

// =================================================================
// db: Object serialization warning
// =================================================================
function objectSerializationSuite() {

        it('serializes objects with JSON.stringify instead of toString', async function () {
            let mockPool = {
                getConnection: sinon.stub().resolves({
                    query: sinon.stub().resolves([]),
                    release: sinon.stub()
                }),
                end: sinon.stub()
            };
            let mariadbStub = { createPool: sinon.stub().returns(mockPool) };
            let Database = proxyquire('../../src/db', { 'mariadb': mariadbStub });
            let db = new Database('host', 3306, 'testdb', 'user', 'pass');

            let warnStub = sinon.stub(console, 'warn');
            let obj = { key: 'value' };
            await db.doQuery('SELECT ?', [obj]);

            expect(warnStub.calledWith(sinon.match('object arg serialized'))).to.be.true;

            let conn = await mockPool.getConnection();
            let queryCall = conn.query.getCall(0);
            expect(queryCall.args[1][0]).to.equal(JSON.stringify(obj));
        });
    }

function securityHardeningSuite() {
    afterEach(function () {
        sinon.restore();
    });
    describe('XChainHub: Config structure validation', configStructureSuite);
    describe('PriceFetcher: Response validation', priceResponseSuite);
    describe('db: Query timeout configuration', queryTimeoutSuite);
    describe('db: Object serialization in doQuery', objectSerializationSuite);
}

describe('Security Hardening', securityHardeningSuite);
