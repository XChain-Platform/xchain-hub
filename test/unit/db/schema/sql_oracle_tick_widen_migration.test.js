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

// The tick widen waits on the mirrors, so it is manual and says why; its restated
// column is the one src/sql declares, so a fresh hub sees no change.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { declaredColumnDefinition, declaredIndex } = require('../../../helpers/fresh_schema_model.js');

const migrationPath = path.resolve(__dirname, '../../../../src/sql/migrations/2026-10-19-oracle-prices-widen-tick.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');
const lines = sql.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('--'));

describe('oracle tick width SQL migration', function () {
    it('is manual, names the mirrors-first order, and restates the canonical tick definition', function () {
        expect(sql).to.include('-- xchain:migration mode=manual');
        expect(sql).to.include('2026-09-22-oracle-prices-widen-tick.sql');
        expect(sql).to.match(/only once every mirror is widened/);
        expect(lines).to.have.length(1);
        const match = lines[0].match(/^ALTER TABLE `oracle_prices` MODIFY `tick` (.+);$/);
        expect(match, lines[0]).not.to.equal(null);
        expect(match[1]).to.equal('VARCHAR(250) NOT NULL');
        expect(match[1]).to.equal(declaredColumnDefinition('oracle_prices', 'tick'));
    });
});
