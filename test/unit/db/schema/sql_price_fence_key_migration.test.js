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

// The price ingest fence re-key an aged hub applies by hand. DROP and ADD ride one
// ALTER, so the table is never without a primary key, and the new key is the one
// src/sql declares, so a fresh hub baselines the file.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { declaredIndex } = require('../../../helpers/fresh_schema_model.js');
const { planEndState, schemaModel, unmetEndState } = require('../../../../src/db/schema/migration_end_state.js');
const files = require('../../../../src/db/schema/sql_migration_files.js');

const MIGRATIONS = path.resolve(__dirname, '../../../../src/sql/migrations');
const FILE = '2026-10-19-price-ingest-watermarks-network-key.sql';
const raw = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8');

describe('price ingest fence re-key SQL migration', function () {
    it('is manual and re-keys in one statement', function () {
        expect(files.migrationMode(raw)).to.equal('manual');
        expect(files.splitMigrationStatements(raw)).to.deep.equal([
            'ALTER TABLE `price_ingest_watermarks` DROP PRIMARY KEY, ADD PRIMARY KEY (network, source_chain)'
        ]);
    });

    it('ends on the primary key src/sql declares', function () {
        expect(declaredIndex('price_ingest_watermarks', 'PRIMARY')).to.deep.equal({ columns: ['network', 'source_chain'], unique: true });
    });

    it('stays pending on a chain-keyed fence and is baselined on a network-keyed one', function () {
        const plan = planEndState(files.splitMigrationStatements(raw));
        const key = (cols) => schemaModel([], cols.map(c => ({ t: 'price_ingest_watermarks', i: 'PRIMARY', c, nu: 0 })));
        expect(unmetEndState(plan, key(['source_chain']))).to.have.lengthOf(1);
        expect(unmetEndState(plan, key(['network', 'source_chain']))).to.deep.equal([]);
    });
});
