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

// The admission and archive bookkeeping columns an aged hub adds by hand; a fresh
// hub has them from src/sql, so each must be declared there with the same definition.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { declaredColumnDefinition, declaredIndex } = require('../../../helpers/fresh_schema_model.js');

const migrationPath = path.resolve(__dirname, '../../../../src/sql/migrations/2026-10-19-nullable-mirror-columns.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');
const lines = sql.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('--'));

const sameDefinition = (a, b) => String(a).replace(/ DEFAULT NULL$/, '') === String(b).replace(/ DEFAULT NULL$/, '');

function parseAlterStatements() {
    return lines.map(line => {
        const match = line.match(/^ALTER TABLE `([^`]+)` ADD COLUMN IF NOT EXISTS `([^`]+)` (.+);$/);
        expect(match, 'valid nullable-column ALTER: ' + line).not.to.equal(null);
        return { table: match[1], column: match[2], columnDef: match[3] };
    });
}

describe('nullable mirror columns SQL migration', function () {
    it('is tagged manual and adds 38 columns, each declared the same way in src/sql', function () {
        const statements = parseAlterStatements();
        expect(sql).to.include('-- xchain:migration mode=manual');
        expect(statements).to.have.length(38);
        for (const s of statements) {
            expect(s.columnDef, s.table + '.' + s.column).not.to.match(/\bNOT NULL\b/);
            expect(sameDefinition(s.columnDef, declaredColumnDefinition(s.table, s.column)), s.table + '.' + s.column).to.equal(true);
        }
    });

    it('adds the per-chain admission heights before the archive bookkeeping columns', function () {
        const columns = parseAlterStatements().map(s => s.column);
        expect(columns.slice(0, 28).every(c => /^admit_block|^sent_doge_height$|^name$|^description$|^meta_hash$/.test(c))).to.equal(true);
        expect(columns.slice(28)).to.include.members(['batch_seq', 'archived_status', 'anchor_txid', 'archived_proof_sha']);
    });
});
