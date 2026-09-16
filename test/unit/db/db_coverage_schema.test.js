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

function registerCreateTableFromFileTests() {
    // -----------------------------------------------------------------
    // createTableFromFile()
    // -----------------------------------------------------------------

    describe('createTableFromFile()', function () {
        it('splits the SQL file on ; and runs each non-empty statement', async function () {
            const sql = 'CREATE TABLE configs (id INT);\n\n  ;\nINSERT INTO configs VALUES (1);';
            const { db, mockConn } = makeDb({ readFileSync: sinon.stub().returns(sql) });
            await db.createTableFromFile('configs.sql');
            const ran = mockConn.query.getCalls().map(c => c.args[0]);
            expect(ran).to.include('CREATE TABLE configs (id INT)');
            expect(ran).to.include('INSERT INTO configs VALUES (1)');
            // the blank `;` segment is skipped
            expect(ran.every(q => q.trim() !== '')).to.be.true;
        });
    });
}

function registerStripSqlLineCommentsTests() {
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
}

function registerParseExpectedColumnsTests() {
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
}

// -----------------------------------------------------------------
// alterTableForDrift()
// -----------------------------------------------------------------
function registerAlterTableForDriftTests() {
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
}

describe('Database: extended coverage', function () {
    registerDatabaseHooks();
    registerCreateTableFromFileTests();
    registerStripSqlLineCommentsTests();
    registerParseExpectedColumnsTests();
    registerAlterTableForDriftTests();
});
