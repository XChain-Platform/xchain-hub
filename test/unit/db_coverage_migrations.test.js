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

function registerMigrateColumnTypeTests() {
    // -----------------------------------------------------------------
    // _migrateColumnType()   (#4315)
    // -----------------------------------------------------------------

    describe('_migrateColumnType()', function () {

        it('skips when the live DATA_TYPE already matches the target', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves([{ DATA_TYPE: 'datetime' }]);
            await db._migrateColumnType('governance_proposals', 'voting_end', 'datetime', 'DATETIME NOT NULL');
            // only the information_schema SELECT runs; no ALTER
            expect(mockConn.query.callCount).to.equal(1);
            expect(mockConn.release.called).to.be.true;
        });

        it('converts the column in place when the live type differs', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query
                .onCall(0).resolves([{ DATA_TYPE: 'timestamp' }])
                .onCall(1).resolves([]); // ALTER MODIFY
            await db._migrateColumnType('governance_proposals', 'voting_end', 'datetime', 'DATETIME NOT NULL');
            const alter = mockConn.query.getCall(1).args[0];
            expect(alter).to.include('ALTER TABLE `governance_proposals` MODIFY `voting_end`');
            expect(alter).to.include('DATETIME NOT NULL');
            expect(console.log.calledWithMatch(/converted governance_proposals\.voting_end timestamp -> datetime/)).to.be.true;
            expect(mockConn.release.called).to.be.true;
        });

        it('is a no-op when the table/column is absent (fresh install)', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves([]); // information_schema returns no row
            await db._migrateColumnType('governance_proposals', 'voting_end', 'datetime', 'DATETIME NOT NULL');
            expect(mockConn.query.callCount).to.equal(1); // no ALTER
            expect(mockConn.release.called).to.be.true;
        });

        // The conversion failure is swallowed so one bad ALTER cannot take the hub's boot
        // down with it, but it must be LOUD: the line names what it costs and the exact
        // statement an operator runs to finish the job by hand.
        it('catches a failed ALTER, says what it costs, and still releases the connection', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query
                .onCall(0).resolves([{ DATA_TYPE: 'timestamp' }])
                .onCall(1).rejects(new Error('alter failed'));
            await db._migrateColumnType('governance_proposals', 'voting_end', 'datetime', 'DATETIME NOT NULL');
            expect(console.error.calledWithMatch(/MIGRATION FAILED: governance_proposals\.voting_end/)).to.be.true;
            expect(console.error.calledWithMatch(/2038-01-19/)).to.be.true;
            expect(console.error.calledWithMatch(/ALTER TABLE `governance_proposals` MODIFY `voting_end` DATETIME NOT NULL/)).to.be.true;
            expect(mockConn.release.called).to.be.true;
        });
    });
}

function registerMigrateEnumColumnTests() {
    // -----------------------------------------------------------------
    // migrateEnumColumn()
    // -----------------------------------------------------------------

    describe('migrateEnumColumn()', function () {
        const TARGET = ['price', 'cross_chain', 'oracle_publish', 'attestation', 'full_node'];

        it('skips when the live column already covers every target value', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves([{ COLUMN_TYPE: "enum('price','cross_chain','oracle_publish','attestation','full_node')" }]);
            await db.migrateEnumColumn('validator_capabilities', 'capability', TARGET, 'NOT NULL');
            // only the COLUMN_TYPE SELECT runs; no ALTER
            expect(mockConn.query.callCount).to.equal(1);
            expect(mockConn.release.called).to.be.true;
        });

        it('widens the column in place when a target value is missing', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query
                .onCall(0).resolves([{ COLUMN_TYPE: "enum('price','cross_chain','oracle_publish','attestation')" }])
                .onCall(1).resolves([]); // ALTER MODIFY
            await db.migrateEnumColumn('validator_capabilities', 'capability', TARGET, 'NOT NULL');
            const alter = mockConn.query.getCall(1).args[0];
            expect(alter).to.include('ALTER TABLE `validator_capabilities` MODIFY `capability`');
            expect(alter).to.include("'full_node'");
            expect(alter).to.include('NOT NULL');
            expect(console.log.calledWithMatch(/widened validator_capabilities\.capability/)).to.be.true;
        });

        it('is a no-op when the table/column is absent (fresh install)', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves([]); // information_schema returns no row
            await db.migrateEnumColumn('validator_capabilities', 'capability', TARGET, 'NOT NULL');
            expect(mockConn.query.callCount).to.equal(1); // no ALTER
        });

        it('catches and logs an error, still releasing the connection', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query
                .onCall(0).resolves([{ COLUMN_TYPE: "enum('price')" }])
                .onCall(1).rejects(new Error('alter failed'));
            await db.migrateEnumColumn('validator_capabilities', 'capability', TARGET, 'NOT NULL');
            expect(console.error.calledWithMatch(/Migration error widening validator_capabilities\.capability/)).to.be.true;
            expect(mockConn.release.called).to.be.true;
        });
    });
}

function registerMigrateIndexTests() {
    // -----------------------------------------------------------------
    // migrateIndex()
    // -----------------------------------------------------------------

    describe('migrateIndex()', function () {
        it('skips the ALTER when the index already exists', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.resolves([{ c: 1 }]); // index already present
            await db.migrateIndex('validator_rewards', 'idx_batch_seq', '(batch_seq)');
            // only the existence SELECT runs; no ALTER
            expect(mockConn.query.callCount).to.equal(1);
            expect(mockConn.release.called).to.be.true;
        });

        it('adds the index with ADD INDEX (no dedup step) when absent', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query
                .onCall(0).resolves([{ c: 0 }]) // not present
                .onCall(1).resolves([]);        // ALTER ADD INDEX
            await db.migrateIndex('validator_rewards', 'idx_batch_seq', '(batch_seq)');
            // exactly two queries: the existence check + the ALTER (no DELETE dedup)
            expect(mockConn.query.callCount).to.equal(2);
            const add = mockConn.query.getCall(1).args[0];
            expect(add).to.include('ALTER TABLE validator_rewards ADD INDEX idx_batch_seq (batch_seq)');
            expect(add).to.not.include('UNIQUE');
            expect(console.log.calledWithMatch(/added INDEX idx_batch_seq on validator_rewards/)).to.be.true;
        });

        it('catches and logs a migration error, still releasing the connection', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.onCall(0).resolves([{ c: 0 }]).onCall(1).rejects(new Error('alter failed'));
            await db.migrateIndex('validator_rewards', 'idx_batch_seq', '(batch_seq)'); // must not throw
            expect(console.error.calledWithMatch(/Migration error on validator_rewards/)).to.be.true;
            expect(mockConn.release.called).to.be.true;
        });
    });
}

describe('Database: extended coverage', function () {
    registerDatabaseHooks();
    registerMigrateColumnTypeTests();
    registerMigrateEnumColumnTests();
    registerMigrateIndexTests();
});

