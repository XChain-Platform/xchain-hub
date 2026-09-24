'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// oracle_prices must store every field the PRICE v1 ingest gate admits, and a
// deployed hub widens tick only after its mirrors have. Three arms:
//   DEFINITION - the column widths in src/sql/oracle_prices.sql cover the gate bounds.
//   GATE       - without XCHAIN_HUB_ORACLE_TICK_MIRRORS_WIDENED=1 the widen never runs.
//   HELPER     - migrateColumnLength widens a narrower live column and nothing else.

const fs         = require('fs');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const { MAX_TICK_LENGTH, MAX_MEMO_LENGTH, MAX_SOURCE_ADDRESS_LENGTH } = require('../../../src/constants.js');

const DEF_PATH = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'oracle_prices.sql');
const FLAG = 'XCHAIN_HUB_ORACLE_TICK_MIRRORS_WIDENED';

// A Database over stubbed mariadb + fs, matching the charset migration suite.
function makeDb() {
    const mockConn = { query: sinon.stub().resolves([]), release: sinon.stub().resolves(), end: sinon.stub().resolves() };
    const mockPool = { getConnection: sinon.stub().resolves(mockConn), end: sinon.stub().resolves() };
    const Database = proxyquire('../../../src/db', {
        mariadb: { createPool: sinon.stub().returns(mockPool), createConnection: sinon.stub().resolves(mockConn) },
        fs:      { readdirSync: sinon.stub().returns([]), readFileSync: sinon.stub().returns('') },
        path:    require('path')
    });
    return { db: new Database('localhost', 3306, 'test_db', 'user', 'pass'), mockConn };
}

// The declared spec of one column ("VARCHAR(250) NOT NULL"), comment and comma stripped.
function declaredSpec(column) {
    const line = fs.readFileSync(DEF_PATH, 'utf8').split('\n').find(l => new RegExp('^\\s*' + column + '\\s').test(l));
    expect(line, 'oracle_prices.' + column + ' is no longer declared').to.exist;
    return line.replace(/--.*$/, '').replace(/,\s*$/, '').trim().replace(new RegExp('^' + column + '\\s+'), '').replace(/\s+/g, ' ');
}

function declaredWidth(column) {
    return Number(/VARCHAR\((\d+)\)/i.exec(declaredSpec(column))[1]);
}

function registerDefinitionSuite() {
    describe('the definition (what a fresh hub gets from verifyTables)', function () {
        it('tick holds every tick the ingest gate admits', function () {
            expect(declaredWidth('tick')).to.be.at.least(MAX_TICK_LENGTH);
        });
        it('source_address and memo hold their gate bounds too', function () {
            expect(declaredWidth('source_address')).to.be.at.least(MAX_SOURCE_ADDRESS_LENGTH);
            expect(declaredWidth('memo')).to.be.at.least(MAX_MEMO_LENGTH);
        });
    });
}

function registerGateSuite() {
    describe('migrateOracleTickWidth (the mirrors-first gate)', function () {
        afterEach(() => { delete process.env[FLAG]; });

        it('skips and warns while the operator has not attested the mirrors', async function () {
            const { db, mockConn } = makeDb();
            const widen = sinon.spy(db, 'migrateColumnLength');
            expect(await db.migrateOracleTickWidth()).to.equal(false);
            expect(widen.called).to.equal(false);
            expect(mockConn.query.called).to.equal(false);
            expect(console.warn.calledWithMatch(new RegExp(FLAG))).to.equal(true);
        });

        it('does not treat any value but 1 as the attestation', async function () {
            process.env[FLAG] = 'true';
            const { db } = makeDb();
            const widen = sinon.stub(db, 'migrateColumnLength').resolves(true);
            await db.migrateOracleTickWidth();
            expect(widen.called).to.equal(false);
        });

        it('widens to the definition spec once the flag is 1', async function () {
            process.env[FLAG] = '1';
            const { db } = makeDb();
            const widen = sinon.stub(db, 'migrateColumnLength').resolves(true);
            await db.migrateOracleTickWidth();
            expect(widen.calledOnce).to.equal(true);
            expect(widen.firstCall.args).to.deep.equal(['oracle_prices', 'tick', declaredWidth('tick'), declaredSpec('tick')]);
        });

        it('runMigrations reaches the gate on every boot', async function () {
            const { db } = makeDb();
            for (const m of ['migrateUniqueKey', 'migrateIndex', 'migrateEnumColumn', 'migrateColumnType', 'migrateColumnCharset'])
                sinon.stub(db, m).resolves();
            const gate = sinon.stub(db, 'migrateOracleTickWidth').resolves(false);
            await db.runMigrations();
            expect(gate.calledOnce).to.equal(true);
        });
    });
}

function registerHelperSuite() {
    describe('migrateColumnLength', function () {
        it('issues the MODIFY when the live column is narrower', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.onCall(0).resolves([{ len: 50 }]).onCall(1).resolves([]);
            expect(await db.migrateColumnLength('oracle_prices', 'tick', 250, 'VARCHAR(250) NOT NULL')).to.equal(true);
            expect(mockConn.query.getCall(1).args[0]).to.equal('ALTER TABLE `oracle_prices` MODIFY `tick` VARCHAR(250) NOT NULL');
            expect(mockConn.release.called).to.equal(true);
        });

        it('no-ops at or above the target, when absent, and on an unreadable length', async function () {
            for (const answer of [[{ len: 250 }], [{ len: 300 }], [], [{ len: null }]]) {
                const { db, mockConn } = makeDb();
                mockConn.query.onCall(0).resolves(answer);
                expect(await db.migrateColumnLength('oracle_prices', 'tick', 250, 'VARCHAR(250) NOT NULL')).to.equal(false);
                expect(mockConn.query.callCount, JSON.stringify(answer)).to.equal(1);
            }
        });

        it('logs the hand-run statement and releases rather than taking the boot down', async function () {
            const { db, mockConn } = makeDb();
            mockConn.query.onCall(0).resolves([{ len: 50 }]).onCall(1).rejects(new Error('errno 1071'));
            expect(await db.migrateColumnLength('oracle_prices', 'tick', 250, 'VARCHAR(250) NOT NULL')).to.equal(false);
            expect(console.error.calledWithMatch(/MIGRATION FAILED: oracle_prices\.tick/)).to.equal(true);
            expect(console.error.calledWithMatch(/ALTER TABLE `oracle_prices` MODIFY `tick` VARCHAR\(250\) NOT NULL/)).to.equal(true);
            expect(mockConn.release.called).to.equal(true);
        });
    });
}

describe('oracle_prices stores every PRICE v1 field the ingest gate admits', function () {
    beforeEach(function () {
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });
    afterEach(() => sinon.restore());

    registerDefinitionSuite();
    registerGateSuite();
    registerHelperSuite();
});
