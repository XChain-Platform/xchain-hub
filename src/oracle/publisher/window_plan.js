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

const gateRegistry = require('../../consensus/gate_registry');
const { maxBatchWindowRounds, pinnedMaxPriceAgeHourlyMs } = require('../price_batch_cadence.js');

const UNARMED_FIRST_ROUND = 9999999999;
const ORACLE_HOURLY_WINDOW_ROUNDS = 6;
const HOURLY_WINDOW_GATE =
    'oracle_hourly_window_activation.ORACLE_HOURLY_WINDOW_FIRST_ROUND';

function createWindowPlan({ firstRound, smallRounds, largeRounds, alignmentRounds }) {
    if (!Number.isInteger(smallRounds) || smallRounds <= 0) {
        throw new TypeError('smallRounds must be a positive integer');
    }
    if (!Number.isInteger(largeRounds) || largeRounds <= 0) {
        throw new TypeError('largeRounds must be a positive integer');
    }

    const armed = firstRound !== null && firstRound !== undefined &&
        firstRound !== UNARMED_FIRST_ROUND;
    const alignment = alignmentRounds === undefined ? largeRounds : alignmentRounds;
    if (!Number.isInteger(alignment) || alignment <= 0) {
        throw new TypeError('alignmentRounds must be a positive integer');
    }
    if (armed && (!Number.isSafeInteger(firstRound) || firstRound < 0 ||
        firstRound % smallRounds !== 0 || firstRound % alignment !== 0)) {
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

function createHourlyWindowPlan(opts) {
    opts = opts || {};
    const byNetwork = gateRegistry.copy(HOURLY_WINDOW_GATE);
    const firstRound = byNetwork ? byNetwork[opts.network] : undefined;
    const hourlyMaxPriceAgeMs = pinnedMaxPriceAgeHourlyMs(opts.network);
    const cadence = maxBatchWindowRounds({
        maxPriceAgeMs: hourlyMaxPriceAgeMs,
        roundIntervalMs: opts.roundIntervalMs,
        graceMs: opts.graceMs,
        landingReserveMs: opts.landingReserveMs
    });
    const largeRounds = Math.min(ORACLE_HOURLY_WINDOW_ROUNDS,
        cadence.ceiling === null ? ORACLE_HOURLY_WINDOW_ROUNDS : cadence.ceiling);
    const plan = createWindowPlan({
        firstRound,
        smallRounds: opts.smallRounds,
        largeRounds,
        alignmentRounds: ORACLE_HOURLY_WINDOW_ROUNDS
    });
    return {
        plan,
        firstRound,
        largeRounds,
        hourlyMaxPriceAgeMs,
        hourlyCeiling: cadence.ceiling,
        hourlySatisfiable: cadence.satisfiable
    };
}

module.exports = {
    createWindowPlan,
    createHourlyWindowPlan,
    ORACLE_HOURLY_WINDOW_ROUNDS,
    HOURLY_WINDOW_GATE
};
