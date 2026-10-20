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
// Extended coverage for src/db.js: exercises the schema bring-up and drift
// machinery and config helpers not covered by db.test.js (verifyDatabase,
// createDatabase, verifyTables, createTableFromFile,
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

function registerFailFastIfFatalTests() {
    // -----------------------------------------------------------------
    // failFastIfFatal()
    // -----------------------------------------------------------------

    describe('failFastIfFatal()', function () {
        ['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR',
         'ER_SPECIFIC_ACCESS_DENIED_ERROR', 'ER_PASSWORD_NO_MATCH'].forEach(function (code) {
            it('throws a descriptive error on fatal code ' + code, function () {
                const { db } = makeDb();
                expect(() => db.failFastIfFatal(fatalErr(code), 'testing'))
                    .to.throw(new RegExp('Fatal DB error while testing \\(' + code + '\\)'));
            });
        });

        it('is a no-op for a transient error code', function () {
            const { db } = makeDb();
            expect(() => db.failFastIfFatal(fatalErr('ECONNREFUSED'), 'connecting')).to.not.throw();
        });

        it('is a no-op when the error is null/undefined', function () {
            const { db } = makeDb();
            expect(() => db.failFastIfFatal(null, 'x')).to.not.throw();
            expect(() => db.failFastIfFatal(undefined, 'x')).to.not.throw();
        });
    });
}

function registerVerifyDatabaseTests() {
    // -----------------------------------------------------------------
    // verifyDatabase()
    // -----------------------------------------------------------------

    describe('verifyDatabase()', function () {
        it('returns true when the schema row exists', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves([{ schema_name: 'test_db' }]);
            expect(await db.verifyDatabase()).to.be.true;
            expect(mockConn.end.called).to.be.true;
        });

        it('returns false when no schema row exists', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves([]);
            expect(await db.verifyDatabase()).to.be.false;
        });

        it('fail-fasts on a fatal credential error', async function () {
            const { db, mockMariadb } = makeDb();
            mockMariadb.createConnection.rejects(fatalErr('ER_ACCESS_DENIED_ERROR'));
            try {
                await db.verifyDatabase();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.match(/Fatal DB error/);
            }
        });

        it('retries on a transient (code-less) error then succeeds', async function () {
            const { db, mockMariadb, mockConn } = makeDb();
            sinon.stub(db, 'sleep').resolves();
            mockMariadb.createConnection
                .onFirstCall().rejects(new Error('socket hang up')) // no .code -> "unknown"
                .onSecondCall().resolves(mockConn);
            mockConn.query.resolves([{ schema_name: 'test_db' }]);
            expect(await db.verifyDatabase()).to.be.true;
            expect(db.sleep.calledWith(5000)).to.be.true;
        });
    });
}

function registerCreateDatabaseTests() {
    // -----------------------------------------------------------------
    // createDatabase()
    // -----------------------------------------------------------------

    describe('createDatabase()', function () {
        it('runs CREATE DATABASE IF NOT EXISTS and returns true', async function () {
            const { db, mockConn } = makeDb();
            expect(await db.createDatabase()).to.be.true;
            const sql = mockConn.query.getCall(0).args[0];
            expect(sql).to.include('CREATE DATABASE IF NOT EXISTS');
            expect(sql).to.include('test_db');
            expect(mockConn.end.called).to.be.true;
        });

        it('fail-fasts on a fatal privilege error', async function () {
            const { db, mockMariadb } = makeDb();
            mockMariadb.createConnection.rejects(fatalErr('ER_SPECIFIC_ACCESS_DENIED_ERROR'));
            try {
                await db.createDatabase();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.match(/Fatal DB error/);
            }
        });

        it('retries on a transient (code-less) error then succeeds', async function () {
            const { db, mockMariadb, mockConn } = makeDb();
            sinon.stub(db, 'sleep').resolves();
            mockMariadb.createConnection
                .onFirstCall().rejects(new Error('reset')) // no .code -> "unknown"
                .onSecondCall().resolves(mockConn);
            expect(await db.createDatabase()).to.be.true;
            expect(db.sleep.calledWith(5000)).to.be.true;
        });
    });
}

function registerVerifyTablesTests() {
    // -----------------------------------------------------------------
    // verifyTables()
    // -----------------------------------------------------------------

    describe('verifyTables()', function () {
        it('creates a table that does not yet exist', async function () {
            const { db, mockConn } = makeDb({ readdirSync: sinon.stub().returns(['configs.sql']) });
            mockConn.query.resolves([]); // information_schema.tables -> not found
            const create = sinon.stub(db, 'createTableFromFile').resolves();
            const alter  = sinon.stub(db, 'alterTableForDrift').resolves();
            expect(await db.verifyTables()).to.be.true;
            expect(create.calledWith('configs.sql')).to.be.true;
            expect(alter.called).to.be.false;
            expect(mockConn.release.called).to.be.true;
        });

        it('reconciles drift on an existing table', async function () {
            const { db, mockConn } = makeDb({ readdirSync: sinon.stub().returns(['configs.sql']) });
            mockConn.query.resolves([{ table_name: 'configs' }]); // found
            const create = sinon.stub(db, 'createTableFromFile').resolves();
            const alter  = sinon.stub(db, 'alterTableForDrift').resolves();
            await db.verifyTables();
            expect(alter.calledWith('configs.sql')).to.be.true;
            expect(create.called).to.be.false;
        });

        it('ignores non-.sql files in the schema directory', async function () {
            const { db, mockConn } = makeDb({ readdirSync: sinon.stub().returns(['README.md', 'notes.txt']) });
            const create = sinon.stub(db, 'createTableFromFile').resolves();
            await db.verifyTables();
            expect(mockConn.query.called).to.be.false;
            expect(create.called).to.be.false;
        });

        it('logs and rethrows when the existence check fails', async function () {
            const { db, mockConn } = makeDb({ readdirSync: sinon.stub().returns(['configs.sql']) });
            mockConn.query.rejects(new Error('boom'));
            try {
                await db.verifyTables();
                expect.fail('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('boom');
            }
            expect(console.error.called).to.be.true;
        });
    });
}

describe('Database: extended coverage', function () {
    registerDatabaseHooks();
    registerFailFastIfFatalTests();
    registerVerifyDatabaseTests();
    registerCreateDatabaseTests();
    registerVerifyTablesTests();
});
