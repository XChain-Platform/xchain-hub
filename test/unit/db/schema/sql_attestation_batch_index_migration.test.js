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

// The per-batch response index an aged hub adds: the one src/sql declares, so a fresh
// hub and a migrated hub serve the explorer's batch lookup from the same index.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { declaredIndex } = require('../../../helpers/fresh_schema_model.js');
const { keyColumns } = require('../../../../src/db/schema/migration_end_state.js');

const migrationPath = path.resolve(__dirname,
    '../../../../src/sql/migrations/2026-10-20-attestation-responses-batch-action-index.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');
const lines = sql.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('--'));
const ADD = /^ALTER TABLE `([^`]+)` ADD INDEX IF NOT EXISTS `([^`]+)` \((.+)\);$/;

describe('attestation response batch index SQL migration', function () {
    it('is manual and adds only the batch_action_index lookup', function () {
        expect(sql).to.include('-- xchain:migration mode=manual');
        expect(lines).to.have.length(1);
        const add = lines[0].match(ADD);
        expect(add, 'valid plain-index ALTER: ' + lines[0]).not.to.equal(null);
        expect([add[1], add[2]]).to.deep.equal(['attestation_responses', 'idx_batch_action']);
    });

    it('adds the index exactly as src/sql declares it', function () {
        const add = lines[0].match(ADD);
        expect(declaredIndex(add[1], add[2])).to.deep.equal({ columns: keyColumns(add[3]), unique: false });
        expect(keyColumns(add[3])).to.deep.equal(['network', 'batch_action_index']);
    });
});
