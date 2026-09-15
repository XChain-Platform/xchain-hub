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
 * XChain Hub - Stake share levels and formatting
 *
 * The severity taxonomy, the margin defaults and the small helpers the stake-share
 * evaluation, the margin score and StakeShareMonitor all read. Pure: no logger and
 * no network. src/validators/stake_share_monitor.js re-exports the public names.
 *
 ********************************************************************/

'use strict';

// Severity taxonomy. Held as constants so a caller cannot invent a level by
// typo (which would silently fall out of every alert comparison in the monitor).
const LEVELS = {
    OK:           'ok',            // more than warnAtStakes new stakes needed to cross the gate
    UNCONFIGURED: 'unconfigured',  // nothing to measure: no operator sources known / matched
    UNAVAILABLE:  'unavailable',   // the snapshot could not be read at all this pass
    WARNING:      'warning',       // within warnAtStakes new stakes of the gate
    CRITICAL:     'critical',      // within criticalAtStakes: one more staker can halt rounds
    HALTED:       'halted',        // already under the gate; rounds cannot reach commit quorum
    BLOCKED:      'blocked'        // snapshot is one the quorum predicate itself fails closed on
};

// Ordering for "which entry is worst" and for the alert cut. UNCONFIGURED and
// UNAVAILABLE rank ABOVE ok (they are things to fix) but BELOW warning, because
// neither is evidence about the actual share.
const LEVEL_RANK = {
    [LEVELS.OK]:           0,
    [LEVELS.UNCONFIGURED]: 1,
    [LEVELS.UNAVAILABLE]:  1,
    [LEVELS.WARNING]:      2,
    [LEVELS.CRITICAL]:     3,
    [LEVELS.HALTED]:       4,
    [LEVELS.BLOCKED]:      4
};

// At or above this rank the monitor asserts `alerting`. CRITICAL is the first
// level that means "one more community stake ends price rounds", which is the
// state a prior outage needed to be paged on and never was.
const ALERT_RANK = LEVEL_RANK[LEVELS.CRITICAL];

// How many new stakes of margin still count as CRITICAL / WARNING. One is the
// smallest step the outside world can take, so a headroom a single new staker
// can close is the critical case by construction; two is one staker of slack,
// which is the point at which an operator still has time to top up before the
// next one arrives.
const DEFAULT_CRITICAL_AT_STAKES = 1;
const DEFAULT_WARN_AT_STAKES     = 2;

// Exact decimal string for a bignumber. toFixed() (not toString()) so a very
// large or very small total never renders in exponential notation into a log
// line or a /health body an operator has to read.
function fmt(bn) {
    return bn.toFixed();
}

// "1 stake" / "2 stakes", so a tuned critical margin does not read as "2 more
// stake" in the one line an operator actually gets paged with.
function stakeWord(n) {
    return Math.abs(Number(n)) === 1 ? 'stake' : 'stakes';
}

// Percentage, three decimals, for operator-facing prose only. Never used in a
// comparison: every threshold decision in evaluate.js and margin.js is made on exact bignumbers.
function pct(ratio) {
    return (ratio * 100).toFixed(3) + '%';
}

// Normalize the configured operator source list. Accepts an array or a
// comma/whitespace-separated string; blanks are dropped, duplicates collapse.
// Matching is EXACT (base58 addresses are case-sensitive; folding case here
// would let a wrong-case address match a real staking source).
function normalizeSources(sources) {
    let list = [];
    if (Array.isArray(sources)) list = sources;
    else if (typeof sources === 'string') list = sources.split(/[,\s]+/);
    let out = [];
    let seen = new Set();
    for (let s of list) {
        if (s === null || s === undefined) continue;
        let v = String(s).trim();
        if (v === '' || seen.has(v)) continue;
        seen.add(v);
        out.push(v);
    }
    return out;
}

// Shape shared by every early return, so a consumer (metrics, /health) can read
// the same fields whatever the outcome instead of feature-testing each level.
function emptyResult(level, reason) {
    return {
        level:                    level,
        reason:                   reason,
        totalStake:               null,
        operatorStake:            null,
        otherStake:               null,
        shareRatio:               null,
        sourceCount:              null,
        operatorSourceCount:      0,
        configuredSourceCount:    0,
        unmatchedOperatorSources: [],
        meetsGate:                null,
        headroom:                 null,
        unitStake:                null,
        unitStakeFrom:            null,
        stakesToHalt:             null
    };
}

// True when a level is one an operator must act on.
function isAlertLevel(level) {
    return (LEVEL_RANK[level] || 0) >= ALERT_RANK;
}

// The WARNING and CRITICAL margins (in new stakes) a caller asked for, each one
// falling back to its default unless it is a positive integer.
function marginBands(opts) {
    const warnAt = Number.isInteger(opts.warnAtStakes) && opts.warnAtStakes > 0
        ? opts.warnAtStakes : DEFAULT_WARN_AT_STAKES;
    const criticalAt = Number.isInteger(opts.criticalAtStakes) && opts.criticalAtStakes > 0
        ? opts.criticalAtStakes : DEFAULT_CRITICAL_AT_STAKES;
    return { warnAt: warnAt, criticalAt: criticalAt };
}

module.exports = {
    LEVELS,
    LEVEL_RANK,
    ALERT_RANK,
    DEFAULT_WARN_AT_STAKES,
    DEFAULT_CRITICAL_AT_STAKES,
    fmt,
    stakeWord,
    pct,
    normalizeSources,
    emptyResult,
    isAlertLevel,
    marginBands
};
