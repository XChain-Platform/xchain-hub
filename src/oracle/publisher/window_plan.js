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

const UNARMED_FIRST_ROUND = 9999999999;

function createWindowPlan({ firstRound, smallRounds, largeRounds }) {
    if (!Number.isInteger(smallRounds) || smallRounds <= 0) {
        throw new TypeError('smallRounds must be a positive integer');
    }
    if (!Number.isInteger(largeRounds) || largeRounds <= 0) {
        throw new TypeError('largeRounds must be a positive integer');
    }

    const armed = firstRound !== null && firstRound !== UNARMED_FIRST_ROUND;
    if (armed && (!Number.isSafeInteger(firstRound) || firstRound < 0 ||
        firstRound % smallRounds !== 0 || firstRound % largeRounds !== 0)) {
        throw new RangeError('firstRound ' + String(firstRound) +
            ' must be a non-negative safe integer multiple of both window sizes');
    }

    const switchWindow = armed ? firstRound / smallRounds : null;

    return {
        windowOf(round) {
            if (!armed || round < firstRound) return Math.floor(round / smallRounds);
            return switchWindow + Math.floor((round - firstRound) / largeRounds);
        },

        rangeOf(windowIndex) {
            if (!armed || windowIndex < switchWindow) {
                const first = windowIndex * smallRounds;
                return { first, last: first + smallRounds - 1 };
            }
            const first = firstRound + (windowIndex - switchWindow) * largeRounds;
            return { first, last: first + largeRounds - 1 };
        },

        sizeAt(round) {
            return armed && round >= firstRound ? largeRounds : smallRounds;
        },

        straddles(first, last) {
            return armed && first < firstRound && firstRound <= last;
        }
    };
}

module.exports = { createWindowPlan };
