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
const esc = require('../../src/attestation_escalation.js');

describe('attestation_escalation: blocksElapsed', function () {

    it('is 0 before the request is serviceable (still confirming)', function () {
        expect(esc.blocksElapsed(101, 100, 3)).to.equal(0);
        expect(esc.blocksElapsed(103, 100, 3)).to.equal(0);
    });

    it('counts blocks past request block + confirmations', function () {
        expect(esc.blocksElapsed(104, 100, 3)).to.equal(1);
        expect(esc.blocksElapsed(110, 100, 3)).to.equal(7);
    });

    it('clamps non-finite input to 0', function () {
        expect(esc.blocksElapsed(NaN, 100, 3)).to.equal(0);
        expect(esc.blocksElapsed(undefined, 100, 3)).to.equal(0);
    });
});

describe('attestation_escalation: escalationStep', function () {

    it('advances one step per rotation window', function () {
        expect(esc.escalationStep(103, 100, 3, 2)).to.equal(0);
        expect(esc.escalationStep(104, 100, 3, 2)).to.equal(0);
        expect(esc.escalationStep(105, 100, 3, 2)).to.equal(1);
        expect(esc.escalationStep(109, 100, 3, 2)).to.equal(3);
    });

    it('falls back to the default window on a bad window value', function () {
        expect(esc.escalationStep(105, 100, 3, 0)).to.equal(
            esc.escalationStep(105, 100, 3, esc.DEFAULT_ROTATION_WINDOW_BLOCKS));
        expect(esc.escalationStep(105, 100, 3, NaN)).to.equal(1);
    });
});

describe('attestation_escalation: leaderIndex', function () {

    it('is always slot 0 for single-member sets', function () {
        expect(esc.leaderIndex(0, 1)).to.equal(0);
        expect(esc.leaderIndex(7, 1)).to.equal(0);
    });

    it('advances one slot per step without wrapping', function () {
        expect(esc.leaderIndex(0, 5)).to.equal(0);
        expect(esc.leaderIndex(1, 5)).to.equal(1);
        expect(esc.leaderIndex(2, 5)).to.equal(2);
    });

    it('caps at MAX_LEADER_ROTATIONS (spec §8.2)', function () {
        expect(esc.leaderIndex(9, 5)).to.equal(esc.MAX_LEADER_ROTATIONS);
    });

    it('caps at the end of a small responsible set', function () {
        expect(esc.leaderIndex(9, 3)).to.equal(2);
        expect(esc.leaderIndex(2, 3)).to.equal(2);
    });

    it('treats invalid step/count defensively', function () {
        expect(esc.leaderIndex(-1, 3)).to.equal(0);
        expect(esc.leaderIndex(NaN, 3)).to.equal(0);
        expect(esc.leaderIndex(2, NaN)).to.equal(0);
    });
});

describe('attestation_escalation: modelIndex', function () {

    // Request at block 100, confirmations 3, deadline 123: serviceable span
    // is [103, 123] = 20 blocks. Two models → 10-block segments.
    it('serves the primary model in the first segment', function () {
        expect(esc.modelIndex(103, 100, 3, 123, 2)).to.equal(0);
        expect(esc.modelIndex(112, 100, 3, 123, 2)).to.equal(0);
    });

    it('escalates to the fallback model in the second segment', function () {
        expect(esc.modelIndex(113, 100, 3, 123, 2)).to.equal(1);
        expect(esc.modelIndex(122, 100, 3, 123, 2)).to.equal(1);
    });

    it('clamps to the last model past the deadline', function () {
        expect(esc.modelIndex(200, 100, 3, 123, 2)).to.equal(1);
        expect(esc.modelIndex(200, 100, 3, 123, 3)).to.equal(2);
    });

    it('splits three models into thirds of the span', function () {
        // span 21 blocks starting at 103, segments of 7
        expect(esc.modelIndex(109, 100, 3, 124, 3)).to.equal(0);
        expect(esc.modelIndex(110, 100, 3, 124, 3)).to.equal(1);
        expect(esc.modelIndex(117, 100, 3, 124, 3)).to.equal(2);
    });

    it('is always 0 for single-model chains or degenerate spans', function () {
        expect(esc.modelIndex(120, 100, 3, 123, 1)).to.equal(0);
        expect(esc.modelIndex(120, 100, 3, 123, 0)).to.equal(0);
        // Degenerate span (deadline <= serviceable start) is a deliberate
        // fallback to the primary model (index 0), NOT the last model; do
        // not "fix" this to n-1 without updating the modelIndex() comment.
        expect(esc.modelIndex(120, 100, 3, 90, 2)).to.equal(0);   // deadline before start
        expect(esc.modelIndex(120, 100, 3, NaN, 2)).to.equal(0);
    });
});
