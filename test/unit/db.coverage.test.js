'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.
//
// Extended coverage for src/db.js — exercises the schema/migration/drift
// machinery and config helpers not covered by db.test.js (verifyDatabase,
// createDatabase, verifyTables, runMigrations, _createTableFromFile,
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

    const Database = proxyquire('../../src/db', {
        mariadb: mockMariadb,
        fs:      fsStub,
        path:    require('path')
    });

    const db = new Database('localhost', 3306, 'test_db', 'user', 'pass');
    return { db, mockConn, mockPool, mockMariadb, fsStub };
}

function fatalErr(code) { const e = new Error(code); e.code = code; return e; }

describe('Database — extended coverage', function () {

    beforeEach(function () {
        // Keep negative-path logs out of the test output; some are asserted on.
        sinon.stub(console, 'log');
        sinon.stub(console, 'error');
        sinon.stub(console, 'warn');
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // _failFastIfFatal()
    // -----------------------------------------------------------------

    describe('_failFastIfFatal()', function () {
        ['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR',
         'ER_SPECIFIC_ACCESS_DENIED_ERROR', 'ER_PASSWORD_NO_MATCH'].forEach(function (code) {
            it('throws a descriptive error on fatal code ' + code, function () {
                const { db } = makeDb();
                expect(() => db._failFastIfFatal(fatalErr(code), 'testing'))
                    .to.throw(new RegExp('Fatal DB error while testing \\(' + code + '\\)'));
            });
        });

        it('is a no-op for a transient error code', function () {
            const { db } = makeDb();
            expect(() => db._failFastIfFatal(fatalErr('ECONNREFUSED'), 'connecting')).to.not.throw();
        });

        it('is a no-op when the error is null/undefined', function () {
            const { db } = makeDb();
            expect(() => db._failFastIfFatal(null, 'x')).to.not.throw();
            expect(() => db._failFastIfFatal(undefined, 'x')).to.not.throw();
        });
    });

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
            sinon.stub(db, '_sleep').resolves();
            mockMariadb.createConnection
                .onFirstCall().rejects(new Error('socket hang up')) // no .code -> "unknown"
                .onSecondCall().resolves(mockConn);
            mockConn.query.resolves([{ schema_name: 'test_db' }]);
            expect(await db.verifyDatabase()).to.be.true;
            expect(db._sleep.calledWith(5000)).to.be.true;
        });
    });

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
            sinon.stub(db, '_sleep').resolves();
            mockMariadb.createConnection
                .onFirstCall().rejects(new Error('reset')) // no .code -> "unknown"
                .onSecondCall().resolves(mockConn);
            expect(await db.createDatabase()).to.be.true;
            expect(db._sleep.calledWith(5000)).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // verifyTables()
    // -----------------------------------------------------------------

    describe('verifyTables()', function () {
        it('creates a table that does not yet exist', async function () {
            const { db, mockConn } = makeDb({ readdirSync: sinon.stub().returns(['configs.sql']) });
            mockConn.query.resolves([]); // information_schema.tables -> not found
            const create = sinon.stub(db, '_createTableFromFile').resolves();
            const alter  = sinon.stub(db, 'alterTableForDrift').resolves();
            expect(await db.verifyTables()).to.be.true;
            expect(create.calledWith('configs.sql')).to.be.true;
            expect(alter.called).to.be.false;
            expect(mockConn.release.called).to.be.true;
        });

        it('reconciles drift on an existing table', async function () {
            const { db, mockConn } = makeDb({ readdirSync: sinon.stub().returns(['configs.sql']) });
            mockConn.query.resolves([{ table_name: 'configs' }]); // found
            const create = sinon.stub(db, '_createTableFromFile').resolves();
            const alter  = sinon.stub(db, 'alterTableForDrift').resolves();
            await db.verifyTables();
            expect(alter.calledWith('configs.sql')).to.be.true;
            expect(create.called).to.be.false;
        });

        it('ignores non-.sql files in the schema directory', async function () {
            const { db, mockConn } = makeDb({ readdirSync: sinon.stub().returns(['README.md', 'notes.txt']) });
            const create = sinon.stub(db, '_createTableFromFile').resolves();
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

    // -----------------------------------------------------------------
    // runMigrations() / _migrateUniqueKey()
    // -----------------------------------------------------------------

    describe('runMigrations() / _migrateUniqueKey()', function () {
        it('skips the migration when the unique key already exists', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves([{ c: 1 }]); // index already present
            await db._migrateUniqueKey('t', 'uq', '(a)', ['a']);
            // only the existence SELECT runs — no DELETE / ALTER
            expect(mockConn.query.callCount).to.equal(1);
            expect(mockConn.release.called).to.be.true;
        });

        it('removes duplicates and adds the unique key when absent', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query
                .onCall(0).resolves([{ c: 0 }])              // not present
                .onCall(1).resolves({ affectedRows: 2 })     // DELETE dupes
                .onCall(2).resolves([]);                     // ALTER ADD UNIQUE
            await db._migrateUniqueKey('mytable', 'uq_x', '(a, b)', ['a', 'b']);
            const del = mockConn.query.getCall(1).args[0];
            const add = mockConn.query.getCall(2).args[0];
            expect(del).to.include('DELETE t1 FROM mytable t1');
            expect(del).to.include('t1.a = t2.a AND t1.b = t2.b');
            expect(add).to.include('ADD UNIQUE KEY uq_x (a, b)');
            expect(console.log.calledWithMatch(/removed 2 duplicate/)).to.be.true;
        });

        it('adds the key without a "removed duplicates" log when there are none', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query
                .onCall(0).resolves([{ c: 0 }]) // not present
                .onCall(1).resolves({})         // DELETE -> no affectedRows
                .onCall(2).resolves([]);        // ALTER ADD UNIQUE
            await db._migrateUniqueKey('t', 'uq', '(a)', ['a']);
            expect(mockConn.query.getCall(2).args[0]).to.include('ADD UNIQUE KEY uq');
            expect(console.log.calledWithMatch(/duplicate/)).to.be.false;
        });

        it('catches and logs a migration error, still releasing the connection', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.onCall(0).resolves([{ c: 0 }]).onCall(1).rejects(new Error('alter failed'));
            await db._migrateUniqueKey('t', 'uq', '(a)', ['a']); // must not throw
            expect(console.error.calledWithMatch(/Migration error on t/)).to.be.true;
            expect(mockConn.release.called).to.be.true;
        });

        it('runMigrations migrates both oracle_submissions and validator_rewards', async function () {
            const { db } = makeDb();
            const mig = sinon.stub(db, '_migrateUniqueKey').resolves();
            await db.runMigrations();
            expect(mig.calledWith('oracle_submissions', 'uq_submission')).to.be.true;
            expect(mig.calledWith('validator_rewards', 'uq_reward')).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // _createTableFromFile()
    // -----------------------------------------------------------------

    describe('_createTableFromFile()', function () {
        it('splits the SQL file on ; and runs each non-empty statement', async function () {
            const sql = 'CREATE TABLE configs (id INT);\n\n  ;\nINSERT INTO configs VALUES (1);';
            const { db, mockConn } = makeDb({ readFileSync: sinon.stub().returns(sql) });
            await db._createTableFromFile('configs.sql');
            const ran = mockConn.query.getCalls().map(c => c.args[0]);
            expect(ran).to.include('CREATE TABLE configs (id INT)');
            expect(ran).to.include('INSERT INTO configs VALUES (1)');
            // the blank `;` segment is skipped
            expect(ran.every(q => q.trim() !== '')).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // stripSqlLineComments()
    // -----------------------------------------------------------------

    describe('stripSqlLineComments()', function () {
        let db;
        beforeEach(function () { db = makeDb().db; });

        it('strips a -- line comment but keeps the newline', function () {
            expect(db.stripSqlLineComments('a INT, -- a comment\nb INT')).to.equal('a INT, \nb INT');
        });

        it('preserves a -- sequence inside a quoted string', function () {
            const out = db.stripSqlLineComments("name VARCHAR DEFAULT 'a -- b'");
            expect(out).to.include("'a -- b'");
        });

        it('treats a doubled quote inside a string as an escape', function () {
            const out = db.stripSqlLineComments("v VARCHAR DEFAULT 'it''s -- ok'");
            expect(out).to.include("'it''s -- ok'");
        });

        it('handles backtick-quoted identifiers', function () {
            const out = db.stripSqlLineComments('`weird--col` INT -- trailing\n');
            expect(out).to.include('`weird--col`');
            expect(out).to.not.include('trailing');
        });
    });

    // -----------------------------------------------------------------
    // parseExpectedColumns()
    // -----------------------------------------------------------------

    describe('parseExpectedColumns()', function () {
        let db;
        beforeEach(function () { db = makeDb().db; });

        it('returns null when there is no CREATE TABLE block', function () {
            expect(db.parseExpectedColumns('SELECT 1;')).to.be.null;
        });

        it('parses columns with nullability / default flags', function () {
            const sql = 'CREATE TABLE IF NOT EXISTS t (\n' +
                        '  id INT NOT NULL PRIMARY KEY,\n' +
                        '  name VARCHAR(20),\n' +
                        '  created INT NOT NULL DEFAULT 0,\n' +
                        '  PRIMARY KEY (id)\n' +
                        ');';
            const cols = db.parseExpectedColumns(sql);
            const byName = Object.fromEntries(cols.map(c => [c.name, c]));
            expect(byName).to.have.all.keys('id', 'name', 'created'); // constraint line skipped
            expect(byName.id.notNull).to.be.true;            // inline PRIMARY KEY -> notNull
            expect(byName.name.nullable).to.be.true;
            expect(byName.created.notNull).to.be.true;
            expect(byName.created.hasDefault).to.be.true;
        });

        it('returns null when the block has only constraint lines', function () {
            const sql = 'CREATE TABLE t (\n  PRIMARY KEY (a),\n  UNIQUE KEY uq (b)\n);';
            expect(db.parseExpectedColumns(sql)).to.be.null;
        });

        it('skips empty segments and single-token (typeless) column lines', function () {
            // `id INT,,` -> an empty segment; ` onlyname` -> a single token (no type)
            const cols = db.parseExpectedColumns('CREATE TABLE t (id INT,, onlyname, b VARCHAR(2));');
            expect(cols.map(c => c.name)).to.deep.equal(['id', 'b']);
        });
    });

    // -----------------------------------------------------------------
    // alterTableForDrift()
    // -----------------------------------------------------------------

    describe('alterTableForDrift()', function () {
        // A fake caller-supplied connection whose first query returns the live
        // columns and whose subsequent (ALTER) queries resolve empty.
        function conn(liveCols) {
            const c = { query: sinon.stub().resolves([]) };
            c.query.onFirstCall().resolves(liveCols);
            return c;
        }

        it('returns early when the SQL has no parseable columns', async function () {
            const { db } = makeDb({ readFileSync: sinon.stub().returns('-- just a comment\n') });
            const c = { query: sinon.stub().resolves([]) };
            await db.alterTableForDrift('t.sql', c);
            expect(c.query.called).to.be.false;
        });

        it('adds a missing column from the SQL source', async function () {
            const { db } = makeDb({
                readFileSync: sinon.stub().returns("CREATE TABLE t (id INT NOT NULL, extra VARCHAR(8) DEFAULT 'x');")
            });
            const c = conn([{ COLUMN_NAME: 'id', IS_NULLABLE: 'NO', COLUMN_TYPE: 'int' }]);
            await db.alterTableForDrift('t.sql', c);
            const alters = c.query.getCalls().slice(1).map(x => x.args[0]);
            expect(alters.some(s => /ADD COLUMN extra VARCHAR\(8\)/.test(s))).to.be.true;
        });

        it('skips a missing NOT NULL column that has no DEFAULT', async function () {
            const { db } = makeDb({
                readFileSync: sinon.stub().returns('CREATE TABLE t (id INT, req VARCHAR(10) NOT NULL);')
            });
            const c = conn([{ COLUMN_NAME: 'id', IS_NULLABLE: 'YES', COLUMN_TYPE: 'int' }]);
            await db.alterTableForDrift('t.sql', c);
            const alters = c.query.getCalls().slice(1).map(x => x.args[0]);
            expect(alters.some(s => /ADD COLUMN req/.test(s))).to.be.false;
            expect(console.log.calledWithMatch(/cannot backfill/)).to.be.true;
        });

        it('relaxes a live NOT NULL column when the source is nullable', async function () {
            const { db } = makeDb({
                readFileSync: sinon.stub().returns('CREATE TABLE t (col VARCHAR(10));')
            });
            const c = conn([{ COLUMN_NAME: 'col', IS_NULLABLE: 'NO', COLUMN_TYPE: 'varchar(10)' }]);
            await db.alterTableForDrift('t.sql', c);
            const alters = c.query.getCalls().slice(1).map(x => x.args[0]);
            expect(alters.some(s => /MODIFY `col` varchar\(10\) NULL/.test(s))).to.be.true;
        });

        it('makes no changes when the live schema already matches', async function () {
            const { db } = makeDb({
                readFileSync: sinon.stub().returns('CREATE TABLE t (col VARCHAR(10));')
            });
            const c = conn([{ COLUMN_NAME: 'col', IS_NULLABLE: 'YES', COLUMN_TYPE: 'varchar(10)' }]);
            await db.alterTableForDrift('t.sql', c);
            expect(c.query.callCount).to.equal(1); // only the live-columns SELECT
        });
    });

    // -----------------------------------------------------------------
    // getConnection() — transaction + retry/backoff tail
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

    // -----------------------------------------------------------------
    // setChainTip() / getChainTip()
    // -----------------------------------------------------------------

    describe('chain tip helpers', function () {
        it('setChainTip writes block_height and block_time, defaulting network to mainnet', async function () {
            const { db } = makeDb();
            const setParam = sinon.stub(db, 'setParam').resolves();
            await db.setChainTip('BTC', null, 840000, 1718000000);
            expect(setParam.calledWith('BTC', 'mainnet', 'chain_tips', 'block_height', '840000')).to.be.true;
            expect(setParam.calledWith('BTC', 'mainnet', 'chain_tips', 'block_time', '1718000000')).to.be.true;
        });

        it('getChainTip returns null when no tip has been set', async function () {
            const { db } = makeDb();
            sinon.stub(db, 'getConfig').resolves({});
            expect(await db.getChainTip('BTC')).to.be.null;
        });

        it('getChainTip parses stored values and honours an explicit network', async function () {
            const { db } = makeDb();
            const getConfig = sinon.stub(db, 'getConfig')
                .resolves({ block_height: '840000', block_time: '1718000000' });
            const tip = await db.getChainTip('LTC', 'testnet');
            expect(tip).to.deep.equal({ blockHeight: 840000, blockTime: 1718000000 });
            expect(getConfig.calledWith('LTC', 'testnet', 'chain_tips')).to.be.true;
        });

        it('getChainTip defaults block_time to 0 when unparseable', async function () {
            const { db } = makeDb();
            sinon.stub(db, 'getConfig').resolves({ block_height: '5', block_time: 'NaNish' });
            expect(await db.getChainTip('BTC')).to.deep.equal({ blockHeight: 5, blockTime: 0 });
        });
    });

    // -----------------------------------------------------------------
    // getAllConfigs() cursor branch + getConfigWatermark()
    // -----------------------------------------------------------------

    describe('getAllConfigs() incremental cursor', function () {
        it('adds the UNIX_TIMESTAMP cursor predicate when sinceUpdatedAt > 0', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves([]);
            await db.getAllConfigs(1718000000);
            const [sql, args] = mockConn.query.getCall(0).args;
            expect(sql).to.include('WHERE UNIX_TIMESTAMP(updated_at) > ?');
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
});
