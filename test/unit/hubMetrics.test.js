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

const { installHubOracleMetrics } = require('../../src/hubMetrics');
const { installObservability }    = require('../../src/observability');

// Real registry from the observability module, not a stub: the claim under test
// is that these series appear on the actual scrape surface.
function realObservability(){
    return installObservability(null, { service: 'xchain-hub', env: { METRICS_ENABLED: 'true' } });
}

describe('hub oracle-round heartbeat metrics (item a98d6746)', function () {

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

    it('registers nothing on a metrics-off hub', function () {
        const off = installObservability(null, { service: 'xchain-hub', env: {} });
        expect(off.registry).to.equal(null);
        expect(installHubOracleMetrics(off, { getOracle: () => ({}) })).to.equal(false);
    });
});
