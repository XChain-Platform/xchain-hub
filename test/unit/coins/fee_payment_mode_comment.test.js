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

const ROOT = path.join(__dirname, '..', '..', '..');
const EXPECTED_COMMENTS = new Map([
    ['src/coins/BTC.js', [
        /declared mode/i,
        /indexer classifies by coin/i,
        /registry test pins the two together/i,
    ]],
    ['src/coins/LTC.js', [
        /native-only/i,
        /declared mode/i,
        /classified by coin in the indexer/i,
        /pinned by a registry test/i,
    ]],
    ['src/coins/DOGE.js', [
        /native-only/i,
        /declared mode/i,
        /classified by coin in the indexer/i,
        /pinned by a registry test/i,
    ]],
    ['test/unit/coins/coins_consensus_subset.test.js', [
        /declared mode/i,
        /not a runtime decider/i,
        /outside the subset/i,
        /divergent bundle cannot verify clean/i,
    ]],
]);

describe('FEE_PAYMENT_MODE comments', () => {
    for(const [rel, guarantees] of EXPECTED_COMMENTS){
        it(`${rel} documents the field's active classification`, () => {
            const line = fs.readFileSync(path.join(ROOT, rel), 'utf8')
                .split('\n').find(l => l.includes("'FEE_PAYMENT_MODE'") || /FEE_PAYMENT_MODE:/.test(l));
            assert.ok(line, `no FEE_PAYMENT_MODE line in ${rel}`);

            const comment = line.split('//').slice(1).join('//').trim();
            assert.ok(comment, `no FEE_PAYMENT_MODE comment in ${rel}`);
            assert.ok(!/informational|not read at runtime/i.test(comment), `stale comment: ${comment}`);
            for(const guarantee of guarantees)
                assert.match(comment, guarantee, `incomplete FEE_PAYMENT_MODE comment in ${rel}`);
        });
    }
});
