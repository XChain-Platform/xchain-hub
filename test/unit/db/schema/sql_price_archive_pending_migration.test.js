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

// The archive_pending generated column and its (archive_pending, round_number) key on
// price_snapshots: declared in src/sql for a fresh hub, added by a dated manual migration
// an aged hub applies, and read by the archive's pending-round page reads through
// FORCE INDEX. A fresh hub without either fails every pending-round read.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { declaredIndex, declaredColumnDefinition, freshSchemaRows } = require('../../../helpers/fresh_schema_model.js');
const { isRunbook, splitMigrationStatements } = require('../../../../src/db/schema/sql_migration_files.js');
const { planEndState, schemaModel, unmetEndState } = require('../../../../src/db/schema/migration_end_state.js');

const SRC = path.resolve(__dirname, '../../../../src');
const FILE = '2026-11-27-price-snapshots-archive-anchor-stamp.sql';
const RUNBOOK = '2026-10-24-z-price-snapshots-archive-pending-index.sql';
const raw = fs.readFileSync(path.join(SRC, 'sql', 'migrations', FILE), 'utf8');
const statements = splitMigrationStatements(raw);

const squash = (text) => text.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();

function stampPredicate() {
    const src = fs.readFileSync(path.join(SRC, 'db', 'prices', 'archive_bookkeeping.js'), 'utf8');
    const body = src.match(/const PENDING_PRICE_STAMP_PREDICATE =([\s\S]*?);\n/)[1];
    const literal = (body.match(/'((?:[^'\\]|\\.)*)'/g) || []).map(s => s.slice(1, -1)).join('');
    return squash(literal.replace(/^\(/, '').replace(/\)$/, ''));
}

function generatedExpression(text) {
    const m = text.match(/GENERATED ALWAYS AS \(([\s\S]*)\) STORED/);
    return squash(m[1]);
}

describe('price_snapshots archive_pending column SQL migration', function () {
    it('is a manual migration with no runbook tag, so a boot reports it', function () {
        expect(raw).to.include('-- xchain:migration mode=manual');
        expect(isRunbook(raw)).to.equal(false);
        expect(isRunbook(fs.readFileSync(path.join(SRC, 'sql', 'migrations', RUNBOOK), 'utf8'))).to.equal(true);
    });

    it('declares the key as src/sql does', function () {
        expect(declaredIndex('price_snapshots', 'idx_archive_pending_round'))
            .to.deep.equal({ columns: ['archive_pending', 'round_number'], unique: false });
        expect(statements).to.have.length(3);
        expect(statements[2]).to.include('`idx_archive_pending_round` (`archive_pending`, `round_number`)');
    });

    it('keeps the base schema, the migration and the stamp predicate on one expression', function () {
        const declared = declaredColumnDefinition('price_snapshots', 'archive_pending');
        expect(declared).to.match(/^TINYINT\(1\) GENERATED ALWAYS AS /);
        const fromSchema = generatedExpression(declared);
        expect(fromSchema.length).to.be.greaterThan(40);
        expect(generatedExpression(statements[2])).to.equal(fromSchema);
        expect(stampPredicate()).to.equal(fromSchema);
    });

    it('is baselined on a fresh hub and pending on a hub without the column or the key', function () {
        const plan = planEndState(statements);
        const fresh = freshSchemaRows();
        expect(unmetEndState(plan, schemaModel(fresh.columns, fresh.indexes))).to.deep.equal([]);

        const noColumn = fresh.columns.filter(r => !(r.t === 'price_snapshots' &&
            ['archived_reference_block', 'archived_source_action_index', 'archive_pending'].includes(r.c)));
        const noKey = fresh.indexes.filter(r => !(r.t === 'price_snapshots' && r.i === 'idx_archive_pending_round'));
        expect(unmetEndState(plan, schemaModel(noColumn, noKey))).to.deep.equal([
            'price_snapshots.archived_reference_block is absent',
            'price_snapshots.archived_source_action_index is absent',
            'price_snapshots.archive_pending is absent',
            'price_snapshots index idx_archive_pending_round is absent'
        ]);
        const oldColumns = fresh.columns.filter(r => !(r.t === 'price_snapshots' &&
            ['archived_reference_block', 'archived_source_action_index'].includes(r.c)));
        expect(unmetEndState(plan, schemaModel(oldColumns, fresh.indexes))).to.deep.equal([
            'price_snapshots.archived_reference_block is absent',
            'price_snapshots.archived_source_action_index is absent'
        ]);
        expect(unmetEndState(plan, schemaModel(fresh.columns, noKey)))
            .to.deep.equal(['price_snapshots index idx_archive_pending_round is absent']);
    });

    it('lists the column once in the fresh schema model, ahead of the key that reads it', function () {
        const cols = freshSchemaRows().columns.filter(r => r.t === 'price_snapshots').map(r => r.c);
        expect(cols.filter(c => c === 'archive_pending')).to.have.length(1);
        for (const dep of ['batch_seq', 'archived_status', 'archived_batch_block_time', 'archived_proof_sha',
            'archived_reference_block', 'archived_source_action_index', 'reference_block', 'source_action_index',
            'status', 'batch_block_time', 'consensus_proof']) {
            expect(cols.indexOf(dep), dep).to.be.within(0, cols.indexOf('archive_pending') - 1);
        }
    });
});
