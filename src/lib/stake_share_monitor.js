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
 * XChain Hub - StakeShareMonitor
 *
 * Watches the operator's OWN share of active stake against the
 * STAKE_WEIGHTED_QUORUM commit gate (3*tally > 2*S) and says how much
 * further third-party stake the federation can absorb before that gate
 * stops being reachable.
 *
 * Why this exists: the gate is a two-thirds bar over the summed stake of
 * SIGNING sources, and community stake counts in the denominator whether or
 * not it ever signs. A federation whose own share drifts to 2/3 therefore
 * halts every round the moment one more staker appears, with no round-level
 * warning beforehand: the last good round finalizes normally and the next one
 * simply times out. That is what happened on testnet on 2026-09-01, where five
 * operator stakes of eight equal stakes (62.5%) meant a single new community
 * STAKE ended price rounds for 18 hours and a tester, not a monitor, found it.
 *
 * The margin is stated in STAKES, not in percent, because percent is the wrong
 * unit for the actual risk: the question an operator needs answered is "how many
 * more community stakers can join before we are under the bar". So the headroom
 * is the largest additional third-party stake X that still leaves the gate
 * reachable, and the level is how many stakes fit inside it - sized off the
 * LARGEST third-party stake already on the chain, floored at MIN_STAKE. Sizing
 * that unit at MIN_STAKE alone is what would have called a prior outage comfortable:
 * `price` MIN_STAKE is 1000 while the stakes that actually arrived were 25000.
 *
 * The predicate's own denominator is reused (stake_weighted_quorum.totalStake)
 * rather than re-summed here, so the monitor can never disagree with the gate
 * it is measuring: source dedupe, the truncated-snapshot guard and the
 * malformed-row guards are the consensus-critical ones, not a copy of them.
 *
 * Alerting is deliberately NOT a /health 503. This is a FORECAST about the
 * federation, not a sickness of this process: 503-ing a hub whose DB, oracle
 * and indexer link are all fine would take the config rail down over a
 * condition no restart can fix. The alert channel is the loud log plus the
 * `alerting` flag on /health and the Prometheus gauges built from it.
 *
 ********************************************************************/

'use strict';

const mathjs = require('mathjs');
const { totalStake } = require('../stake_weighted_quorum.js');

// Severity taxonomy. Held as constants so a caller cannot invent a level by
// typo (which would silently fall out of every alert comparison below).
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

// One loud line per (chain, capability) per window. Five minutes matches the
// watcher's default poll cadence, so a standing alert costs one line per poll
// rather than one per level re-evaluation.
const DEFAULT_THROTTLE_MS = 5 * 60 * 1000;

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
// comparison: every threshold decision below is made on exact bignumbers.
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
    const warnAt = Number.isInteger(opts.warnAtStakes) && opts.warnAtStakes > 0
        ? opts.warnAtStakes : DEFAULT_WARN_AT_STAKES;
    const criticalAt = Number.isInteger(opts.criticalAtStakes) && opts.criticalAtStakes > 0
        ? opts.criticalAtStakes : DEFAULT_CRITICAL_AT_STAKES;

    if (configured.length === 0) {
        return emptyResult(LEVELS.UNCONFIGURED,
            'no operator staking sources are configured, so this hub cannot tell its own stake from ' +
            'anyone else\'s. Set HUB_OPERATOR_STAKE_SOURCES (or the per-chain form) to the staking ' +
            'addresses this operator controls.');
    }

    // S, and the malformed/truncated guards, come from the predicate itself.
    // A snapshot it throws on is one meetsStakeThreshold() would fail CLOSED on,
    // which is a halt in its own right, so it is reported rather than swallowed.
    let S;
    try {
        S = totalStake(opts.validators);
    } catch (err) {
        let res = emptyResult(LEVELS.BLOCKED,
            'the stake snapshot is one the quorum predicate fails CLOSED on, so no round over it can ' +
            'finalize regardless of our share: ' + ((err && err.message) || 'unusable snapshot'));
        res.configuredSourceCount = configured.length;
        return res;
    }
    if (S.lte(0)) {
        let res = emptyResult(LEVELS.BLOCKED,
            'total active stake is ' + fmt(S) + ', so the two-thirds gate cannot be expressed and every ' +
            'round fails closed. Either no source qualifies for this capability or the snapshot is empty.');
        res.configuredSourceCount = configured.length;
        res.totalStake = fmt(S);
        res.sourceCount = 0;
        return res;
    }

    // First-wins per source, matching totalStake(): every key of a source carries
    // the same weight, and the rows are already known well-formed because
    // totalStake() would have thrown otherwise.
    let weightBySource = new Map();
    for (let v of opts.validators) {
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

    if (matched.length === 0) {
        // Not "halted": a share of zero here is far more likely a wrong or
        // stale address list than the operator's stake actually being gone, and
        // paging on a config typo teaches an operator to ignore this monitor.
        let res = emptyResult(LEVELS.UNCONFIGURED,
            'none of the ' + configured.length + ' configured operator staking sources appear in this ' +
            'snapshot of ' + weightBySource.size + ' staking sources, so the share cannot be measured. ' +
            'Check the addresses: they are per chain, and a source that has not staked for this ' +
            'capability is not in the set.');
        res.configuredSourceCount    = configured.length;
        res.unmatchedOperatorSources = unmatched;
        res.totalStake               = fmt(S);
        res.sourceCount              = weightBySource.size;
        res.operatorStake            = '0';
        res.otherStake               = fmt(S);
        res.shareRatio               = 0;
        return res;
    }

    // The gate: 3*tally > 2*S, strictly. Our share is an UPPER BOUND on the
    // tally, since a source that does not sign contributes nothing.
    let threeOurs = mathjs.multiply(ours, 3);
    let twoS      = mathjs.multiply(S, 2);
    let meetsGate = threeOurs.gt(twoS);

    // Headroom: the largest additional third-party stake X that still leaves the
    // gate reachable. 3*ours > 2*(S + X)  <=>  X < (3*ours - 2*S) / 2. Positive
    // exactly when the gate holds today, so the two signals cannot disagree.
    let headroom = mathjs.divide(mathjs.subtract(threeOurs, twoS), 2);

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
    let cfgMin = opts.minStake === null || opts.minStake === undefined ? null : String(opts.minStake).trim();
    if (cfgMin !== null && /^\d+\.?\d*$/.test(cfgMin) && mathjs.bignumber(cfgMin).gt(0)) {
        unit = mathjs.bignumber(cfgMin);
        unitFrom = 'min_stake';
    }
    if (observed !== null && (unit === null || observed.gt(unit))) {
        unit = observed;
        unitFrom = observedFrom;
    }

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
    const warnAt = Number.isInteger(args.warnAtStakes) && args.warnAtStakes > 0
        ? args.warnAtStakes : DEFAULT_WARN_AT_STAKES;
    const criticalAt = Number.isInteger(args.criticalAtStakes) && args.criticalAtStakes > 0
        ? args.criticalAtStakes : DEFAULT_CRITICAL_AT_STAKES;

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

// True when a level is one an operator must act on.
function isAlertLevel(level) {
    return (LEVEL_RANK[level] || 0) >= ALERT_RANK;
}

/**
 * Alarm surface over evaluateStakeShare(), one entry per (chain, capability).
 *
 * Owns the log throttle, the level-transition lines and the `alerting` flag that
 * /health and the Prometheus gauges read. Nothing here talks to the network: the
 * watcher feeds it, so the whole alert path is unit-testable without an indexer.
 */
class StakeShareMonitor {

    // opts.now / opts.log are injected by tests only; production uses the real
    // clock and console.error (the hub has no pager integration, so the loud log
    // plus the scraped gauge ARE the alert channel).
    constructor(opts) {
        opts = opts || {};
        this.throttleMs = Number.isFinite(opts.throttleMs) ? opts.throttleMs : DEFAULT_THROTTLE_MS;
        this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
        this._log = typeof opts.log === 'function' ? opts.log : (msg) => console.error(msg);
        // key -> { chain, capability, at, ...evaluation }
        this.entries = new Map();
        // key -> ms of the last line printed for this entry
        this._warnAt = {};
    }

    _key(chain, capability) {
        return String(chain) + ':' + String(capability);
    }

    // Fold one evaluation in and log the transition. Returns the stored entry.
    record(chain, capability, evaluation) {
        let key  = this._key(chain, capability);
        let now  = this._now();
        let prev = this.entries.get(key);
        let entry = Object.assign({ chain: String(chain), capability: String(capability), at: now }, evaluation);
        this.entries.set(key, entry);

        let was = prev ? prev.level : null;
        let is  = entry.level;
        let alerting = isAlertLevel(is);

        // A level CHANGE always prints, throttle or not: the transition is the
        // whole signal, and swallowing it inside a window is how a monitor ends
        // up agreeing that everything was fine right up to the outage.
        let changed = was !== is;
        let due     = now - (this._warnAt[key] || 0) > this.throttleMs;

        if (alerting && (changed || due)) {
            this._warnAt[key] = now;
            this._log('STAKE SHARE ' + is.toUpperCase() + ' [' + chain + '/' + capability + ']: ' + entry.reason);
        } else if (!alerting && isAlertLevel(was)) {
            this._warnAt[key] = now;
            this._log('STAKE SHARE ALERT CLEARED [' + chain + '/' + capability + ']: ' + entry.reason);
        } else if (!alerting && is !== LEVELS.OK && (changed || due)) {
            this._warnAt[key] = now;
            this._log('Stake share ' + is + ' [' + chain + '/' + capability + ']: ' + entry.reason);
        }
        return entry;
    }

    // The snapshot could not be read this pass. Kept distinct from BLOCKED (a
    // snapshot that WAS read and is unusable) and non-alerting, because indexer
    // reachability is already ConsensusInputMonitor's alarm and double-paging one
    // outage on two surfaces trains operators to mute both.
    recordUnavailable(chain, capability, reason) {
        return this.record(chain, capability,
            Object.assign(emptyResult(LEVELS.UNAVAILABLE, reason)));
    }

    // Worst entry currently held, or null when nothing has been recorded.
    worst() {
        let worst = null;
        for (let e of this.entries.values()) {
            if (!worst || (LEVEL_RANK[e.level] || 0) > (LEVEL_RANK[worst.level] || 0)) worst = e;
        }
        return worst;
    }

    // True while any (chain, capability) sits at CRITICAL or worse. Side-effect
    // free, so /health can read it on every probe.
    isAlerting() {
        for (let e of this.entries.values()) if (isAlertLevel(e.level)) return true;
        return false;
    }

    // Body-only telemetry for /health. Deliberately reports counts rather than the
    // configured address list: the numbers are what an operator acts on, and the
    // unmatched addresses are already named in the throttled log line.
    snapshot() {
        let now = this._now();
        let worst = this.worst();
        let chains = {};
        for (let e of this.entries.values()) {
            if (!chains[e.chain]) chains[e.chain] = {};
            chains[e.chain][e.capability] = {
                level:                   e.level,
                reason:                  e.reason,
                total_stake:             e.totalStake,
                operator_stake:          e.operatorStake,
                share:                   e.shareRatio,
                meets_gate:              e.meetsGate,
                headroom:                e.headroom,
                unit_stake:              e.unitStake,
                unit_stake_from:         e.unitStakeFrom,
                stakes_to_halt:          e.stakesToHalt,
                source_count:            e.sourceCount,
                operator_source_count:   e.operatorSourceCount,
                configured_source_count: e.configuredSourceCount,
                age_s:                   Math.round((now - e.at) / 1000)
            };
        }
        return {
            gate:      '3*tally > 2*S (two-thirds of source-deduped active stake)',
            alerting:  this.isAlerting(),
            worst:     worst ? { level: worst.level, chain: worst.chain, capability: worst.capability } : null,
            chains:    chains
        };
    }
}

module.exports = {
    StakeShareMonitor,
    evaluateStakeShare,
    projectCompetingStake,
    normalizeSources,
    isAlertLevel,
    LEVELS,
    LEVEL_RANK,
    DEFAULT_THROTTLE_MS,
    DEFAULT_WARN_AT_STAKES,
    DEFAULT_CRITICAL_AT_STAKES
};
