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

function registerUniqueKeyMigrationTests() {
        it('skips the migration when the unique key already exists', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves([{ c: 1 }]); // index already present
            await db.migrateUniqueKey('t', 'uq', '(a)', ['a']);
            // only the existence SELECT runs; no DELETE / ALTER
            expect(mockConn.query.callCount).to.equal(1);
            expect(mockConn.release.called).to.be.true;
        });

        it('removes duplicates and adds the unique key when absent', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query
                .onCall(0).resolves([{ c: 0 }])              // not present
                .onCall(1).resolves({ affectedRows: 2 })     // DELETE dupes
                .onCall(2).resolves([]);                     // ALTER ADD UNIQUE
            await db.migrateUniqueKey('mytable', 'uq_x', '(a, b)', ['a', 'b']);
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
            await db.migrateUniqueKey('t', 'uq', '(a)', ['a']);
            expect(mockConn.query.getCall(2).args[0]).to.include('ADD UNIQUE KEY uq');
            expect(console.log.calledWithMatch(/duplicate/)).to.be.false;
        });

        it('catches and logs a migration error, still releasing the connection', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.onCall(0).resolves([{ c: 0 }]).onCall(1).rejects(new Error('alter failed'));
            await db.migrateUniqueKey('t', 'uq', '(a)', ['a']); // must not throw
            expect(console.error.calledWithMatch(/Migration error on t/)).to.be.true;
            expect(mockConn.release.called).to.be.true;
        });
}

function registerRunMigrationSequenceTests() {
        it('runMigrations migrates unique keys, the batch index, and the capability ENUM', async function () {
            const { db } = makeDb();
            const mig = sinon.stub(db, 'migrateUniqueKey').resolves();
            const idx = sinon.stub(db, 'migrateIndex').resolves();
            const en  = sinon.stub(db, 'migrateEnumColumn').resolves();
            sinon.stub(db, 'migrateColumnType').resolves();
            await db.runMigrations();
            expect(mig.calledWith('oracle_submissions', 'uq_submission')).to.be.true;
            expect(mig.calledWith('validator_rewards', 'uq_reward')).to.be.true;
            expect(idx.calledWith('validator_rewards', 'idx_batch_seq', '(batch_seq)')).to.be.true;
            // The three price_snapshots frontier indexes: names and column lists byte-equal
            // to the KEY lines in src/sql/price_snapshots.sql, the first two also to the
            // indexer and explorer mirror twins, so a hub that predates them converges on the
            // same index set a fresh install gets.
            expect(idx.calledWith('price_snapshots', 'idx_status_block_round', '(status, reference_block, round_number)')).to.be.true;
            expect(idx.calledWith('price_snapshots', 'idx_status_timestamp_round', '(status, block_timestamp, round_number)')).to.be.true;
            expect(idx.calledWith('price_snapshots', 'idx_status_created', '(status, created_at)')).to.be.true;
            const enCall = en.getCall(0);
            expect(enCall.args[0]).to.equal('validator_capabilities');
            expect(enCall.args[1]).to.equal('capability');
            expect(enCall.args[2]).to.include('full_node');
        });

        // The archive-leg qualifier reaches an AGED hub only through runMigrations:
        // alterTableForDrift adds the column (it carries a DEFAULT) but never touches an
        // index, and migrateUniqueKey no-ops as soon as the index NAME exists. The
        // backfill must run BEFORE the widen, or a pre-column archive row keeps qualifier
        // 0 and falls out of every qualified predicate as though it were absent.
        it('runMigrations backfills the archive round qualifier, then widens uq_reward', async function () {
            const { db } = makeDb();
            sinon.stub(db, 'migrateUniqueKey').resolves();
            sinon.stub(db, 'migrateIndex').resolves();
            sinon.stub(db, 'migrateEnumColumn').resolves();
            sinon.stub(db, 'migrateColumnType').resolves();
            const back = sinon.stub(db, 'backfillArchiveRoundQualifier').resolves();
            const wide = sinon.stub(db, 'widenUniqueKey').resolves();
            await db.runMigrations();
            expect(back.calledOnce).to.be.true;
            const widen = wide.getCalls().find(c => c.args[0] === 'validator_rewards');
            expect(widen, 'uq_reward must be widened on aged databases').to.not.be.undefined;
            expect(widen.args[1]).to.equal('uq_reward');
            expect(widen.args[2]).to.equal('round_qualifier');
            expect(widen.args[3]).to.equal('(validator_pubkey, round_number, reward_type, round_qualifier)');
            expect(back.calledBefore(wide), 'backfill must precede the widen').to.be.true;
        });
}

function registerMigrationBackfillTests() {
        it('the archive qualifier backfill touches only anchor_archive rows still at 0', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves({ affectedRows: 2 });
            await db.backfillArchiveRoundQualifier();
            const [sql, args] = mockConn.query.getCall(0).args;
            expect(sql).to.include('UPDATE validator_rewards SET round_qualifier = block_index');
            expect(sql).to.include('reward_type = ?');
            expect(sql).to.include('round_qualifier = 0');
            expect(sql).to.include('block_index IS NOT NULL');
            expect(args).to.deep.equal(['anchor_archive']);
            expect(mockConn.release.called).to.be.true;
        });

        // #4315: a DDL-only fix converts fresh installs and leaves every DEPLOYED hub
        // TIMESTAMP-bound, because alterTableForDrift never MODIFYs a type. The migration
        // being wired is therefore part of the fix, not a detail of it.
        it('runMigrations converts both governance voting deadline columns to DATETIME', async function () {
            const { db } = makeDb();
            sinon.stub(db, 'migrateUniqueKey').resolves();
            sinon.stub(db, 'migrateIndex').resolves();
            sinon.stub(db, 'migrateEnumColumn').resolves();
            const col = sinon.stub(db, 'migrateColumnType').resolves();
            await db.runMigrations();
            for (const column of ['voting_start', 'voting_end']) {
                const call = col.getCalls().find(c => c.args[1] === column);
                expect(call, column + ' is not migrated').to.exist;
                expect(call.args[0]).to.equal('governance_proposals');
                expect(call.args[2]).to.equal('datetime');
                expect(call.args[3]).to.include('DATETIME');
                expect(call.args[3]).to.include('NOT NULL');
            }
        });
}

function registerRunMigrationsMigrateUniqueKeyTests() {
    // -----------------------------------------------------------------
    // runMigrations() / migrateUniqueKey()
    // -----------------------------------------------------------------
    describe('runMigrations() / migrateUniqueKey()', function () {
        registerUniqueKeyMigrationTests();
        registerRunMigrationSequenceTests();
        registerMigrationBackfillTests();
    });
}

describe('Database: extended coverage', function () {
    registerDatabaseHooks();
    registerFailFastIfFatalTests();
    registerVerifyDatabaseTests();
    registerCreateDatabaseTests();
    registerVerifyTablesTests();
    registerRunMigrationsMigrateUniqueKeyTests();
});
