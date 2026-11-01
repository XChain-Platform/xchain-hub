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

// The batch_seq index on price_snapshots: the dated migration an aged hub applies and the
// key src/sql declares for a fresh hub. getNextAnchorBatchSeq takes MAX(batch_seq) over
// every archive table on each anchor flush; an unindexed table makes that a full scan of
// the wide table, which exceeds the statement limit and fails the flush every cycle.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { declaredIndex, freshSchemaRows } = require('../../../helpers/fresh_schema_model.js');
const { planEndState, schemaModel, unmetEndState } = require('../../../../src/db/schema/migration_end_state.js');

const FILE = '2026-10-28-price-snapshots-batch-seq-index.sql';
const NAME = 'idx_batch_seq';
const sql = fs.readFileSync(path.resolve(__dirname, '../../../../src/sql/migrations', FILE), 'utf8');
const lines = sql.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('--'));

describe('price_snapshots batch_seq index SQL migration', function () {
    it('declares a batch_seq-led index in the fresh schema', function () {
        const idx = freshSchemaRows().indexes.filter(r => r.t === 'price_snapshots' && r.c.toLowerCase() === 'batch_seq');
        expect(idx.length, 'price_snapshots index on batch_seq').to.be.greaterThan(0);
        expect(declaredIndex('price_snapshots', NAME)).to.deep.equal({ columns: ['batch_seq'], unique: false });
    });

    it('adds the index idempotently with ADD INDEX IF NOT EXISTS', function () {
        expect(lines.join(' ')).to.match(/^ALTER TABLE `price_snapshots` ADD INDEX IF NOT EXISTS `idx_batch_seq` \(`batch_seq`\);$/);
    });

    it('is baselined on a fresh hub and pending on a hub without the index', function () {
        const plan = planEndState([lines.join(' ').replace(/;$/, '')]);
        const fresh = freshSchemaRows();
        expect(unmetEndState(plan, schemaModel(fresh.columns, fresh.indexes))).to.deep.equal([]);
        const aged = fresh.indexes.filter(r => !(r.t === 'price_snapshots' && r.i === NAME));
        expect(unmetEndState(plan, schemaModel(fresh.columns, aged)))
            .to.deep.equal(['price_snapshots index ' + NAME + ' is absent']);
    });
});
