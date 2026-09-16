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

const sinon        = require('sinon');
const { expect }   = require('chai');
const proxyquire   = require('proxyquire');

    let mockPool, mockConn, mockMariadb, Database;

function registerDatabaseHooks() {
        beforeEach(function () {
            mockConn = {
                query:   sinon.stub().resolves([]),
                release: sinon.stub().resolves(),
                end:     sinon.stub().resolves()
            };
            mockPool = {
                getConnection: sinon.stub().resolves(mockConn),
                end:           sinon.stub().resolves()
            };
            mockMariadb = {
                createPool:       sinon.stub().returns(mockPool),
                createConnection: sinon.stub().resolves(mockConn)
            };

            Database = proxyquire('../../../src/db', {
                mariadb: mockMariadb,
                fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') },
                path:    require('path')
            });
        });

        afterEach(function () {
            sinon.restore();
        });
}

function registerSetParamTests() {
    // -----------------------------------------------------------------
    // Config methods
    // -----------------------------------------------------------------

    describe('setParam()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('executes upsert query', async function () {
            mockConn.query.resolves([]);
            await db.setParam('BTC', 'mainnet', 'indexer', 'host', 'localhost');
            expect(mockConn.query.calledOnce).to.be.true;
            let sql = mockConn.query.getCall(0).args[0];
            expect(sql).to.include('INSERT INTO configs');
            expect(sql).to.include('ON DUPLICATE KEY UPDATE');
        });
    });
}

function registerSetParamsTests() {
    describe('setParams()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('executes a single multi-row upsert', async function () {
            mockConn.query.resolves([]);
            let n = await db.setParams([
                { coin: 'BTC', network: 'mainnet', module: 'indexer', paramName: 'host', paramValue: 'h1' },
                { coin: 'BTC', network: 'mainnet', module: 'indexer', paramName: 'port', paramValue: '3309' },
                { coin: 'LTC', network: 'testnet', module: 'encoder', paramName: 'host', paramValue: 'h2' }
            ]);
            expect(n).to.equal(3);
            expect(mockConn.query.calledOnce).to.be.true;
            let [sql, args] = mockConn.query.getCall(0).args;
            expect(sql).to.include('INSERT INTO configs');
            expect(sql).to.include('ON DUPLICATE KEY UPDATE');
            expect(sql).to.include('VALUES(param_value)');
            // 3 rows × 5 placeholders each
            expect(args).to.have.length(15);
            expect(args.slice(0, 5)).to.deep.equal(['BTC', 'mainnet', 'indexer', 'host', 'h1']);
        });

        it('is a no-op on empty input', async function () {
            let n = await db.setParams([]);
            expect(n).to.equal(0);
            expect(mockConn.query.called).to.be.false;
        });

        it('is a no-op on null/undefined input', async function () {
            expect(await db.setParams(null)).to.equal(0);
            expect(await db.setParams(undefined)).to.equal(0);
            expect(mockConn.query.called).to.be.false;
        });
    });
}

function registerGetConfigTests() {
    describe('getConfig()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('returns config as key-value object', async function () {
            mockConn.query.resolves([
                { param_name: 'host', param_value: 'localhost' },
                { param_name: 'port', param_value: '3306' }
            ]);

            let config = await db.getConfig('BTC', 'mainnet', 'indexer');
            expect(config).to.deep.equal({ host: 'localhost', port: '3306' });
        });

        it('returns empty object when no config', async function () {
            mockConn.query.resolves([]);
            let config = await db.getConfig('BTC', 'mainnet', 'encoder');
            expect(config).to.deep.equal({});
        });
    });
}

function registerGetAllConfigsTests() {
    describe('getAllConfigs()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('reconstructs nested hierarchy', async function () {
            mockConn.query.resolves([
                { coin: 'BTC', network: 'mainnet', module: 'indexer', param_name: 'host', param_value: 'idx-host' },
                { coin: 'BTC', network: 'mainnet', module: 'indexer', param_name: 'port', param_value: '3309' },
                { coin: 'LTC', network: 'testnet', module: 'decoder', param_name: 'host', param_value: 'dec-host' }
            ]);

            let configs = await db.getAllConfigs();
            expect(configs.BTC.mainnet.indexer.host).to.equal('idx-host');
            expect(configs.BTC.mainnet.indexer.port).to.equal('3309');
            expect(configs.LTC.testnet.decoder.host).to.equal('dec-host');
        });

        it('returns empty object when no configs', async function () {
            mockConn.query.resolves([]);
            let configs = await db.getAllConfigs();
            expect(configs).to.deep.equal({});
        });
    });
}

function registerGetLastSeqTests() {
    describe('getLastSeq()', function () {
        let db;
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });

        it('returns the persisted last_seq as an integer', async function () {
            mockConn.query.resolves([{ value: '42' }]);
            let seq = await db.getLastSeq();
            expect(seq).to.equal(42);
        });

        it('returns 0 when no consensus_state row exists', async function () {
            mockConn.query.resolves([]);
            let seq = await db.getLastSeq();
            expect(seq).to.equal(0);
        });

        it('returns 0 when the stored value is unparseable', async function () {
            mockConn.query.resolves([{ value: 'not-a-number' }]);
            let seq = await db.getLastSeq();
            expect(seq).to.equal(0);
        });
    });
}

describe('Database', function () {
    registerDatabaseHooks();
    registerSetParamTests();
    registerSetParamsTests();
    registerGetConfigTests();
    registerGetAllConfigsTests();
    registerGetLastSeqTests();
});

