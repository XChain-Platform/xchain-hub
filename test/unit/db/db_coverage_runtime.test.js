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
//
// Extended coverage for src/db.js: exercises the schema/migration/drift
// machinery and config helpers not covered by db.test.js (verifyDatabase,
// createDatabase, verifyTables, runMigrations, createTableFromFile,
// stripSqlLineComments, parseExpectedColumns, alterTableForDrift, the
// getConnection retry/backoff tail, chain-tip helpers, the getAllConfigs
// cursor branch, and getConfigWatermark). DB is fully mocked via proxyquire.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

// Build a Database class with fully-stubbed mariadb + fs. `fsOverrides` lets a
// test inject specific readdirSync/readFileSync behaviour for the schema paths.
function makeDb(fsOverrides) {
    const mockConn = {
        query:   sinon.stub().resolves([]),
        release: sinon.stub().resolves(),
        end:     sinon.stub().resolves()
    };
    const mockPool = {
        getConnection: sinon.stub().resolves(mockConn),
        end:           sinon.stub().resolves()
    };
    const mockMariadb = {
        createPool:       sinon.stub().returns(mockPool),
        createConnection: sinon.stub().resolves(mockConn)
    };
    const fsStub = Object.assign({
        readdirSync:  sinon.stub().returns([]),
        readFileSync: sinon.stub().returns('')
    }, fsOverrides || {});

    const Database = proxyquire('../../../src/db', {
        mariadb: mockMariadb,
        fs:      fsStub,
        path:    require('path')
    });

    const db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
    return { db, mockConn, mockPool, mockMariadb, fsStub };
}

function fatalErr(code) { const e = new Error(code); e.code = code; return e; }


function registerDatabaseHooks() {
        beforeEach(function () {
            // Keep negative-path logs out of the test output; some are asserted on.
            sinon.stub(console, 'log');
            sinon.stub(console, 'error');
            sinon.stub(console, 'warn');
        });

        afterEach(function () {
            sinon.restore();
        });
}

function registerGetConnectionTests() {
    // -----------------------------------------------------------------
    // getConnection(): transaction + retry/backoff tail
    // -----------------------------------------------------------------

    describe('getConnection()', function () {
        it('returns the active transaction connection without touching the pool', async function () {
            const { db, mockPool } = makeDb();
            const txConn = { marker: true };
            db.transactionConnection = txConn;
            expect(await db.getConnection()).to.equal(txConn);
            expect(mockPool.getConnection.called).to.be.false;
        });

        it('retries with backoff then succeeds', async function () {
            const { db, mockPool, mockConn } = makeDb();
            sinon.stub(db, '_sleep').resolves();
            mockPool.getConnection
                .onFirstCall().rejects(new Error('refused'))
                .onSecondCall().resolves(mockConn);
            const c = await db.getConnection();
            expect(c).to.equal(mockConn);
            expect(db._sleep.called).to.be.true;
            expect(db.circuitFailures).to.equal(0); // reset on success
        });

        it('rethrows a query error when inside a transaction', async function () {
            const { db, mockConn } = makeDb();
            db.transactionConnection = mockConn; // marks tx active
            mockConn.query.rejects(new Error('constraint violation'));
            try {
                await db.doQuery('INSERT INTO t VALUES (1)');
                expect.fail('should have rethrown inside a transaction');
            } catch (e) {
                expect(e.message).to.equal('constraint violation');
            }
            expect(mockConn.release.called).to.be.false; // tx conn is not released by doQuery
        });

        it('throws after exhausting maxAttempts when the circuit stays closed', async function () {
            const { db, mockPool } = makeDb();
            sinon.stub(db, '_sleep').resolves();
            db.circuitThreshold = 1000; // keep the breaker from tripping first
            mockPool.getConnection.rejects(new Error('refused'));
            try {
                await db.getConnection();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.include('Could not connect to MariaDB after 30 attempts');
            }
        });
    });
}

function registerChainTipHelpersTests() {
    // -----------------------------------------------------------------
    // setChainTip() / getChainTip()
    // -----------------------------------------------------------------

    describe('chain tip helpers', function () {
        it('setChainTip normalizes the coin abbreviation to its full name, defaulting network to mainnet', async function () {
            const { db } = makeDb();
            const setParam = sinon.stub(db, 'setParam').resolves();
            await db.setChainTip('BTC', null, 840000, 1718000000);
            // 'BTC' normalizes to 'bitcoin' so chain_tips co-locate under the
            // canonical coin key (not a phantom abbreviation-keyed coin).
            expect(setParam.calledWith('bitcoin', 'mainnet', 'chain_tips', 'block_height', '840000')).to.be.true;
            expect(setParam.calledWith('bitcoin', 'mainnet', 'chain_tips', 'block_time', '1718000000')).to.be.true;
        });

        it('getChainTip returns null when no tip has been set', async function () {
            const { db } = makeDb();
            sinon.stub(db, 'getConfig').resolves({});
            expect(await db.getChainTip('BTC')).to.be.null;
        });

        it('getChainTip reads the canonical full-name key for a coin abbreviation', async function () {
            const { db } = makeDb();
            const getConfig = sinon.stub(db, 'getConfig')
                .resolves({ block_height: '840000', block_time: '1718000000' });
            const tip = await db.getChainTip('LTC', 'testnet');
            expect(tip).to.deep.equal({ blockHeight: 840000, blockTime: 1718000000, chainId: null });
            expect(getConfig.calledWith('litecoin', 'testnet', 'chain_tips')).to.be.true;
        });

        it('getChainTip falls back to the abbreviation key for pre-normalization tips', async function () {
            const { db } = makeDb();
            const getConfig = sinon.stub(db, 'getConfig');
            // Canonical key empty (no tip written since the normalization landed)...
            getConfig.withArgs('bitcoin', 'mainnet', 'chain_tips').resolves({});
            // ...but an older tip still lives under the raw abbreviation.
            getConfig.withArgs('BTC', 'mainnet', 'chain_tips')
                .resolves({ block_height: '820000', block_time: '1717000000' });
            const tip = await db.getChainTip('BTC');
            expect(tip).to.deep.equal({ blockHeight: 820000, blockTime: 1717000000, chainId: null });
        });

        it('getChainTip defaults block_time to 0 when unparseable', async function () {
            const { db } = makeDb();
            sinon.stub(db, 'getConfig').resolves({ block_height: '5', block_time: 'NaNish' });
            expect(await db.getChainTip('BTC')).to.deep.equal({ blockHeight: 5, blockTime: 0, chainId: null });
        });
    });
}

function registerGetAllConfigsIncrementalCursorTests() {
    // -----------------------------------------------------------------
    // getAllConfigs() cursor branch + getConfigWatermark()
    // -----------------------------------------------------------------

    describe('getAllConfigs() incremental cursor', function () {
        it('adds the UNIX_TIMESTAMP cursor predicate when sinceUpdatedAt > 0', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves([]);
            await db.getAllConfigs(1718000000);
            const [sql, args] = mockConn.query.getCall(0).args;
            // Inclusive >= boundary (#2265): a strict > dropped a write committed
            // in the same second as the watermark; consumers merge idempotently,
            // so re-delivering the cursor second is a no-op.
            expect(sql).to.include('WHERE UNIX_TIMESTAMP(updated_at) >= ?');
            expect(args).to.deep.equal([1718000000]);
        });

        it('omits the cursor predicate for 0 / NaN cursors', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves([]);
            await db.getAllConfigs(0);
            expect(mockConn.query.getCall(0).args[0]).to.not.include('WHERE');
            mockConn.query.resetHistory();
            await db.getAllConfigs('not-a-number');
            expect(mockConn.query.getCall(0).args[0]).to.not.include('WHERE');
        });
    });
}

function registerGetConfigWatermarkTests() {
    describe('getConfigWatermark()', function () {
        it('returns the MAX(updated_at) watermark as a number', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves([{ watermark: '1718000123' }]);
            expect(await db.getConfigWatermark()).to.equal(1718000123);
        });

        it('returns 0 when the table is empty (null watermark)', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves([{ watermark: null }]);
            expect(await db.getConfigWatermark()).to.equal(0);
        });

        it('returns 0 when no row comes back at all', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves([]);
            expect(await db.getConfigWatermark()).to.equal(0);
        });
    });
}

describe('Database: extended coverage', function () {
    registerDatabaseHooks();
    registerGetConnectionTests();
    registerChainTipHelpersTests();
    registerGetAllConfigsIncrementalCursorTests();
    registerGetConfigWatermarkTests();
});

