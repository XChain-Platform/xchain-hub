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

const fs          = require('fs');
const path        = require('path');
const sinon       = require('sinon');
const { expect }  = require('chai');

const { DATETIME_COLUMNS }    = require('../../../src/db/schema/datetime_columns.js');
const migrationSteps          = require('../../../src/db/schema/migrations.js');
const Database                = require('../../../src/db');

const SQL_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql');

// Strips a src/sql `--` line comment so a trailing note never reads as DDL.
function stripSqlComments(src) {
    return src.split('\n').map(line => line.replace(/--.*$/, '')).join('\n');
}

// Every TIMESTAMP-typed column src/sql/*.sql still declares, as { table, column }.
// Anchored at line-start (after trim) so a KEY/index line naming a `_timestamp`
// column, or a BIGINT column named `*_timestamp`, can never match.
function timestampColumnsInSql() {
    const found = [];
    for (const file of fs.readdirSync(SQL_DIR)) {
        if (!file.endsWith('.sql')) continue;
        const table = file.slice(0, -'.sql'.length);
        const body  = stripSqlComments(fs.readFileSync(path.join(SQL_DIR, file), 'utf8'));
        for (const line of body.split('\n')) {
            const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s+TIMESTAMP\b/);
            if (m) found.push({ table, column: m[1] });
        }
    }
    return found;
}

describe('DATETIME_COLUMNS', function () {
    it('every entry converts to DATETIME with no TIMESTAMP type token left', function () {
        for (const entry of DATETIME_COLUMNS) {
            expect(entry.columnDef, entry.table + '.' + entry.column).to.match(/^DATETIME\b/);
            expect(entry.columnDef, entry.table + '.' + entry.column).to.not.match(/\bTIMESTAMP\b/);
        }
    });

    it('every entry names a column actually declared in its src/sql file', function () {
        for (const entry of DATETIME_COLUMNS) {
            const src = stripSqlComments(fs.readFileSync(path.join(SQL_DIR, entry.table + '.sql'), 'utf8'));
            const re  = new RegExp('^\\s*' + entry.column + '\\s+(TIMESTAMP|DATETIME)\\b', 'm');
            expect(src, entry.table + '.' + entry.column + ' not found in src/sql').to.match(re);
        }
    });

    it('carries every TIMESTAMP column src/sql/*.sql still declares', function () {
        const missing = timestampColumnsInSql().filter(sqlCol =>
            !DATETIME_COLUMNS.some(e => e.table === sqlCol.table && e.column === sqlCol.column));
        expect(missing, 'columns left off DATETIME_COLUMNS: ' + JSON.stringify(missing)).to.have.lengthOf(0);
    });

    it('has exactly 48 entries', function () {
        expect(DATETIME_COLUMNS.length).to.equal(48);
    });
});

describe('runDatetimeColumnMigrations()', function () {
    it('converts every entry exactly once, to datetime', async function () {
        const migrateColumnType = sinon.stub().resolves();
        const fakeDb = { migrateColumnType };
        await migrationSteps.runDatetimeColumnMigrations.call(fakeDb);

        expect(migrateColumnType.callCount).to.equal(DATETIME_COLUMNS.length);
        for (const entry of DATETIME_COLUMNS) {
            const call = migrateColumnType.getCalls().find(c =>
                c.args[0] === entry.table && c.args[1] === entry.column);
            expect(call, entry.table + '.' + entry.column + ' not migrated').to.exist;
            expect(call.args[2]).to.equal('datetime');
            expect(call.args[3]).to.equal(entry.columnDef);
        }
    });
});

describe('Database.prototype.runMigrations()', function () {
    it('runs all four migration steps in order', async function () {
        const calls = [];
        const fakeDb = {
            runRewardKeyMigrations:              sinon.stub().callsFake(async () => calls.push('reward')),
            runCapabilityAndCheckpointMigrations: sinon.stub().callsFake(async () => calls.push('capability')),
            runColumnAndFenceMigrations:          sinon.stub().callsFake(async () => calls.push('column')),
            runDatetimeColumnMigrations:          sinon.stub().callsFake(async () => calls.push('datetime'))
        };
        await Database.prototype.runMigrations.call(fakeDb);

        expect(calls).to.deep.equal(['reward', 'capability', 'column', 'datetime']);
    });
});
