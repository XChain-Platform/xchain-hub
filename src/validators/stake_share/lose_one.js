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
 * XChain Hub - Stake share lose-one margin
 *
 * Whether the two-thirds commit gate still holds when the single largest
 * staking source stops signing. The all-up share says how far the federation is
 * from the gate with everyone present; this says whether one outage can end
 * finalization. The verdict is the gate's own predicate over the snapshot, so a
 * snapshot it fails closed on is reported as not surviving.
 *
 ********************************************************************/

'use strict';

const mathjs = require('mathjs');
const { totalStake, meetsStakeThreshold } = require('../../consensus/stake_weighted_quorum.js');
const { fmt } = require('./levels.js');

// Weight per distinct source, first row wins, as totalStake() counts it.
function weightsBySource(validators) {
    let bySource = new Map();
    for (let v of validators) {
        let src = String(v.source);
        if (!bySource.has(src)) bySource.set(src, mathjs.bignumber(String(v.weight).trim()));
    }
    return bySource;
}

// The largest source, the stake left without it, and the predicate's verdict
// when every other source signs. Ties pick the first source in snapshot order;
// the remainder is the same whichever of equals is lost.
function quorumAfterLosingLargest(validators) {
    let total;
    try {
        total = totalStake(validators);
    } catch (err) {
        return { survives: false, usable: false, reason: (err && err.message) || 'unusable snapshot' };
    }
    if (total.lte(0)) return { survives: false, usable: false, reason: 'total active stake is not positive' };

    let bySource = weightsBySource(validators);
    let largestSource = null;
    let largest = null;
    for (let [src, w] of bySource) {
        if (largest === null || w.gt(largest)) { largest = w; largestSource = src; }
    }
    let signers = validators.filter(v => String(v.source) !== largestSource).map(v => v.pubkey);
    let survives = meetsStakeThreshold(validators, signers);
    let remaining = mathjs.subtract(total, largest);
    return {
        survives:      survives,
        usable:        true,
        largestSource: largestSource,
        largestStake:  fmt(largest),
        remainingStake: fmt(remaining),
        totalStake:    fmt(total),
        remainingRatio: mathjs.divide(remaining, total).toNumber(),
        sourceCount:   bySource.size
    };
}

module.exports = { quorumAfterLosingLargest };
