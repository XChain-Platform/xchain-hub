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

// Each unique key an aged hub adds, preceded by the dedup that keeps the lowest id
// of a duplicate set; each key is the one src/sql declares.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { declaredColumnDefinition, declaredIndex } = require('../../../helpers/fresh_schema_model.js');

const migrationPath = path.resolve(__dirname, '../../../../src/sql/migrations/2026-10-19-dedup-and-add-unique-keys.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');
const lines = sql.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('--'));
const { keyColumns } = require('../../../../src/db/schema/migration_end_state.js');

function parseStatements() {
    return lines.map(line => {
        const dedup = line.match(/^DELETE t1 FROM ([a-z_]+) t1 INNER JOIN ([a-z_]+) t2 WHERE t1\.id > t2\.id AND (.+);$/);
        if(dedup) {
            expect(dedup[2], 'same table on both sides of dedup join').to.equal(dedup[1]);
            const columns = dedup[3].split(' AND ').map(term => {
                const match = term.match(/^t1\.([a-z_]+) = t2\.([a-z_]+)$/);
                expect(match, 'valid dedup column equality: ' + term).not.to.equal(null);
                expect(match[2], 'same column on both sides of dedup join').to.equal(match[1]);
                return match[1];
            });
            return { kind: 'dedup', table: dedup[1], columns };
        }
        const unique = line.match(/^ALTER TABLE `([^`]+)` ADD UNIQUE KEY IF NOT EXISTS `([^`]+)` (\(.+\));$/);
        expect(unique, 'valid unique-key ALTER: ' + line).not.to.equal(null);
        return { kind: 'unique', table: unique[1], name: unique[2], columns: keyColumns(unique[3].slice(1, -1)) };
    });
}

describe('unique-key dedup SQL migration', function () {
    it('is manual and pairs each dedup with the key it prepares, on the same columns', function () {
        const statements = parseStatements();
        expect(sql).to.include('-- xchain:migration mode=manual');
        expect(statements).to.have.length(6);
        for (let i = 0; i < statements.length; i += 2) {
            expect(statements[i].kind).to.equal('dedup');
            expect(statements[i + 1].kind).to.equal('unique');
            expect(statements[i].table).to.equal(statements[i + 1].table);
            expect(statements[i].columns).to.deep.equal(statements[i + 1].columns);
        }
        expect(statements.filter(s => s.kind === 'unique').map(s => s.name)).to.deep.equal(['uq_submission', 'uq_reward', 'uq_chain_seq']);
    });

    it('adds each key as src/sql declares it', function () {
        for (const s of parseStatements().filter(x => x.kind === 'unique'))
            expect(declaredIndex(s.table, s.name), s.name).to.deep.equal({ columns: s.columns, unique: true });
    });
});
