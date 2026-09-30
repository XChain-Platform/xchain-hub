/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const { createWindowPlan } = require('../../../src/oracle/publisher/window_plan.js');

describe('window plan math', function() {
    it('maps the last small window and first large window around the switch', function() {
        const plan = createWindowPlan({ firstRound: 120, smallRounds: 2, largeRounds: 6 });

        assert.strictEqual(plan.windowOf(118), 59);
        assert.strictEqual(plan.windowOf(119), 59);
        assert.deepStrictEqual(plan.rangeOf(59), { first: 118, last: 119 });
        assert.strictEqual(plan.sizeAt(119), 2);

        assert.strictEqual(plan.windowOf(120), 60);
        assert.strictEqual(plan.windowOf(125), 60);
        assert.deepStrictEqual(plan.rangeOf(60), { first: 120, last: 125 });
        assert.strictEqual(plan.sizeAt(120), 6);
    });

    it('keeps indices monotonic and rangeOf round-trips on both sides', function() {
        const plan = createWindowPlan({ firstRound: 120, smallRounds: 2, largeRounds: 6 });
        let previous = -1;

        for (let round = 0; round <= 150; round++) {
            const windowIndex = plan.windowOf(round);
            const range = plan.rangeOf(windowIndex);

            assert.ok(windowIndex >= previous, 'index moved backwards at round ' + round);
            assert.ok(range.first <= round && round <= range.last,
                'round ' + round + ' not contained by window ' + windowIndex);
            assert.strictEqual(plan.windowOf(range.first), windowIndex);
            assert.strictEqual(plan.windowOf(range.last), windowIndex);
            previous = windowIndex;
        }
    });

    it('supports a switch at round zero', function() {
        const plan = createWindowPlan({ firstRound: 0, smallRounds: 2, largeRounds: 6 });

        assert.strictEqual(plan.windowOf(0), 0);
        assert.strictEqual(plan.windowOf(5), 0);
        assert.strictEqual(plan.windowOf(6), 1);
        assert.deepStrictEqual(plan.rangeOf(0), { first: 0, last: 5 });
        assert.strictEqual(plan.sizeAt(0), 6);
        assert.strictEqual(plan.straddles(0, 5), false);
    });

    for (const firstRound of [null, 9999999999]) {
        it('uses only small windows when firstRound is ' + String(firstRound), function() {
            const plan = createWindowPlan({ firstRound, smallRounds: 2, largeRounds: 6 });

            assert.strictEqual(plan.windowOf(20000001), 10000000);
            assert.deepStrictEqual(plan.rangeOf(10000000), {
                first: 20000000,
                last: 20000001
            });
            assert.strictEqual(plan.sizeAt(20000001), 2);
            assert.strictEqual(plan.straddles(0, 20000001), false);
        });
    }

    it('refuses invalid window sizes with TypeError', function() {
        assert.throws(
            () => createWindowPlan({ firstRound: 12, smallRounds: 0, largeRounds: 6 }),
            TypeError);
        assert.throws(
            () => createWindowPlan({ firstRound: 12, smallRounds: 2, largeRounds: 1.5 }),
            TypeError);
    });

    it('refuses an armed switch not aligned to both sizes and names its value', function() {
        assert.throws(
            () => createWindowPlan({ firstRound: 9, smallRounds: 2, largeRounds: 6 }),
            (error) => error instanceof RangeError && /9/.test(error.message));
    });

    it('refuses an armed switch outside the safe non-negative integer range', function() {
        for (const firstRound of [-6, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(
                () => createWindowPlan({ firstRound, smallRounds: 2, largeRounds: 6 }),
                (error) => error instanceof RangeError &&
                    error.message.includes(String(firstRound)));
        }
    });

    it('detects only intervals that cross the armed switch', function() {
        const plan = createWindowPlan({ firstRound: 120, smallRounds: 2, largeRounds: 6 });

        assert.strictEqual(plan.straddles(118, 121), true);
        assert.strictEqual(plan.straddles(119, 120), true);
        assert.strictEqual(plan.straddles(120, 125), false);
        assert.strictEqual(plan.straddles(118, 119), false);
    });
});
