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
 * XChain Hub - Stake share margin scoring
 *
 * The gate test, the headroom and the severity for one holding, and the projection
 * of a live reading against a hypothetical competing stake, both scored by the same
 * code. src/validators/stake_share_monitor.js re-exports projectCompetingStake.
 *
 ********************************************************************/

'use strict';

const mathjs = require('mathjs');
const { LEVELS, fmt, stakeWord, pct, marginBands } = require('./levels.js');

// The gate test, the headroom and the severity, over exact bignumbers. Split out
// so a PROJECTION (what happens if someone stakes X) is scored by the same code
// as a live reading: a "what if" that used its own arithmetic would eventually
// disagree with the monitor it is supposed to be previewing.
//   ours   operator stake (bignumber)
//   total  S, the source-deduped total (bignumber)
//   unit   the size of one new stake, or null when unsizeable
//   held   the operator-facing phrase describing the holding, for the reason line
function classifyMargin(args) {
    const ours  = args.ours;
    const total = args.total;
    const unit  = args.unit === undefined ? null : args.unit;
    const held  = args.held;
    const { warnAt, criticalAt } = marginBands(args);

    // The gate: 3*tally > 2*S, strictly. Our share is an UPPER BOUND on the
    // tally, since a source that does not sign contributes nothing.
    let threeOurs = mathjs.multiply(ours, 3);
    let twoS      = mathjs.multiply(total, 2);
    let meetsGate = threeOurs.gt(twoS);

    // Headroom: the largest additional third-party stake X that still leaves the
    // gate reachable. 3*ours > 2*(S + X)  <=>  X < (3*ours - 2*S) / 2. Positive
    // exactly when the gate holds today, so the two signals cannot disagree.
    let headroom = mathjs.divide(mathjs.subtract(threeOurs, twoS), 2);

    // How many new stakes of `unit` it takes to close the headroom. Zero when the
    // gate is already lost; null when nothing could size the unit.
    let stakesToHalt = null;
    if (!meetsGate) stakesToHalt = 0;
    else if (unit !== null) stakesToHalt = Number(mathjs.ceil(mathjs.divide(headroom, unit)).toFixed());

    let level;
    let reason;
    if (!meetsGate) {
        level  = LEVELS.HALTED;
        reason = 'operator stake holds ' + held + ', which is NOT above the two-thirds commit gate ' +
            '(3*tally > 2*S). Rounds cannot reach commit quorum on operator signatures alone: they ' +
            'finalize only if community stake signs too. ' + fmt(mathjs.unaryMinus(headroom)) +
            ' more operator stake (or that much less third-party stake) restores the gate.';
    } else if (stakesToHalt === null) {
        level  = LEVELS.OK;
        reason = 'operator stake holds ' + held + ', above the two-thirds commit gate, with ' +
            fmt(headroom) + ' of headroom. No MIN_STAKE could be resolved, so the margin is not ' +
            'sized in stakes.';
    } else if (stakesToHalt <= criticalAt) {
        level  = LEVELS.CRITICAL;
        reason = 'operator stake holds ' + held + ', above the two-thirds commit gate but only by ' +
            fmt(headroom) + ': ' + stakesToHalt + ' more ' + stakeWord(stakesToHalt) + ' of ' + fmt(unit) + ' (' + args.unitFrom +
            ') takes the federation under the gate and halts every round for this capability.';
    } else if (stakesToHalt <= warnAt) {
        level  = LEVELS.WARNING;
        reason = 'operator stake holds ' + held + ', above the two-thirds commit gate with ' +
            fmt(headroom) + ' of headroom: ' + stakesToHalt + ' more ' + stakeWord(stakesToHalt) + ' of ' + fmt(unit) +
            ' (' + args.unitFrom + ') would take the federation under the gate.';
    } else {
        level  = LEVELS.OK;
        reason = 'operator stake holds ' + held + ', above the two-thirds commit gate with ' +
            fmt(headroom) + ' of headroom (' + stakesToHalt + ' more ' + stakeWord(stakesToHalt) + ' of ' +
            fmt(unit) + ').';
    }

    return { level: level, reason: reason, meetsGate: meetsGate,
             headroom: fmt(headroom), stakesToHalt: stakesToHalt };
}

/**
 * Score a live reading against a hypothetical competing stake: what this chain
 * and capability look like the moment someone else stakes `amount`.
 *
 * This is the desk half of the drill. Broadcasting a competing STAKE on regtest
 * proves the alert fires; this answers the same question about the LIVE network
 * without putting stake on it, which is the form an operator can run against
 * production while deciding how much to top up.
 *
 * @param {object} evaluation  a result from evaluateStakeShare()
 * @param {string|number} amount  new third-party stake to add to S
 * @param {object} [opts]  warnAtStakes / criticalAtStakes overrides
 * @returns {?object} the projected margin, or null when the reading held no numbers.
 */
function projectCompetingStake(evaluation, amount, opts) {
    opts = opts || {};
    if (!evaluation || evaluation.totalStake === null || evaluation.operatorStake === null) return null;
    let add = String(amount === null || amount === undefined ? '' : amount).trim();
    if (!/^\d+\.?\d*$/.test(add)) return null;

    let ours  = mathjs.bignumber(evaluation.operatorStake);
    let total = mathjs.add(mathjs.bignumber(evaluation.totalStake), mathjs.bignumber(add));
    let unit  = evaluation.unitStake === null || evaluation.unitStake === undefined
        ? null : mathjs.bignumber(evaluation.unitStake);
    let shareRatio = total.lte(0) ? null : mathjs.divide(ours, total).toNumber();
    let held = fmt(ours) + ' of ' + fmt(total) + ' active stake (' +
        (shareRatio === null ? 'n/a' : pct(shareRatio)) + ') after a further ' + add + ' of third-party stake';

    let margin = classifyMargin({
        ours: ours, total: total, unit: unit, unitFrom: evaluation.unitStakeFrom, held: held,
        warnAtStakes: opts.warnAtStakes, criticalAtStakes: opts.criticalAtStakes
    });
    return Object.assign({
        addedStake:    add,
        totalStake:    fmt(total),
        operatorStake: fmt(ours),
        shareRatio:    shareRatio
    }, margin);
}

module.exports = {
    classifyMargin,
    projectCompetingStake
};
