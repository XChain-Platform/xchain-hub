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

const { getLogger } = require('../observability');
const logger = getLogger();
// The arithmetic lives in src/validators/stake_share/, pure and logger-free: the
// level taxonomy, the evaluation and the margin score. This file keeps the alarm
// surface and re-exports the arithmetic under its original names.
const { LEVELS, LEVEL_RANK, DEFAULT_WARN_AT_STAKES, DEFAULT_CRITICAL_AT_STAKES,
        normalizeSources, emptyResult, isAlertLevel } = require('./stake_share/levels.js');
const { evaluateStakeShare } = require('./stake_share/evaluate.js');
const { projectCompetingStake } = require('./stake_share/margin.js');

// One loud line per (chain, capability) per window. Five minutes matches the
// watcher's default poll cadence, so a standing alert costs one line per poll
// rather than one per level re-evaluation.
const DEFAULT_THROTTLE_MS = 5 * 60 * 1000;

// The level an entry counts as: a held alert while the snapshot is unreadable,
// otherwise the level it was recorded at.
function effectiveLevel(entry) {
    return entry.heldLevel || entry.level;
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
        this._log = typeof opts.log === 'function' ? opts.log : (msg) => logger.error(msg);
        // key -> { chain, capability, at, ...evaluation }
        this.entries = new Map();
        // key -> ms of the last line printed for this entry
        this._warnAt = {};
    }

    buildKey(chain, capability) {
        return String(chain) + ':' + String(capability);
    }

    // Fold one evaluation in and log the transition. Returns the stored entry.
    record(chain, capability, evaluation) {
        let key  = this.buildKey(chain, capability);
        let now  = this._now();
        let prev = this.entries.get(key);
        let entry = Object.assign({ chain: String(chain), capability: String(capability), at: now }, evaluation);

        // Hold a standing alert through an unreadable snapshot: nothing was re-measured,
        // so the last real reading stands until a real one replaces it. No expiry, which
        // would clear an alert nobody re-measured; /health shows its age as held_age_s.
        let holdStarts = false;
        if (entry.level === LEVELS.UNAVAILABLE && prev && isAlertLevel(effectiveLevel(prev))) {
            holdStarts           = !prev.heldLevel;
            entry.heldLevel      = prev.heldLevel || prev.level;
            entry.heldReason     = prev.heldLevel ? prev.heldReason : prev.reason;
            entry.heldMeasuredAt = prev.heldLevel ? prev.heldMeasuredAt : prev.at;
        }
        this.entries.set(key, entry);

        let was = prev ? effectiveLevel(prev) : null;
        let is  = effectiveLevel(entry);
        let alerting = isAlertLevel(is);

        // A level CHANGE always prints, throttle or not: the transition is the
        // whole signal, and swallowing it inside a window is how a monitor ends
        // up agreeing that everything was fine right up to the outage.
        let changed = was !== is;
        let due     = now - (this._warnAt[key] || 0) > this.throttleMs;

        if (entry.heldLevel) {
            // Say the alert is unconfirmed, never cleared: the read failed, the federation did not recover.
            if (holdStarts || due) {
                this._warnAt[key] = now;
                this._log('STAKE SHARE ' + is.toUpperCase() + ' UNCONFIRMED [' + chain + '/' + capability + ']: ' +
                    'the stake snapshot could not be read, so the last reading (' +
                    Math.round((now - entry.heldMeasuredAt) / 1000) + 's ago) still stands: ' +
                    entry.heldReason + ' Read failure: ' + entry.reason);
            }
        } else if (alerting && (changed || due)) {
            this._warnAt[key] = now;
            this._log('STAKE SHARE ' + is.toUpperCase() + ' [' + chain + '/' + capability + ']: ' + entry.reason);
        } else if (!alerting && isAlertLevel(was)) {
            this._warnAt[key] = now;
            this._log('STAKE SHARE ALERT CLEARED [' + chain + '/' + capability + ']: ' + entry.reason);
        } else if (!alerting && is !== LEVELS.OK && (changed || due)) {
            this._warnAt[key] = now;
            this._log('Stake share ' + is + ' [' + chain + '/' + capability + ']: ' + entry.reason);
        } else if (changed && was !== null) {
            // Announce recovery to ok from warning, unconfigured or unavailable, so every change prints.
            this._warnAt[key] = now;
            this._log('Stake share ' + is + ' [' + chain + '/' + capability + '] (was ' + was + '): ' + entry.reason);
        }
        return entry;
    }

    // The snapshot could not be read this pass. Kept distinct from BLOCKED (a
    // snapshot that WAS read and is unusable) and never raises an alert (record()
    // holds a standing one), because indexer reachability is ConsensusInputMonitor's
    // alarm and double-paging one outage on two surfaces trains operators to mute both.
    recordUnavailable(chain, capability, reason) {
        return this.record(chain, capability,
            Object.assign(emptyResult(LEVELS.UNAVAILABLE, reason)));
    }

    // Worst entry currently held, ranked by its effective level, or null when nothing has been recorded.
    worst() {
        let worst = null;
        for (let e of this.entries.values()) {
            if (!worst || (LEVEL_RANK[effectiveLevel(e)] || 0) > (LEVEL_RANK[effectiveLevel(worst)] || 0)) worst = e;
        }
        return worst;
    }

    // True while any (chain, capability) sits at CRITICAL or worse, a held alert
    // included. Side-effect free, so /health can read it on every probe.
    isAlerting() {
        for (let e of this.entries.values()) if (isAlertLevel(effectiveLevel(e))) return true;
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
                age_s:                   Math.round((now - e.at) / 1000),
                held_level:              e.heldLevel || null,
                held_reason:             e.heldLevel ? e.heldReason : null,
                held_age_s:              e.heldLevel ? Math.round((now - e.heldMeasuredAt) / 1000) : null
            };
        }
        let worstBody = null;
        if (worst) {
            worstBody = { level: effectiveLevel(worst), chain: worst.chain, capability: worst.capability };
            // Flag a worst level that is held rather than measured this pass.
            if (worst.heldLevel) worstBody.held = true;
        }
        return {
            gate:      '3*tally > 2*S (two-thirds of source-deduped active stake)',
            alerting:  this.isAlerting(),
            worst:     worstBody,
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
