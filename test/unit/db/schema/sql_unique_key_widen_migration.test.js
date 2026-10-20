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

// Each widen builds the wide key under a temporary name before it drops the
// original, so the table always holds one of the two; the wide key is the one
// src/sql declares, and the archive backfill runs before the reward key widens.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { declaredColumnDefinition, declaredIndex } = require('../../../helpers/fresh_schema_model.js');

const migrationPath = path.resolve(__dirname, '../../../../src/sql/migrations/2026-10-19-widen-unique-keys.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');
const lines = sql.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('--'));
const { keyColumns } = require('../../../../src/db/schema/migration_end_state.js');
const { ARCHIVE_REWARD_TYPE } = require('../../../../src/anchor/anchor_reward_key.js');

function parseStatements() {
    return lines.map(line => {
        const update = line.match(/^UPDATE validator_rewards SET round_qualifier = block_index WHERE reward_type = '([^']+)' AND round_qualifier = 0 AND block_index IS NOT NULL AND block_index > 0;$/);
        if(update) return { kind: 'backfill', rewardType: update[1] };
        const add = line.match(/^ALTER TABLE `([^`]+)` ADD UNIQUE KEY IF NOT EXISTS `([^`]+)` (\(.+\));$/);
        if(add) return { kind: 'add', table: add[1], name: add[2], columns: keyColumns(add[3].slice(1, -1)) };
        const drop = line.match(/^ALTER TABLE `([^`]+)` DROP INDEX IF EXISTS `([^`]+)`;$/);
        expect(drop, 'valid unique-key widen statement: ' + line).not.to.equal(null);
        return { kind: 'drop', table: drop[1], name: drop[2] };
    });
}

describe('unique-key widen SQL migration', function () {
    it('is manual and backfills archive rewards before any widen', function () {
        const statements = parseStatements();
        expect(sql).to.include('-- xchain:migration mode=manual');
        expect(statements).to.have.length(13);
        expect(statements[0]).to.deep.equal({ kind: 'backfill', rewardType: ARCHIVE_REWARD_TYPE });
    });

    it('widens each key add-then-drop through a temporary key, ending on the key src/sql declares', function () {
        const widens = parseStatements().slice(1);
        expect(widens.map(s => s.name).filter((n, i) => i % 4 === 1)).to.deep.equal(['uq_reward', 'uq_cap_snap', 'uq_attest_response']);
        for (let i = 0; i < widens.length; i += 4) {
            const [tempAdd, drop, add, tempDrop] = widens.slice(i, i + 4);
            expect([tempAdd.kind, drop.kind, add.kind, tempDrop.kind]).to.deep.equal(['add', 'drop', 'add', 'drop']);
            expect(tempAdd.name).to.equal(add.name + '_widening');
            expect(tempDrop.name).to.equal(tempAdd.name);
            expect(drop.name).to.equal(add.name);
            expect(tempAdd.columns).to.deep.equal(add.columns);
            expect(declaredIndex(add.table, add.name), add.name).to.deep.equal({ columns: add.columns, unique: true });
        }
    });
});
