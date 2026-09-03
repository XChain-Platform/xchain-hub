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
 * Service-specific Prometheus metrics for xchain-hub (item a98d6746).
 *
 * Lives outside src/observability/ on purpose: that directory is the canonical
 * copy vendored byte-identically into five sibling services, and the parity
 * check across those copies fails on drift, so a hub-only metric may
 * only use the shared module's public API from hub code. It is its own module
 * rather than inline in api.js because api.js self-starts on require, so
 * nothing in it is reachable from a unit test.
 *
 **********************************************************************/

'use strict';

/**
 * Register the hub's oracle-round heartbeat on an installed registry.
 *
 * Oracle-round freshness was observable only through getoraclesubmissions and
 * the /health probe, which are the same DB/RPC path: if that monitoring path
 * silently regresses, a wedged round loop is invisible everywhere. These series
 * give the scrape an independent detector, quorum loss included.
 *
 * Every value is read from live in-memory OracleRound state at scrape time, and
 * none of it touches the DB: Registry.render() is synchronous, so an async read
 * inside a collector would resolve after the response was already written.
 *
 * @param {{registry: ?object}} observability  installObservability() handle; registry is
 *                                            null unless METRICS_ENABLED.
 * @param {{getOracle: function}} hub  resolved LAZILY at scrape time, because
 *                                    startOracle() runs after the API installs
 *                                    observability and a config-only hub never
 *                                    mints an oracle at all.
 * @returns {boolean} true when the metrics were registered.
 */
function installHubOracleMetrics(observability, hub){
    const registry = observability && observability.registry;
    if(!registry || !hub || typeof hub.getOracle !== 'function') return false;

    const lastFinalizedTs = registry.gauge({
        name: 'xchain_oracle_last_finalized_round_timestamp_seconds',
        help: 'Unix time of the last oracle round this hub saw finalized; stops advancing when rounds stop reaching quorum'
    });
    const currentRound = registry.gauge({
        name: 'xchain_oracle_current_round',
        help: 'Oracle round number the round timer last opened; flat means the round loop itself is wedged'
    });
    const skippedStreak = registry.gauge({
        name: 'xchain_oracle_consecutive_skipped_rounds',
        help: 'Trailing streak of oracle rounds that did not finalize'
    });
    // Quorum loss is its own signal, distinct from the skip streak: a round evicted
    // at the finalization timeout never reached commit quorum, whereas a skipped
    // round may simply have had no submissions. OracleConsensus counts both seats
    // into _roundTimeouts (leader eviction and the follower PROPOSE-round timeout).
    const roundTimeouts = registry.counter({
        name: 'xchain_oracle_round_timeouts_total',
        help: 'Oracle rounds evicted before reaching commit quorum, leader and follower seats alike'
    });
    // Source-diversity collapse, and the opposite failure to the two above: the round
    // DID reach quorum and was signed normally, so nothing else here moves, while the
    // federation had only one uncorrelated upstream behind a pair that normally has two
    // and PRICE v0 went out with its outlier rejection gone.
    const singleSourceRounds = registry.counter({
        name: 'xchain_oracle_single_source_rounds_total',
        help: 'Oracle rounds finalized with one uncorrelated price source on a normally-multi-source pair'
    });

    registry.addCollector(() => {
        const oracle = hub.getOracle();
        if(!oracle) return;   // config-only hub: no rounds, so no series rather than a false zero
        // lastSuccessfulRoundTime is stamped by markRoundFinalized on a genuine
        // finalization and rehydrated from price_snapshots on restart, so the
        // series survives a bounce instead of resetting to "just now" and hiding
        // an in-progress outage. Null until the very first finalization: leave
        // the series ABSENT there, since a zero renders as a 1970 timestamp and
        // would page a hub that is merely still starting up.
        if(oracle.lastSuccessfulRoundTime) lastFinalizedTs.set({}, oracle.lastSuccessfulRoundTime / 1000);
        if(Number.isFinite(Number(oracle.currentRound))) currentRound.set({}, Number(oracle.currentRound));
        if(Number.isFinite(Number(oracle.consecutiveSkippedRounds))) {
            skippedStreak.set({}, Number(oracle.consecutiveSkippedRounds));
        }
        // Read through the consensus handle rather than getSubmissionsInfo(), whose
        // round_timeouts field is the same value behind an RPC that also queries the
        // DB; the point of these series is a detector that survives that path failing.
        // setMonotonic, not set: startOracle() mints a fresh OracleConsensus, and a
        // counter that walks backwards breaks every rate() over it.
        const consensus = oracle.oracleConsensus;
        if(consensus && Number.isFinite(Number(consensus._roundTimeouts))) {
            roundTimeouts.setMonotonic({}, Number(consensus._roundTimeouts));
        }
        if(consensus && Number.isFinite(Number(consensus._singleSourceRounds))) {
            singleSourceRounds.setMonotonic({}, Number(consensus._singleSourceRounds));
        }
    });

    return true;
}

// A real, finite reading. Null / undefined / '' are MISSING readings, and
// Number() maps every one of them to 0, so they have to be rejected first.
function isNum(v){
    return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

/**
 * Register the operator's stake share against the STAKE_WEIGHTED_QUORUM commit
 * gate on an installed registry.
 *
 * The oracle series above detect a halt that is ALREADY happening (rounds
 * timing out, the skip streak climbing). These detect the halt that has not
 * happened yet: the two-thirds weighted gate counts community stake in its
 * denominator whether or not that stake ever signs, so the last round before an
 * outage looks exactly like the first round after it stops finalizing. The
 * margin is the only thing that moves in advance, and `stakes_to_halt` is it in
 * the unit that matters - how many more community stakers the size of the
 * biggest one already staked the federation can absorb (a prior outage saw
 * five of eight equal stakes, so the answer was zero and nothing said so).
 *
 * Alert on stakes_to_halt <= 1 or meets_gate == 0. Values are read from the
 * watcher's in-memory monitor at scrape time and touch neither DB nor network,
 * because Registry.render() is synchronous.
 *
 * @param {{registry: ?object}} observability  installObservability() handle.
 * @param {{stakeShareWatcher: ?object}} hub   resolved LAZILY at scrape time; the
 *                                             watcher is minted in startCapabilities().
 * @returns {boolean} true when the metrics were registered.
 */
function installHubStakeShareMetrics(observability, hub){
    const registry = observability && observability.registry;
    if(!registry || !hub) return false;

    const labelNames = ['chain', 'capability'];
    const shareRatio = registry.gauge({
        name: 'xchain_stake_share_ratio',
        help: 'Operator share of source-deduped active stake for a capability (0-1); the weighted commit gate needs the SIGNING share above 2/3',
        labelNames
    });
    const headroom = registry.gauge({
        name: 'xchain_stake_share_headroom',
        help: 'Additional third-party stake this chain/capability can absorb while the two-thirds commit gate stays reachable; negative means it is already lost',
        labelNames
    });
    const stakesToHalt = registry.gauge({
        name: 'xchain_stake_share_stakes_to_halt',
        help: 'New community stakes (each the size of the largest third-party stake already present, floored at MIN_STAKE) needed to push the federation under the weighted commit gate; 1 means the next staker halts rounds, 0 means it already happened',
        labelNames
    });
    const meetsGate = registry.gauge({
        name: 'xchain_stake_share_meets_gate',
        help: '1 when operator stake alone can still clear the two-thirds weighted commit gate for this chain/capability, 0 when it cannot',
        labelNames
    });
    const alerting = registry.gauge({
        name: 'xchain_stake_share_alerting',
        help: '1 when any watched chain/capability sits within one new stake of the weighted commit gate, or under it'
    });

    registry.addCollector(() => {
        const watcher = hub.stakeShareWatcher;
        // No watcher (config-only hub) or no operator sources configured: emit no
        // series at all rather than a zero, which would read as a lost gate and page.
        if(!watcher || !watcher.monitor) return;
        alerting.set({}, watcher.monitor.isAlerting() ? 1 : 0);
        for(const e of watcher.monitor.entries.values()){
            const labels = { chain: e.chain, capability: e.capability };
            // An entry with nothing measured (unavailable / unconfigured) carries
            // nulls. Leave those series ABSENT: a gap is honest about a missing
            // reading, a zero is a false claim that the share collapsed.
            // Null-checked BEFORE Number(), which turns both null and '' into a
            // perfectly finite 0 - the exact false zero this guard exists to avoid.
            if(isNum(e.shareRatio))   shareRatio.set(labels, Number(e.shareRatio));
            if(isNum(e.headroom))     headroom.set(labels, Number(e.headroom));
            if(isNum(e.stakesToHalt)) stakesToHalt.set(labels, Number(e.stakesToHalt));
            if(typeof e.meetsGate === 'boolean') meetsGate.set(labels, e.meetsGate ? 1 : 0);
        }
    });

    return true;
}

module.exports = { installHubOracleMetrics, installHubStakeShareMetrics };
