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

// The capability ENUM, the two voting-window columns and the two provider-byte
// columns an aged hub restates; each restatement is the src/sql declaration.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { declaredColumnDefinition, declaredIndex } = require('../../../helpers/fresh_schema_model.js');

const migrationPath = path.resolve(__dirname, '../../../../src/sql/migrations/2026-10-19-enum-charset-and-voting-window-widens.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');
const lines = sql.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('--'));

function parseAlterStatements() {
    return lines.map(line => {
        const match = line.match(/^ALTER TABLE `([^`]+)` MODIFY `([^`]+)` (.+);$/);
        expect(match, 'valid column MODIFY: ' + line).not.to.equal(null);
        return { table: match[1], column: match[2], columnDef: match[3] };
    });
}

describe('enum, charset and voting window SQL migration', function () {
    it('is manual and restates five columns exactly as src/sql declares them', function () {
        const statements = parseAlterStatements();
        expect(sql).to.include('-- xchain:migration mode=manual');
        expect(statements.map(s => s.table + '.' + s.column)).to.deep.equal([
            'validator_capabilities.capability',
            'governance_proposals.voting_start',
            'governance_proposals.voting_end',
            'attestation_responses.response_payload',
            'attestation_responses.meta'
        ]);
        for (const s of statements)
            expect(s.columnDef, s.table + '.' + s.column).to.equal(declaredColumnDefinition(s.table, s.column));
    });

    it('widens the provider-byte columns to utf8mb4 and the voting window to DATETIME', function () {
        const byColumn = new Map(parseAlterStatements().map(s => [s.column, s.columnDef]));
        expect(byColumn.get('response_payload')).to.match(/CHARACTER SET utf8mb4/);
        expect(byColumn.get('meta')).to.match(/CHARACTER SET utf8mb4/);
        expect(byColumn.get('voting_start')).to.match(/^DATETIME\b/);
        expect(byColumn.get('voting_end')).to.match(/^DATETIME\b/);
        expect(byColumn.get('capability')).to.include("'full_node'");
    });
});
