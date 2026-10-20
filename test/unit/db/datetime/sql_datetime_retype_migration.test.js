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

// The dated retype is the only record of which columns an aged hub converts, so it
// must restate each one exactly as src/sql declares it, and src/sql must hold no
// TIMESTAMP column the list could have missed.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { declaredColumnDefinition, declaredIndex } = require('../../../helpers/fresh_schema_model.js');

const migrationPath = path.resolve(__dirname, '../../../../src/sql/migrations/2026-10-19-timestamp-columns-to-datetime.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');
const lines = sql.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('--'));
const SQL_DIR = path.resolve(__dirname, '../../../../src/sql');

function parseAlterStatements() {
    return lines.map((line) => {
        const match = line.match(/^ALTER TABLE `([^`]+)` MODIFY `([^`]+)` (.+);$/);
        expect(match, line).not.to.equal(null);
        return { table: match[1], column: match[2], columnDef: match[3] };
    });
}

describe('manual datetime retype migration', function () {
    it('is tagged for manual application', function () {
        expect(sql).to.include('-- xchain:migration mode=manual');
    });

    it('restates 48 columns, each as DATETIME exactly as its src/sql file declares it', function () {
        const statements = parseAlterStatements();
        expect(statements).to.have.lengthOf(48);
        for (const s of statements) {
            expect(s.columnDef, s.table + '.' + s.column).to.match(/^DATETIME\b/);
            expect(s.columnDef, s.table + '.' + s.column).to.equal(declaredColumnDefinition(s.table, s.column));
        }
    });

    it('leaves no TIMESTAMP column in src/sql, so a fresh install has nothing to retype', function () {
        for (const file of fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql'))) {
            const body = fs.readFileSync(path.join(SQL_DIR, file), 'utf8').replace(/--[^\n]*/g, '');
            expect(body, file).not.to.match(/^\s*`?\w+`?\s+TIMESTAMP\b/im);
        }
    });

    it('names each column once', function () {
        const named = parseAlterStatements().map(s => s.table + '.' + s.column);
        expect(new Set(named).size).to.equal(named.length);
    });
});
