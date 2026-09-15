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

let mockPool, mockConn, mockMariadb, Database, db;

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

            Database = proxyquire('../../src/db', {
                mariadb: mockMariadb,
                fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') },
                path:    require('path')
            });
        });

        afterEach(function () {
            sinon.restore();
        });
}

// information_schema.statistics answers for PRIMARY; everything else is empty.
function primaryKeyOf(columns, tableColumns) {
    mockConn.query.callsFake(async (sql, args) => {
        if (/information_schema\.statistics/.test(sql) && args && args[2] === 'PRIMARY')
            return columns.map(c => ({ col: c }));
        if (/information_schema\.columns/.test(sql))
            return (tableColumns || ['network', 'source_chain']).map(c => ({ col: c }));
        return [];
    });
}

function registerPriceFenceMigrationTests() {
        it('re-keys a chain-only PRIMARY onto (network, source_chain)', async function () {
            // First read: the legacy key. Read-back after the ALTER: the new one.
            let reads = 0;
            mockConn.query.callsFake(async (sql, args) => {
                if (/information_schema\.statistics/.test(sql) && args && args[2] === 'PRIMARY')
                    return (reads++ === 0 ? ['source_chain'] : ['network', 'source_chain']).map(c => ({ col: c }));
                if (/information_schema\.columns/.test(sql))
                    return [{ col: 'network' }, { col: 'source_chain' }];
                return [];
            });
            await db.migratePriceFencePrimaryKey();
            let alter = mockConn.query.getCalls().find(c => /ALTER TABLE/.test(c.args[0]));
            expect(alter, 'ALTER issued').to.exist;
            expect(alter.args[0]).to.match(/DROP PRIMARY KEY, ADD PRIMARY KEY \(network, source_chain\)/);
        });

        // One statement, never a DROP followed by a separate ADD: MariaDB DDL is not
        // transactional, and a table left keyless would seat two divergent fence rows for
        // the same (network, chain) instead of failing loudly.
        it('drops and adds in a single ALTER so the table is never left keyless', async function () {
            let reads = 0;
            mockConn.query.callsFake(async (sql, args) => {
                if (/information_schema\.statistics/.test(sql) && args && args[2] === 'PRIMARY')
                    return (reads++ === 0 ? ['source_chain'] : ['network', 'source_chain']).map(c => ({ col: c }));
                if (/information_schema\.columns/.test(sql))
                    return [{ col: 'network' }, { col: 'source_chain' }];
                return [];
            });
            await db.migratePriceFencePrimaryKey();
            let alters = mockConn.query.getCalls().filter(c => /ALTER TABLE/.test(c.args[0]));
            expect(alters.length).to.equal(1);
        });
}

function registerPriceFenceGuardTests() {
        it('no-ops once the key already covers both columns', async function () {
            primaryKeyOf(['network', 'source_chain']);
            await db.migratePriceFencePrimaryKey();
            expect(mockConn.query.getCalls().some(c => /ALTER TABLE/.test(c.args[0]))).to.equal(false);
        });

        it('no-ops when the table is not there yet (a fresh install ships the right key)', async function () {
            primaryKeyOf([]);
            await db.migratePriceFencePrimaryKey();
            expect(mockConn.query.getCalls().some(c => /ALTER TABLE/.test(c.args[0]))).to.equal(false);
        });

        // Re-keying onto a column the table does not have would drop the existing key and
        // fail the add, leaving the fence unconstrained. Refuse before touching it.
        it('refuses to touch the key when the network column has not landed', async function () {
            primaryKeyOf(['source_chain'], ['source_chain', 'retraction_generation']);
            let err = sinon.stub(console, 'error');
            await db.migratePriceFencePrimaryKey();
            expect(mockConn.query.getCalls().some(c => /ALTER TABLE/.test(c.args[0]))).to.equal(false);
            expect(err.getCalls().map(c => String(c.args[0])).join('\n')).to.contain('missing network');
        });

        // A statement that did not throw is not proof the key is there.
        it('reports loudly when the re-key did not take', async function () {
            primaryKeyOf(['source_chain']);
            let err = sinon.stub(console, 'error');
            await db.migratePriceFencePrimaryKey();
            expect(err.getCalls().map(c => String(c.args[0])).join('\n')).to.contain('did not take');
        });

        // The chain-keyed fence still rejects stale replays, over-broadly. Failing hub boot
        // over a scoping defect would trade it for an outage.
        it('logs instead of throwing when the ALTER fails', async function () {
            let reads = 0;
            mockConn.query.callsFake(async (sql, args) => {
                if (/ALTER TABLE/.test(sql)) throw new Error('DDL refused');
                if (/information_schema\.statistics/.test(sql) && args && args[2] === 'PRIMARY')
                    return [{ col: 'source_chain' }];
                if (/information_schema\.columns/.test(sql))
                    return [{ col: 'network' }, { col: 'source_chain' }];
                reads++;
                return [];
            });
            let err = sinon.stub(console, 'error');
            await db.migratePriceFencePrimaryKey();
            expect(err.called).to.equal(true);
            expect(mockConn.release.called, 'connection released').to.equal(true);
        });
}

function registerMigratePriceFencePrimaryKeyTests() {
    // The column reaches an already-deployed hub through alterTableForDrift,
    // which never touches keys: without this step a migrated hub carries `network` and
    // still collapses every network onto one row per chain, because the upsert keys on
    // the PRIMARY. The re-key IS the fix; the column alone is not.
    describe('migratePriceFencePrimaryKey()', function () {
        beforeEach(function () { db = new Database('h', 3306, 'db', 'u', 'p'); });
        registerPriceFenceMigrationTests();
        registerPriceFenceGuardTests();
    });
}

function registerCloseTests() {
    // -----------------------------------------------------------------
    // close()
    // -----------------------------------------------------------------

    describe('close()', function () {
        it('closes the pool', async function () {
            let db = new Database('h', 3306, 'db', 'u', 'p');
            await db.close();
            expect(mockPool.end.calledOnce).to.be.true;
        });
    });
}

describe('Database', function () {
    registerDatabaseHooks();
    registerMigratePriceFencePrimaryKeyTests();
    registerCloseTests();
});
