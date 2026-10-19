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
const { leadsSnapshotSlot } = require('../../../../src/anchor/snapshot_checkpoint/leader.js');

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
