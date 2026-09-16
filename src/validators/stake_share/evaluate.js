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
 * XChain Hub - Stake share evaluation
 *
 * Measures the operator's share of one capability's active stake against the
 * STAKE_WEIGHTED_QUORUM commit gate as ordered steps: the total, the operator's
 * sources, the size of one new stake, then the margin score. The module header of
 * src/validators/stake_share_monitor.js explains why the margin is counted in stakes.
 *
 ********************************************************************/

'use strict';

const mathjs = require('mathjs');
const { totalStake } = require('../../consensus/stake_weighted_quorum.js');
const { LEVELS, fmt, pct, normalizeSources, emptyResult, marginBands } = require('./levels.js');
const { classifyMargin } = require('./margin.js');

// S, and the malformed/truncated guards, come from the predicate itself.
// A snapshot it throws on is one meetsStakeThreshold() would fail CLOSED on,
// which is a halt in its own right, so it is reported rather than swallowed.
function readTotalStake(validators, configured) {
    // Returns { S } for a usable total, or { result } holding the BLOCKED evaluation.
    let S;
    try {
        S = totalStake(validators);
    } catch (err) {
        let res = emptyResult(LEVELS.BLOCKED,
            'the stake snapshot is one the quorum predicate fails CLOSED on, so no round over it can ' +
            'finalize regardless of our share: ' + ((err && err.message) || 'unusable snapshot'));
        res.configuredSourceCount = configured.length;
        return { result: res };
    }
    if (S.lte(0)) {
        let res = emptyResult(LEVELS.BLOCKED,
            'total active stake is ' + fmt(S) + ', so the two-thirds gate cannot be expressed and every ' +
            'round fails closed. Either no source qualifies for this capability or the snapshot is empty.');
        res.configuredSourceCount = configured.length;
        res.totalStake = fmt(S);
        res.sourceCount = 0;
        return { result: res };
    }
    return { S: S };
}

// First-wins per source, matching totalStake(): every key of a source carries
// the same weight, and the rows are already known well-formed because
// totalStake() would have thrown otherwise.
function matchOperatorSources(validators, configured) {
    let weightBySource = new Map();
    for (let v of validators) {
        let src = String(v.source);
        if (!weightBySource.has(src)) weightBySource.set(src, mathjs.bignumber(String(v.weight).trim()));
    }

    let ours = mathjs.bignumber(0);
    let matched = [];
    for (let src of configured) {
        if (!weightBySource.has(src)) continue;
        matched.push(src);
        ours = mathjs.add(ours, weightBySource.get(src));
    }
    let unmatched = configured.filter(s => !weightBySource.has(s));
    return { weightBySource: weightBySource, ours: ours, matched: matched, unmatched: unmatched };
}

// The evaluation when none of the configured sources is in the snapshot.
function unmatchedResult(configured, sources, S) {
    // Not "halted": a share of zero here is far more likely a wrong or
    // stale address list than the operator's stake actually being gone, and
    // paging on a config typo teaches an operator to ignore this monitor.
    let res = emptyResult(LEVELS.UNCONFIGURED,
        'none of the ' + configured.length + ' configured operator staking sources appear in this ' +
        'snapshot of ' + sources.weightBySource.size + ' staking sources, so the share cannot be measured. ' +
        'Check the addresses: they are per chain, and a source that has not staked for this ' +
        'capability is not in the set.');
    res.configuredSourceCount    = configured.length;
    res.unmatchedOperatorSources = sources.unmatched;
    res.totalStake               = fmt(S);
    res.sourceCount              = sources.weightBySource.size;
    res.operatorStake            = '0';
    res.otherStake               = fmt(S);
    res.shareRatio               = 0;
    return res;
}

// The size of "one more staker", which is the unit the margin is counted in.
//
// MIN_STAKE alone is NOT that size, and assuming it was is how this reads a
// prior outage's federation as comfortable: `price` MIN_STAKE is 1000, while the
// community stakes that actually arrived were 25000 each, so counting the
// 12500 of headroom in thousands said "twelve more stakers" about a set that
// one staker ended. The evidence for what a real stake looks like here is the
// stakes that are already here, so the unit is the LARGEST third-party stake
// in the snapshot, floored at MIN_STAKE (nobody can qualify below it).
//
// Largest, not median or smallest: someone can certainly do what someone has
// already done, and a margin that survives the biggest staker repeating
// themselves is a margin that survives anything smaller.
function sizeStakeUnit(weightBySource, matched, minStake) {
    let matchedSet = new Set(matched);
    let largestOther = null;
    let largestAny   = null;
    for (let [src, w] of weightBySource) {
        if (w.lte(0)) continue;
        if (largestAny === null || w.gt(largestAny)) largestAny = w;
        if (matchedSet.has(src)) continue;
        if (largestOther === null || w.gt(largestOther)) largestOther = w;
    }
    // With no third-party source yet, our own largest stake is the only evidence
    // of the scale people stake at on this chain.
    let observed     = largestOther !== null ? largestOther : largestAny;
    let observedFrom = largestOther !== null ? 'largest_other_source' : 'largest_source';

    let unit = null;
    let unitFrom = null;
    let cfgMin = minStake === null || minStake === undefined ? null : String(minStake).trim();
    if (cfgMin !== null && /^\d+\.?\d*$/.test(cfgMin) && mathjs.bignumber(cfgMin).gt(0)) {
        unit = mathjs.bignumber(cfgMin);
        unitFrom = 'min_stake';
    }
    if (observed !== null && (unit === null || observed.gt(unit))) {
        unit = observed;
        unitFrom = observedFrom;
    }
    return { unit: unit, unitFrom: unitFrom };
}

/**
 * Measure the operator's share of one capability's active stake against the
 * STAKE_WEIGHTED_QUORUM commit gate.
 *
 * @param {object}   opts
 * @param {Array}    opts.validators       weight snapshot rows [{pubkey, source, weight}];
 *                                         an array carrying `truncated === true` is refused
 *                                         exactly as the quorum predicate refuses it.
 * @param {Array|string} opts.operatorSources staking addresses this operator controls.
 * @param {string|number} [opts.minStake]  capability MIN_STAKE: the smallest stake a NEW
 *                                         source can qualify with, and therefore the unit
 *                                         the margin is counted in. Falls back to the
 *                                         smallest stake actually present.
 * @param {number} [opts.warnAtStakes]     margin (in new stakes) that still counts as WARNING.
 * @param {number} [opts.criticalAtStakes] margin (in new stakes) that counts as CRITICAL.
 * @returns {object} evaluation; see emptyResult() for the field set.
 */
function evaluateStakeShare(opts) {
    opts = opts || {};
    const configured = normalizeSources(opts.operatorSources);
    const { warnAt, criticalAt } = marginBands(opts);

    if (configured.length === 0) {
        return emptyResult(LEVELS.UNCONFIGURED,
            'no operator staking sources are configured, so this hub cannot tell its own stake from ' +
            'anyone else\'s. Set HUB_OPERATOR_STAKE_SOURCES (or the per-chain form) to the staking ' +
            'addresses this operator controls.');
    }

    const read = readTotalStake(opts.validators, configured);
    if (read.result) return read.result;
    const S = read.S;

    const sources = matchOperatorSources(opts.validators, configured);
    if (sources.matched.length === 0) return unmatchedResult(configured, sources, S);
    const ours = sources.ours;
    const matched = sources.matched;
    const unmatched = sources.unmatched;
    const weightBySource = sources.weightBySource;
    const { unit, unitFrom } = sizeStakeUnit(weightBySource, matched, opts.minStake);

    let shareRatio = mathjs.divide(ours, S).toNumber();
    let other      = mathjs.subtract(S, ours);
    let held = fmt(ours) + ' of ' + fmt(S) + ' active stake (' + pct(shareRatio) + ') across ' +
        matched.length + ' of ' + weightBySource.size + ' staking sources';
    let margin = classifyMargin({
        ours: ours, total: S, unit: unit, unitFrom: unitFrom, held: held,
        warnAtStakes: warnAt, criticalAtStakes: criticalAt
    });

    return {
        level:                    margin.level,
        reason:                   margin.reason,
        totalStake:               fmt(S),
        operatorStake:            fmt(ours),
        otherStake:               fmt(other),
        shareRatio:               shareRatio,
        sourceCount:              weightBySource.size,
        operatorSourceCount:      matched.length,
        configuredSourceCount:    configured.length,
        unmatchedOperatorSources: unmatched,
        meetsGate:                margin.meetsGate,
        headroom:                 margin.headroom,
        unitStake:                unit === null ? null : fmt(unit),
        unitStakeFrom:            unitFrom,
        stakesToHalt:             margin.stakesToHalt
    };
}

module.exports = {
    evaluateStakeShare
};
