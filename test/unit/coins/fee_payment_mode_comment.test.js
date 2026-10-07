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

// The FEE_PAYMENT_MODE lines in the coin files must not call the field
// informational or unread: the indexer persists and classifies against it
// through the registry, and a stale comment invites its removal.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT  = path.join(__dirname, '..', '..', '..');
const FILES = [
    'src/coins/BTC.js',
    'src/coins/LTC.js',
    'src/coins/DOGE.js',
    'test/unit/coins/coins_consensus_subset.test.js',
];

describe('FEE_PAYMENT_MODE comments', () => {
    for(const rel of FILES){
        it(`${rel} does not call FEE_PAYMENT_MODE informational or unread`, () => {
            const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8')
                .split('\n').filter(l => l.includes("'FEE_PAYMENT_MODE'") || /FEE_PAYMENT_MODE:/.test(l));
            assert.ok(lines.length > 0, `no FEE_PAYMENT_MODE line in ${rel}`);
            for(const l of lines){
                assert.ok(!/informational|not read at runtime/i.test(l), `stale comment: ${l.trim()}`);
            }
        });
    }
});
