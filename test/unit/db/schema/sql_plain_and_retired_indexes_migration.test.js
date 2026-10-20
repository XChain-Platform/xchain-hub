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

// Plain indexes an aged hub adds and the two it retires: each added index is the
// one src/sql declares, and neither retired index is declared there any more.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { declaredColumnDefinition, declaredIndex } = require('../../../helpers/fresh_schema_model.js');

const migrationPath = path.resolve(__dirname, '../../../../src/sql/migrations/2026-10-19-plain-and-retired-indexes.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');
const lines = sql.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('--'));
const { keyColumns } = require('../../../../src/db/schema/migration_end_state.js');

function parseAlterStatements() {
    return lines.map(line => {
        const add = line.match(/^ALTER TABLE `([^`]+)` ADD INDEX IF NOT EXISTS `([^`]+)` (\(.+\));$/);
        if(add) return { kind: 'add', table: add[1], name: add[2], columns: keyColumns(add[3].slice(1, -1)) };
        const drop = line.match(/^ALTER TABLE `([^`]+)` DROP INDEX IF EXISTS `([^`]+)`;$/);
        expect(drop, 'valid plain-index ALTER: ' + line).not.to.equal(null);
        return { kind: 'drop', table: drop[1], name: drop[2] };
    });
}

describe('plain and retired indexes SQL migration', function () {
    it('is manual and holds five added and two retired indexes', function () {
        const statements = parseAlterStatements();
        expect(sql).to.include('-- xchain:migration mode=manual');
        expect(statements.map(s => s.kind + ' ' + s.table + '.' + s.name)).to.deep.equal([
            'add validator_rewards.idx_batch_seq',
            'add state_checkpoints.sc_chain_blk',
            'drop state_checkpoints.chain_block_seq',
            'drop state_checkpoints.checkpoint_seq',
            'add price_snapshots.idx_status_block_round',
            'add price_snapshots.idx_status_timestamp_round',
            'add price_snapshots.idx_status_created'
        ]);
    });

    it('adds each index as src/sql declares it and retires only indexes src/sql no longer declares', function () {
        for (const s of parseAlterStatements()) {
            const declared = declaredIndex(s.table, s.name);
            if (s.kind === 'drop') { expect(declared, s.name).to.equal(null); continue; }
            expect(declared, s.name).to.deep.equal({ columns: s.columns, unique: false });
        }
    });
});
