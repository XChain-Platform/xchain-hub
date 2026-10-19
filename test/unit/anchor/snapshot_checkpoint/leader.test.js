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

const { expect } = require('chai');
const snapshotTypes = require('../../../../src/anchor/snapshot_checkpoint/constants.js');
const cadenceTypes = require('../../../../src/anchor/checkpoint_engine/constants.js');
const {
    SNAPSHOT_FALLBACK_STEP_BLOCKS: STEP,
    leadsSnapshotSlot,
    mayLeadSnapshotSlot,
    snapshotLeaderRank,
} = require('../../../../src/anchor/snapshot_checkpoint/leader.js');

const key = digit => String(digit).repeat(64);
const validators = (...digits) => digits.map(digit => ({ pubkey: key(digit) }));

describe('snapshot checkpoint wire types', function () {
    it('exports distinct type names outside the cadence checkpoint family', function () {
        let names = ['XSNP_SIGN_REQ', 'XSNP_SIGN', 'XSNP_FINALIZED'];
        let cadenceValues = Object.values(cadenceTypes).filter(value => typeof value === 'string');

        for (let name of names) {
            expect(snapshotTypes[name]).to.equal(name);
            expect(cadenceValues).not.to.include(snapshotTypes[name]);
        }
        expect(new Set(names.map(name => snapshotTypes[name])).size).to.equal(names.length);
    });
});

describe('leadsSnapshotSlot()', function () {
    it('always selects the sole member', function () {
        expect(leadsSnapshotSlot(0, validators(1), key(1))).to.equal(true);
        expect(leadsSnapshotSlot(7, validators(1), key(1))).to.equal(true);
    });

    it('rejects an absent set or identity and a non-member', function () {
        expect(leadsSnapshotSlot(0, [], key(1))).to.equal(false);
        expect(leadsSnapshotSlot(0, null, key(1))).to.equal(false);
        expect(leadsSnapshotSlot(0, validators(1), null)).to.equal(false);
        expect(leadsSnapshotSlot(0, validators(1), key(2))).to.equal(false);
    });

    it('rotates over the sorted validator keys', function () {
        let set = validators(3, 1, 2);
        for (let blockIndex = 0; blockIndex < 9; blockIndex++) {
            for (let digit of [1, 2, 3]) {
                expect(leadsSnapshotSlot(blockIndex, set, key(digit)),
                    'block ' + blockIndex + ', key ' + digit).to.equal(digit - 1 === blockIndex % 3);
            }
        }
    });

    it('deduplicates repeated validator keys before rotating', function () {
        let set = validators(1, 2, 2, 3, 3, 3);
        for (let blockIndex = 0; blockIndex < 6; blockIndex++) {
            for (let digit of [1, 2, 3]) {
                expect(leadsSnapshotSlot(blockIndex, set, key(digit)),
                    'block ' + blockIndex + ', key ' + digit).to.equal(digit - 1 === blockIndex % 3);
            }
        }
    });

    it('matches validator keys and the local identity without case sensitivity', function () {
        let set = [{ pubkey: key('a').toUpperCase() }, { pubkey: key('b') }];
        expect(leadsSnapshotSlot(0, set, key('a'))).to.equal(true);
        expect(leadsSnapshotSlot(1, set, key('b').toUpperCase())).to.equal(true);
    });

    it('rejects block indices outside the non-negative safe integer range', function () {
        for (let blockIndex of [-1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1]) {
            expect(leadsSnapshotSlot(blockIndex, validators(1), key(1)),
                String(blockIndex)).to.equal(false);
        }
    });
});

describe('snapshotLeaderRank()', function () {
    it('counts places after the turn hub in the sorted rotation', function () {
        let set = validators(3, 1, 2);
        for (let blockIndex = 0; blockIndex < 6; blockIndex++) {
            for (let digit of [1, 2, 3]) {
                expect(snapshotLeaderRank(blockIndex, set, key(digit)),
                    'block ' + blockIndex + ', key ' + digit)
                    .to.equal((digit - 1 - blockIndex % 3 + 3) % 3);
            }
        }
    });

    it('returns null for unusable inputs and a non-member', function () {
        expect(snapshotLeaderRank(-1, validators(1), key(1))).to.equal(null);
        expect(snapshotLeaderRank(0, [], key(1))).to.equal(null);
        expect(snapshotLeaderRank(0, validators(1), '')).to.equal(null);
        expect(snapshotLeaderRank(0, validators(1), key(2))).to.equal(null);
    });
});

describe('mayLeadSnapshotSlot()', function () {
    let set = validators(1, 2, 3, 4, 5);

    it('always lets the turn hub lead, whatever the depth', function () {
        for (let overdue of [undefined, null, 0, 1000])
            expect(mayLeadSnapshotSlot(7, set, key(3), overdue), String(overdue)).to.equal(true);
    });

    it('lets rank k lead only once the tip is k steps past the due height', function () {
        for (let rank = 1; rank < 5; rank++) {
            let pubkey = key((7 + rank) % 5 + 1);
            expect(snapshotLeaderRank(7, set, pubkey)).to.equal(rank);
            expect(mayLeadSnapshotSlot(7, set, pubkey, rank * STEP - 1)).to.equal(false);
            expect(mayLeadSnapshotSlot(7, set, pubkey, rank * STEP)).to.equal(true);
        }
    });

    it('keeps only the turn hub when the depth is missing or not an integer', function () {
        for (let overdue of [undefined, null, NaN, 2.5, '9'])
            expect(mayLeadSnapshotSlot(7, set, key(4), overdue), String(overdue)).to.equal(false);
        expect(mayLeadSnapshotSlot(7, set, key(6), 1000)).to.equal(false);
    });

    it('agrees with leadsSnapshotSlot when no depth is given', function () {
        for (let blockIndex = 0; blockIndex < 10; blockIndex++) {
            for (let digit of [1, 2, 3, 4, 5]) {
                expect(mayLeadSnapshotSlot(blockIndex, set, key(digit)))
                    .to.equal(leadsSnapshotSlot(blockIndex, set, key(digit)));
            }
        }
    });
});
