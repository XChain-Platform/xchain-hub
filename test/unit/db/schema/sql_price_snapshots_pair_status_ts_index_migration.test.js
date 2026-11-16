'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -

// The (coin_pair, status, block_timestamp) index on price_snapshots: the dated migration an
// aged hub applies and the key src/sql declares for a fresh hub. The explorer's oracle
// price-history read pins pair and status and ranges over block_timestamp.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { declaredIndex, freshSchemaRows } = require('../../../helpers/fresh_schema_model.js');
const { planEndState, schemaModel, unmetEndState } = require('../../../../src/db/schema/migration_end_state.js');

const FILE = '2026-11-16-price-snapshots-pair-status-ts-index.sql';
const NAME = 'price_snapshots_pair_status_ts';
const sql = fs.readFileSync(path.resolve(__dirname, '../../../../src/sql/migrations', FILE), 'utf8');
const lines = sql.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('--'));

describe('price_snapshots pair, status, timestamp index SQL migration', function () {
    it('declares the index in the fresh schema', function () {
        expect(declaredIndex('price_snapshots', NAME))
            .to.deep.equal({ columns: ['coin_pair', 'status', 'block_timestamp', 'price'], unique: false });
    });

    it('adds the index idempotently with ADD INDEX IF NOT EXISTS', function () {
        expect(lines.join(' ')).to.match(/^ALTER TABLE `price_snapshots` ADD INDEX IF NOT EXISTS `price_snapshots_pair_status_ts` \(`coin_pair`, `status`, `block_timestamp`, `price`\);$/);
        expect(sql).to.match(/^-- xchain:migration mode=auto/);
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
