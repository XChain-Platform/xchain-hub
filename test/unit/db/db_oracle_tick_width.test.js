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
// deployed hub widens tick only after its mirrors have. Two arms:
//   DEFINITION - the column widths in src/sql/oracle_prices.sql cover the gate bounds.
//   MIGRATION  - the dated widen is manual, so no boot runs it before the operator has
//                widened the mirrors; it stays pending on a narrower live column.

const fs         = require('fs');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');
const files = require('../../../src/db/schema/sql_migration_files.js');
const { planEndState, schemaModel, unmetEndState } = require('../../../src/db/schema/migration_end_state.js');

const { MAX_TICK_LENGTH, MAX_MEMO_LENGTH, MAX_SOURCE_ADDRESS_LENGTH } = require('../../../src/constants.js');

const DEF_PATH = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'oracle_prices.sql');
const MIGRATIONS = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations');
const WIDEN_FILE = '2026-10-19-oracle-prices-widen-tick.sql';

// A Database over stubbed mariadb + fs, matching the charset migration suite.
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

function tickShortfall(liveWidth) {
    const raw = files.readMigration(MIGRATIONS, WIDEN_FILE);
    const tick = { t: 'oracle_prices', c: 'tick', dt: 'varchar', cs: 'utf8mb4', len: liveWidth };
    return unmetEndState(planEndState(files.splitMigrationStatements(raw)), schemaModel([tick], []));
}

function registerMigrationSuite() {
    describe('the dated widen (the mirrors-first order)', function () {
        it('is manual, so no boot widens the hub before its mirrors', function () {
            expect(files.migrationMode(files.readMigration(MIGRATIONS, WIDEN_FILE))).to.equal('manual');
        });
        it('restates the definition spec', function () {
            expect(files.splitMigrationStatements(files.readMigration(MIGRATIONS, WIDEN_FILE)))
                .to.deep.equal(['ALTER TABLE `oracle_prices` MODIFY `tick` ' + declaredSpec('tick')]);
        });
        it('stays pending on a narrower live column and is baselined at or above the target', function () {
            expect(tickShortfall(50)).to.have.lengthOf(1);
            expect(tickShortfall(declaredWidth('tick'))).to.deep.equal([]);
            expect(tickShortfall(255)).to.deep.equal([]);
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
    registerMigrationSuite();
});
