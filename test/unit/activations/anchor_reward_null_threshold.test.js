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
//
// An unpinned (null) reward threshold must read as inert. `sb >= null` coerces null to 0,
// so without the guard a null row arms derivation from genesis.

const { expect } = require('chai');
const gate = require('../../../src/consensus/gates/anchor_reward_gate');

const CASES = [
    ['isAnchorRewardActive', 'ANCHOR_REWARD_ACTIVATION'],
    ['isArchiveRewardActive', 'ARCHIVE_REWARD_ACTIVATION'],
];

describe('anchor_reward_gate: a null threshold is inert', function () {
    for (const [fn, table] of CASES) {
        describe(fn, function () {
            const NET = 'nullnet';
            before(function () { gate[table][NET] = null; });
            after(function () { delete gate[table][NET]; });

            it('returns false at every height for a null threshold', function () {
                for (const h of [0, 1, 961000, Number.MAX_SAFE_INTEGER])
                    expect(gate[fn](h, NET), 'armed at ' + h).to.equal(false);
            });

            it('still arms a pinned numeric threshold', function () {
                gate[table][NET] = 100;
                try {
                    expect(gate[fn](99, NET)).to.equal(false);
                    expect(gate[fn](100, NET)).to.equal(true);
                } finally {
                    gate[table][NET] = null;
                }
            });
        });
    }
});
