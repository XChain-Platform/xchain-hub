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
 **********************************************************************
 *
 * XChain Hub - the change BOUNDS, as a Governance.prototype mixin.
 *
 * How far one proposal may move a parameter, and the absolute floor no proposal may
 * take the slash band below. Both are enforced on the proposing side and re-enforced
 * on the follower side, so the two files that call them are the two halves of the
 * same rule.
 *
 * The ratio is evaluated in exact decimal (parsed into scaled BigInts) rather than
 * in float64, so a large parameter value is not rounded past the safe-integer range
 * on its way to a percentage comparison.
 *
 ********************************************************************/

const { ORACLE_DEVIATION_THRESHOLD } = require('../../constants.js');
const { SLASHING_PARAMS, MAX_INCREASE, MAX_DECREASE, MAX_SLASH_INCREASE, MAX_SLASH_DECREASE,
        parseDecimalParts, toScaledBigInt } = require('./rules.js');

module.exports = {

    validateChangeBounds(parameter, currentValue, proposedValue) {
        // Ratio bound first, so a proposal that busts BOTH gates still reports the
        // size error; the floor below only decides values the ratio bound allows.
        this.validateChangeRatio(parameter, currentValue, proposedValue);
        this.validateSlashBandFloor(parameter, proposedValue);
    },

    // Absolute floor under the slash band, mirroring the guard SlashDetector's
    // constructor already hard-enforces (SlashDetector.js): a slash band tighter than
    // the federation-uniform oracle co-sign band would slash submissions inside the
    // band the federation just co-signed. validateChangeRatio caps only the SIZE of a
    // change, so from the 0.05 default a -20% proposal (0.04) cleared every gate,
    // and applying the approved value then bricked the hub at its next restart.
    // Sits outside validateChangeRatio's numeric early-returns so a non-numeric or
    // zero CURRENT value cannot skip it. A proposed 0 is refused here although
    // SlashDetector's `parseFloat(...) || DEFAULT` would fall back to the band: the
    // ratio bound already refuses it, and refusing is the safe direction.
    // DEPLOY NOTE: same mixed-version caveat as the follower-path bounds re-check in
    // handlePropose - fixed hubs drop a sub-floor Byzantine proposal that unfixed
    // hubs still record. Honest proposals always clear the floor, so honest traffic
    // never diverges.
    validateSlashBandFloor(parameter, proposedValue) {
        if (parameter !== 'SLASH_DEVIATION_THRESHOLD') return;
        let band = parseFloat(proposedValue);
        if (!Number.isFinite(band) || band >= ORACLE_DEVIATION_THRESHOLD) return;
        throw new Error('SLASH_DEVIATION_THRESHOLD (' + band + ') is below the federation-uniform ' +
            'ORACLE_DEVIATION_THRESHOLD (' + ORACLE_DEVIATION_THRESHOLD + '): this would slash ' +
            'submissions inside the co-signed band, and SlashDetector refuses to construct on it.');
    },

    validateChangeRatio(parameter, currentValue, proposedValue) {
        // Only validate numeric parameters
        let cur  = parseDecimalParts(currentValue);
        let prop = parseDecimalParts(proposedValue);
        if (!cur || !prop) return;

        let scale = Math.max(cur.frac.length, prop.frac.length);
        let C = toScaledBigInt(cur, scale);
        let P = toScaledBigInt(prop, scale);
        if (C === 0n) return;

        let isSlashParam = SLASHING_PARAMS.includes(parameter);
        let maxIncrease = isSlashParam ? MAX_SLASH_INCREASE : MAX_INCREASE;
        let maxDecrease = isSlashParam ? MAX_SLASH_DECREASE : MAX_DECREASE;

        // changeRatio = (P - C) / C, evaluated exactly via cross-multiplication so
        // large parameter values aren't rounded by float64. The thresholds are
        // whole-percent, so express them as integer percentages and compare
        // N*100 against pct*C. Multiplying through by C flips the inequality when
        // C < 0, which preserves the original sign-sensitive behaviour.
        let N      = P - C;
        let n100   = N * 100n;
        let incPct = BigInt(Math.round(maxIncrease * 100));
        let decPct = BigInt(Math.round(maxDecrease * 100));
        let positive = C > 0n;
        let exceedsIncrease = positive ? (n100 > incPct * C) : (n100 < incPct * C);
        let exceedsDecrease = positive ? (n100 < -decPct * C) : (n100 > -decPct * C);

        // Float ratio is fine for the human-readable percentage in the message.
        let changeRatio = Number(N) / Number(C);

        if (exceedsIncrease) {
            throw new Error('Proposed increase (' + (changeRatio * 100).toFixed(1) + '%) exceeds maximum (' + (maxIncrease * 100) + '%)');
        }
        if (exceedsDecrease) {
            throw new Error('Proposed decrease (' + (Math.abs(changeRatio) * 100).toFixed(1) + '%) exceeds maximum (' + (maxDecrease * 100) + '%)');
        }
    }

};
