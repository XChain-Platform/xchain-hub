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

// Ledger P60: rotation must step OVER a slot whose member has been proven
// silent instead of stopping on it. The observation (which slots are silent) is
// the caller's; these cases pin the arithmetic that consumes it.
describe('attestation_escalation: effectiveLeaderSlot', function () {

    it('is the plain ladder when nothing is proven silent', function () {
        for(let step = 0; step <= 9; step++){
            expect(esc.effectiveLeaderSlot(step, 5, new Set())).to.equal(esc.leaderIndex(step, 5));
            expect(esc.effectiveLeaderSlot(step, 5, null)).to.equal(esc.leaderIndex(step, 5));
        }
    });

    it('steps over a silent slot without spending a rotation', function () {
        // Slot 0 mute: step 0 already elects slot 1, and the three live
        // rotations the cap allows then reach slot 4, not slot 3.
        expect(esc.effectiveLeaderSlot(0, 5, new Set([0]))).to.equal(1);
        expect(esc.effectiveLeaderSlot(1, 5, new Set([0]))).to.equal(2);
        expect(esc.effectiveLeaderSlot(3, 5, new Set([0]))).to.equal(4);
    });

    it('unfreezes the capped slot the live defect pinned (request 233)', function () {
        // The bare ladder freezes at MAX_LEADER_ROTATIONS for every step >= 3.
        expect(esc.leaderIndex(9, 5)).to.equal(3);
        // Proving slot 3 silent moves the round on instead of holding it there.
        expect(esc.effectiveLeaderSlot(9, 5, new Set([3]))).to.equal(4);
    });

    it('counts LIVE rotations only against the cap', function () {
        // Two mute slots in the middle: three live rotations still land three
        // live members past slot 0, which a rotation-consuming skip could not do.
        expect(esc.effectiveLeaderSlot(3, 7, new Set([1, 2]))).to.equal(5);
    });

    it('never returns to a slot already proven silent', function () {
        // Every step, over every prefix of the silent set, stays off the mute slots.
        let silent = new Set([0, 2]);
        for(let step = 0; step <= 9; step++){
            let slot = esc.effectiveLeaderSlot(step, 6, silent);
            expect(silent.has(slot), 'step ' + step + ' elected a silent slot').to.be.false;
        }
    });

    it('holds the last live slot when every slot ahead is silent', function () {
        // Slots 3 and 4 mute: the third rotation finds no live slot ahead and
        // holds slot 2 rather than running off the end of the set.
        expect(esc.effectiveLeaderSlot(3, 5, new Set([3, 4]))).to.equal(2);
        expect(esc.effectiveLeaderSlot(9, 5, new Set([3, 4]))).to.equal(2);
    });

    it('ruled acceptable: seats a slot BEHIND the plain ladder when every slot ahead is silent', function () {
        // The plain ladder's raw step-9 target is slot 3, and slot 3 (and
        // slot 4 past it) are both proven silent, so there is no live slot
        // left ahead. The dead-end rule holds slot 2 instead: a real
        // regression relative to leaderIndex's own answer for this step, and
        // the ruled-acceptable behavior documented on effectiveLeaderSlot.
        expect(esc.leaderIndex(9, 5)).to.equal(3);
        let held = esc.effectiveLeaderSlot(9, 5, new Set([3, 4]));
        expect(held).to.equal(2);
        expect(held).to.be.below(esc.leaderIndex(9, 5));
        // Never seats a slot already proven silent, even while regressing.
        expect(new Set([3, 4]).has(held)).to.be.false;
    });

    it('holds the LAST slot, never slot 0, when every slot is silent', function () {
        expect(esc.effectiveLeaderSlot(0, 4, new Set([0, 1, 2, 3]))).to.equal(3);
        expect(esc.effectiveLeaderSlot(9, 4, new Set([0, 1, 2, 3]))).to.equal(3);
    });

    it('accepts an array observation and treats absent as nothing silent', function () {
        expect(esc.effectiveLeaderSlot(0, 5, [true, false, false, false, false])).to.equal(1);
        expect(esc.effectiveLeaderSlot(2, 5, undefined)).to.equal(2);
    });

    it('treats invalid step/count defensively, as leaderIndex does', function () {
        expect(esc.effectiveLeaderSlot(2, 1, new Set([0]))).to.equal(0);
        expect(esc.effectiveLeaderSlot(-1, 3, new Set())).to.equal(0);
        expect(esc.effectiveLeaderSlot(NaN, 3, new Set())).to.equal(0);
        expect(esc.effectiveLeaderSlot(2, NaN, new Set())).to.equal(0);
    });
});

describe('attestation_escalation: isProvenSilent', function () {

    it('is false until a full rotation window of chain time has passed', function () {
        expect(esc.isProvenSilent(100, 100, 2)).to.be.false;
        expect(esc.isProvenSilent(101, 100, 2)).to.be.false;
        expect(esc.isProvenSilent(102, 100, 2)).to.be.true;
        expect(esc.isProvenSilent(140, 100, 2)).to.be.true;
    });

    it('falls back to the default window on a bad window value', function () {
        expect(esc.isProvenSilent(101, 100, 0)).to.be.false;
        expect(esc.isProvenSilent(100 + esc.DEFAULT_ROTATION_WINDOW_BLOCKS, 100, NaN)).to.be.true;
    });

    it('never convicts on an unusable height', function () {
        expect(esc.isProvenSilent(NaN, 100, 2)).to.be.false;
        expect(esc.isProvenSilent(120, null, 2)).to.be.false;
        expect(esc.isProvenSilent(120, undefined, 2)).to.be.false;
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
