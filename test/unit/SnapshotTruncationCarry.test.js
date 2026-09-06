'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

const { expect } = require('chai');
const swq            = require('../../src/stake_weighted_quorum.js');
const Consensus      = require('../../src/Consensus.js');
const OracleConsensus = require('../../src/OracleConsensus.js');

// SWQ-TRUNC: the round-locking normalizations rebuild a snapshot's validators with
// `.map(...)`, which drops the `truncated` marker CapabilitySnapshot sets on the
// snapshot object. meetsStakeThreshold fails CLOSED on that marker and reads it off the
// ARRAY it is handed, so a rebuild that loses it hands the predicate a capped set it
// reads as complete: S is under-counted and a minority of stake clears the 2/3 bar.
describe('capability-snapshot truncation carry (round locking)', function () {

    // The indexer capped the qualifying set: a 100-stake source was dropped, leaving
    // 70 + 20 retained. Over the RETAINED set alone, 3*70 = 210 > 2*90 = 180, so the
    // lone 70-stake signer clears quorum; over the full set it never would.
    const RETAINED = [
        { pubkey: 'AA', source: 'S1', weight: '70' },
        { pubkey: 'BB', source: 'S2', weight: '20' }
    ];
    const truncatedSnapshot = () => ({ truncated: true,  validators: RETAINED.map(v => Object.assign({}, v)) });
    const completeSnapshot  = () => ({ truncated: false, validators: RETAINED.map(v => Object.assign({}, v)) });

    // Both engines normalize with a `this`-free prototype method, so a bare call is the
    // whole unit; no hub, DB or indexer is involved in the behaviour under test.
    const normalizers = [
        ['Consensus._normalizeValidators',       (s, w) => Consensus.prototype._normalizeValidators.call({}, s, w)],
        ['OracleConsensus._normalizeValidators', (s, w) => OracleConsensus.prototype._normalizeValidators.call({}, s, w)]
    ];

    for (const [name, normalize] of normalizers) {

        it(name + ' carries `truncated` onto the rebuilt array', function () {
            const out = normalize(truncatedSnapshot(), true);
            expect(out).to.have.lengthOf(2);
            expect(out.truncated).to.equal(true);
        });

        it('SECURITY: ' + name + ' keeps meetsStakeThreshold failing CLOSED on a capped snapshot', function () {
            const out = normalize(truncatedSnapshot(), true);
            expect(swq.meetsStakeThreshold(out, ['aa'])).to.equal(false);
        });

        // Negative control. Without the marker the SAME retained rows finalize, which is
        // exactly the state the pre-fix `.map(...)` left the predicate in: if the carry is
        // ever reverted the assertion above flips to true and goes red, and this one shows
        // the difference is the marker and nothing else about the set.
        it(name + ' leaves an UNtruncated snapshot finalizable (control)', function () {
            const out = normalize(completeSnapshot(), true);
            expect(out.truncated).to.equal(undefined);
            expect(swq.meetsStakeThreshold(out, ['aa'])).to.equal(true);
        });

        it(name + ' returns a bare [] in count mode, marker or not', function () {
            const out = normalize(truncatedSnapshot(), false);
            expect(out).to.deep.equal([]);
            expect(out.truncated).to.equal(undefined);
        });
    }
});
