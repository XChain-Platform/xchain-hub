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
 **********************************************************************/

'use strict';

const { expect } = require('chai');

const { installHubOracleMetrics, installHubStakeShareMetrics } = require('../../src/hubMetrics');
const { StakeShareMonitor, evaluateStakeShare } = require('../../src/lib/stake_share_monitor.js');
const { installObservability }    = require('../../src/observability');

// Real registry from the observability module, not a stub: the claim under test
// is that these series appear on the actual scrape surface.
function realObservability(){
    return installObservability(null, { service: 'xchain-hub', env: { METRICS_ENABLED: 'true' } });
}

describe('hub oracle-round heartbeat metrics (item a98d6746)', function () {

    // The observability registry is process-wide now (one process is one
    // service), so a case asserting a series is ABSENT has to start from a
    // clean registry rather than inheriting the previous case's series.
    afterEach(function () { require('../../src/observability')._resetObservability(); });

    it('renders freshness, round number and skip streak from live oracle state', function () {
        const observability = realObservability();
        const oracle = {
            lastSuccessfulRoundTime:  1754870400000,
            currentRound:             9182,
            consecutiveSkippedRounds: 3
        };
        expect(installHubOracleMetrics(observability, { getOracle: () => oracle })).to.equal(true);

        const out = observability.registry.render();
        expect(out).to.match(/xchain_oracle_last_finalized_round_timestamp_seconds 1754870400\b/);
        expect(out).to.match(/xchain_oracle_current_round 9182\b/);
        expect(out).to.match(/xchain_oracle_consecutive_skipped_rounds 3\b/);
    });

    it('resolves the oracle at scrape time, not at registration', function () {
        // startOracle() runs after the API installs observability, so an oracle
        // captured at registration would be null forever on a real hub.
        const observability = realObservability();
        let oracle = null;
        installHubOracleMetrics(observability, { getOracle: () => oracle });
        expect(observability.registry.render()).to.not.match(/xchain_oracle_current_round \d/);

        oracle = { lastSuccessfulRoundTime: 1754870400000, currentRound: 7, consecutiveSkippedRounds: 0 };
        expect(observability.registry.render()).to.match(/xchain_oracle_current_round 7\b/);
    });

    it('keeps a wedged round loop visible as a frozen series', function () {
        const observability = realObservability();
        const oracle = { lastSuccessfulRoundTime: 1754870400000, currentRound: 7, consecutiveSkippedRounds: 0 };
        installHubOracleMetrics(observability, { getOracle: () => oracle });
        observability.registry.render();
        // The whole signal: a stalled loop stops stamping, so the timestamp stops
        // advancing and time() - <gauge> grows without bound across scrapes.
        expect(observability.registry.render())
            .to.match(/xchain_oracle_last_finalized_round_timestamp_seconds 1754870400\b/);
        oracle.lastSuccessfulRoundTime = 1754870700000;
        expect(observability.registry.render())
            .to.match(/xchain_oracle_last_finalized_round_timestamp_seconds 1754870700\b/);
    });

    it('leaves the freshness series absent until the first finalization', function () {
        const observability = realObservability();
        installHubOracleMetrics(observability, {
            getOracle: () => ({ lastSuccessfulRoundTime: null, currentRound: 0, consecutiveSkippedRounds: 0 })
        });
        // A zero would render as a 1970 timestamp and page a hub that is merely
        // still starting up.
        expect(observability.registry.render())
            .to.not.match(/xchain_oracle_last_finalized_round_timestamp_seconds \d/);
    });

    it('exposes quorum loss off the consensus handle, not the RPC path', function () {
        // The skip streak does not carry this: a skipped round may simply have had
        // no submissions, while a round_timeout means commit quorum was never met.
        const observability = realObservability();
        const oracle = {
            lastSuccessfulRoundTime:  1754870400000,
            currentRound:             11,
            consecutiveSkippedRounds: 0,
            oracleConsensus:          { _roundTimeouts: 4 }
        };
        installHubOracleMetrics(observability, { getOracle: () => oracle });
        expect(observability.registry.render()).to.match(/xchain_oracle_round_timeouts_total 4\b/);
    });

    it('renders a healthy zero rather than an absent quorum-timeout series', function () {
        const observability = realObservability();
        installHubOracleMetrics(observability, {
            getOracle: () => ({ currentRound: 3, consecutiveSkippedRounds: 0, oracleConsensus: { _roundTimeouts: 0 } })
        });
        // Absent would be indistinguishable from a scrape that lost the collector.
        expect(observability.registry.render()).to.match(/xchain_oracle_round_timeouts_total 0\b/);
    });

    it('never walks the quorum-timeout counter backwards when the oracle is re-minted', function () {
        // startOracle() builds a fresh OracleConsensus at zero; a counter that drops
        // makes every rate() over it read as a huge spike.
        const observability = realObservability();
        let consensus = { _roundTimeouts: 6 };
        installHubOracleMetrics(observability, { getOracle: () => ({ oracleConsensus: consensus }) });
        expect(observability.registry.render()).to.match(/xchain_oracle_round_timeouts_total 6\b/);
        consensus = { _roundTimeouts: 0 };
        expect(observability.registry.render()).to.match(/xchain_oracle_round_timeouts_total 6\b/);
    });

    it('leaves the quorum-timeout series alone before the consensus handle is wired', function () {
        // OracleRound.oracleConsensus is null until setConsensus() runs inside
        // startOracle(), so a scrape can land on a half-built oracle.
        const observability = realObservability();
        installHubOracleMetrics(observability, {
            getOracle: () => ({ currentRound: 1, consecutiveSkippedRounds: 0, oracleConsensus: null })
        });
        expect(observability.registry.render()).to.not.match(/xchain_oracle_round_timeouts_total \d/);
    });

    // Source diversity is the opposite failure to a quorum timeout: the round
    // finalized NORMALLY, so every series above stays healthy while PRICE v0 went
    // out with only one uncorrelated upstream behind it.

    it('renders the single-source-round counter beside the quorum-timeout one', function () {
        const observability = realObservability();
        installHubOracleMetrics(observability, {
            getOracle: () => ({
                currentRound: 12, consecutiveSkippedRounds: 0,
                oracleConsensus: { _roundTimeouts: 0, _singleSourceRounds: 5 }
            })
        });
        const out = observability.registry.render();
        expect(out).to.match(/xchain_oracle_single_source_rounds_total 5\b/);
        expect(out).to.match(/xchain_oracle_round_timeouts_total 0\b/);
    });

    it('never walks the single-source counter backwards when the oracle is re-minted', function () {
        const observability = realObservability();
        let consensus = { _roundTimeouts: 0, _singleSourceRounds: 9 };
        installHubOracleMetrics(observability, { getOracle: () => ({ oracleConsensus: consensus }) });
        expect(observability.registry.render()).to.match(/xchain_oracle_single_source_rounds_total 9\b/);
        consensus = { _roundTimeouts: 0, _singleSourceRounds: 0 };
        expect(observability.registry.render()).to.match(/xchain_oracle_single_source_rounds_total 9\b/);
    });

    it('leaves the single-source series alone before the consensus handle is wired', function () {
        const observability = realObservability();
        installHubOracleMetrics(observability, {
            getOracle: () => ({ currentRound: 1, consecutiveSkippedRounds: 0, oracleConsensus: null })
        });
        expect(observability.registry.render()).to.not.match(/xchain_oracle_single_source_rounds_total \d/);
    });

    it('still registers the series on a metrics-off hub, where only the endpoint is gated', function () {
        // Building the registry under METRICS_ENABLED would leave these counters
        // absent on the default fleet, which is every box: nothing could record
        // into them, so enabling metrics later starts from zero history instead
        // of revealing what happened. The endpoint stays the operator's
        // decision; the series do not.
        const off = installObservability(null, { service: 'xchain-hub', env: {} });
        expect(off.enabled).to.equal(false);
        expect(off.registry).to.not.equal(null);
        expect(installHubOracleMetrics(off, { getOracle: () => ({ currentRound: 4, consecutiveSkippedRounds: 0 }) })).to.equal(true);
        expect(off.registry.render()).to.match(/xchain_oracle_current_round 4\b/);
    });

    it('refuses to register without a registry at all', function () {
        expect(installHubOracleMetrics({ registry: null }, { getOracle: () => ({}) })).to.equal(false);
    });
});

describe('hub stake-share metrics', function () {

    afterEach(function () { require('../../src/observability')._resetObservability(); });

    // The monitor is fed directly here: the point of these cases is the scrape
    // surface, and StakeShareWatcher's own suite covers how entries get there.
    function hubWithShare(entries){
        const monitor = new StakeShareMonitor({ log: () => {} });
        for (const e of entries) monitor.record(e.chain, e.capability, evaluateStakeShare(e.input));
        return { hub: { stakeShareWatcher: { monitor } }, monitor };
    }

    const rows = (spec) => spec.map((s, i) => ({ pubkey: 'pk' + i, source: s[0], weight: String(s[1]) }));

    it('renders the share, the headroom and the stakes-to-halt per chain and capability', function () {
        const observability = realObservability();
        const { hub } = hubWithShare([{
            chain: 'BTC', capability: 'price', input: {
                // The prior-outage precursor: 125000 of 175000, one stake from a halt.
                validators: rows([['ours1', 25000], ['ours2', 25000], ['ours3', 25000], ['ours4', 25000],
                                  ['ours5', 25000], ['c1', 25000], ['c2', 25000]]),
                operatorSources: ['ours1', 'ours2', 'ours3', 'ours4', 'ours5'], minStake: '25000'
            }
        }]);
        expect(installHubStakeShareMetrics(observability, hub)).to.equal(true);

        const out = observability.registry.render();
        expect(out).to.match(/xchain_stake_share_stakes_to_halt\{chain="BTC",capability="price"\} 1\b/);
        expect(out).to.match(/xchain_stake_share_meets_gate\{chain="BTC",capability="price"\} 1\b/);
        expect(out).to.match(/xchain_stake_share_headroom\{chain="BTC",capability="price"\} 12500\b/);
        expect(out).to.match(/xchain_stake_share_ratio\{chain="BTC",capability="price"\} 0\.71/);
        expect(out).to.match(/xchain_stake_share_alerting 1\b/);
    });

    it('drops meets_gate to 0 once the federation is under the two-thirds bar', function () {
        const observability = realObservability();
        const { hub } = hubWithShare([{
            chain: 'DOGE', capability: 'price', input: {
                validators: rows([['ours1', 25000], ['c1', 25000]]),
                operatorSources: ['ours1'], minStake: '25000'
            }
        }]);
        installHubStakeShareMetrics(observability, hub);
        const out = observability.registry.render();
        expect(out).to.match(/xchain_stake_share_meets_gate\{chain="DOGE",capability="price"\} 0\b/);
        expect(out).to.match(/xchain_stake_share_stakes_to_halt\{chain="DOGE",capability="price"\} 0\b/);
        expect(out).to.match(/xchain_stake_share_headroom\{chain="DOGE",capability="price"\} -12500\b/);
    });

    it('leaves an unmeasured chain ABSENT rather than reporting a zero share', function () {
        // A zero on these series is indistinguishable from a collapsed share and
        // would page over an unreachable indexer the consensus-input monitor
        // already owns.
        const observability = realObservability();
        const monitor = new StakeShareMonitor({ log: () => {} });
        monitor.recordUnavailable('LTC', 'price', 'no LTC indexer URL');
        installHubStakeShareMetrics(observability, { stakeShareWatcher: { monitor } });
        const out = observability.registry.render();
        expect(out).to.not.match(/xchain_stake_share_ratio\{[^}]*chain="LTC"/);
        expect(out).to.not.match(/xchain_stake_share_meets_gate\{[^}]*chain="LTC"/);
        expect(out).to.match(/xchain_stake_share_alerting 0\b/);
    });

    it('drops a healthy reading once the snapshot becomes unreadable, instead of repeating it', function () {
        // The absent-on-unavailable rule only held for a chain that had NEVER been
        // measured. A registered series survives a skipped set(), so after a failed
        // indexer read every later scrape kept rendering the last healthy sample as
        // a current measurement, meets_gate 1 included.
        const observability = realObservability();
        const { hub, monitor } = hubWithShare([{
            chain: 'BTC', capability: 'price', input: {
                validators: rows([['ours1', 100], ['c1', 10]]),
                operatorSources: ['ours1'], minStake: '10'
            }
        }]);
        installHubStakeShareMetrics(observability, hub);
        const healthy = observability.registry.render();
        expect(healthy).to.match(/xchain_stake_share_meets_gate\{chain="BTC",capability="price"\} 1\b/);
        expect(healthy).to.match(/xchain_stake_share_ratio\{chain="BTC",capability="price"\}/);

        monitor.recordUnavailable('BTC', 'price', 'indexer unreachable');
        const stale = observability.registry.render();
        expect(stale).to.not.match(/xchain_stake_share_meets_gate\{[^}]*chain="BTC"/);
        expect(stale).to.not.match(/xchain_stake_share_ratio\{[^}]*chain="BTC"/);
        expect(stale).to.not.match(/xchain_stake_share_headroom\{[^}]*chain="BTC"/);
        expect(stale).to.not.match(/xchain_stake_share_stakes_to_halt\{[^}]*chain="BTC"/);

        // A chain that IS still measurable keeps rendering across the same scrape,
        // which is what makes the reset a gap rather than a blackout.
        monitor.record('DOGE', 'price', evaluateStakeShare({
            validators: rows([['ours1', 100], ['c1', 10]]), operatorSources: ['ours1'], minStake: '10'
        }));
        const mixed = observability.registry.render();
        expect(mixed).to.match(/xchain_stake_share_meets_gate\{chain="DOGE",capability="price"\} 1\b/);
        expect(mixed).to.not.match(/xchain_stake_share_meets_gate\{[^}]*chain="BTC"/);
    });

    it('stops rendering stake-share series once the hub loses its watcher', function () {
        const observability = realObservability();
        const { hub } = hubWithShare([{
            chain: 'BTC', capability: 'price', input: {
                validators: rows([['ours1', 100], ['c1', 10]]),
                operatorSources: ['ours1'], minStake: '10'
            }
        }]);
        installHubStakeShareMetrics(observability, hub);
        expect(observability.registry.render()).to.match(/xchain_stake_share_alerting 0\b/);
        hub.stakeShareWatcher = null;
        const out = observability.registry.render();
        expect(out).to.not.match(/xchain_stake_share_alerting \d/);
        expect(out).to.not.match(/xchain_stake_share_meets_gate\{/);
    });

    it('resolves the watcher at scrape time, and emits nothing on a config-only hub', function () {
        const observability = realObservability();
        const hub = { stakeShareWatcher: null };
        expect(installHubStakeShareMetrics(observability, hub)).to.equal(true);
        expect(observability.registry.render()).to.not.match(/xchain_stake_share_alerting \d/);

        const monitor = new StakeShareMonitor({ log: () => {} });
        monitor.record('BTC', 'price', evaluateStakeShare({
            validators: rows([['ours1', 100], ['c1', 10]]), operatorSources: ['ours1'], minStake: '10'
        }));
        hub.stakeShareWatcher = { monitor };
        expect(observability.registry.render()).to.match(/xchain_stake_share_alerting 0\b/);
    });

    it('refuses to register without a registry at all', function () {
        expect(installHubStakeShareMetrics({ registry: null }, {})).to.equal(false);
    });
});
