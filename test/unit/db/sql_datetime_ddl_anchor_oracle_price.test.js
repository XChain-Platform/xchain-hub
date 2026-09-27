'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const fs         = require('fs');
const path       = require('path');
const { expect } = require('chai');

const SQL_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql');
const EXPECTED_COLUMNS = {
    'anchor_published_archives.sql': ['intent_at', 'sent_at', 'settled_at'],
    'anchor_published_checkpoints.sql': ['intent_at', 'sent_at'],
    'anchor_reward_attestations.sql': ['created_at'],
    'archive_price_tombstones.sql': ['created_at'],
    'oracle_prices.sql': ['created_at'],
    'oracle_published_rounds.sql': ['intent_at', 'sent_at'],
    'oracle_submissions.sql': ['submitted_at'],
    'price_ingest_watermarks.sql': ['updated_at'],
    'price_snapshots.sql': ['created_at']
};

function uncommentedLines(file) {
    return fs.readFileSync(path.join(SQL_DIR, file), 'utf8')
        .split('\n')
        .map(line => line.replace(/--.*$/, '').trim());
}

describe('anchor, oracle and price DDL datetime columns', function () {
    for (const [file, columns] of Object.entries(EXPECTED_COLUMNS)) {
        it(file + ' declares only the expected datetime columns', function () {
            const lines = uncommentedLines(file);
            expect(lines.some(line => /^[a-z_][a-z0-9_]*\s+TIMESTAMP\b/i.test(line))).to.equal(false);
            for (const column of columns) {
                const declaration = new RegExp('^' + column + '\\s+DATETIME\\b', 'i');
                expect(lines.some(line => declaration.test(line)), file + ':' + column).to.equal(true);
            }
        });
    }
});
