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

// MAX(batch_seq) over price_snapshots must be index-served: the anchor flush reads it
// every cycle, and a full scan of the wide table exceeds the statement limit.

const fs         = require('fs');
const path       = require('path');
const { expect } = require('chai');

const SQL = path.join(__dirname, '../../../../src/sql');
const strip = (s) => s.replace(/--[^\n]*/g, '');

describe('price_snapshots batch_seq index', function () {
    it('has an auto-applied migration adding an idempotent index on batch_seq alone', function () {
        const file = path.join(SQL, 'migrations/2026-10-28-price-snapshots-batch-seq-index.sql');
        expect(fs.existsSync(file), 'migration file exists').to.equal(true);
        const raw = fs.readFileSync(file, 'utf8');
        expect(raw).to.not.match(/xchain:migration\s+mode=manual/);
        expect(strip(raw)).to.match(/ALTER TABLE\s+`?price_snapshots`?\s+ADD INDEX IF NOT EXISTS\s+`?\w+`?\s*\(\s*`?batch_seq`?\s*\)/i);
    });

    it('declares a key leading on batch_seq in the table definition', function () {
        const ddl = strip(fs.readFileSync(path.join(SQL, 'price_snapshots.sql'), 'utf8'));
        expect(ddl).to.match(/KEY\s+\w+\s*\(\s*`?batch_seq`?\s*(,[^)]*)?\)/i);
    });
});
