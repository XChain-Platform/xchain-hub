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
 * XChain Hub - attestation scrape series.
 *
 **********************************************************************/

'use strict';

const { installEngineSeries, isNum, callIf } = require('./hub_metrics_engine_series');

// One cause of poll failure as a label value of the shared poll-errors counter.
function pollErrorSpec(kind, field){
    return {
        name: 'xchain_attestation_poll_errors_total',
        help: 'Attestation request polls that failed, by cause: rpc rejection, transport failure or auth refusal',
        labels: { kind },
        read: (round) => round[field]
    };
}

// Consensus quorum loss and poll health, read off AttestationRound's fields.
const ATTESTATION_SERIES = {
    counters: [
        {
            name: 'xchain_attestation_consensus_timeouts_total',
            help: 'Attestation rounds torn down by the consensus timeout before reaching quorum',
            read: (round) => round.consensus && round.consensus.roundTimeoutCount
        },
        pollErrorSpec('rpc', 'pollRpcErrorCount'),
        pollErrorSpec('transport', 'pollTransportErrorCount'),
        pollErrorSpec('auth', 'pollAuthErrorCount')
    ],
    gauges: [
        {
            name: 'xchain_attestation_last_successful_poll_timestamp_seconds',
            help: 'Unix time of the last usable attestation request poll; absent until one succeeds',
            read: (round) => (isNum(round.lastPollOkAt) ? Number(round.lastPollOkAt) / 1000 : null)
        },
        {
            name: 'xchain_attestation_poll_unsuccessful_seconds',
            help: 'Seconds since the last usable attestation poll, or since the first attempt when none has succeeded',
            read: (round) => {
                const ms = callIf(round, 'pollUnsuccessfulForMs');
                return isNum(ms) ? Number(ms) / 1000 : null;
            }
        },
        {
            name: 'xchain_attestation_failed_rounds',
            help: 'Attestation rounds this hub failed to fetch locally that are still inside the round retention window',
            read: countFailedRounds
        }
    ]
};

// Local fetch failures among the retained rounds (the map evicts on a TTL).
function countFailedRounds(round){
    if(!(round.rounds instanceof Map)) return null;
    let failed = 0;
    for(const entry of round.rounds.values()){
        if(entry && entry.error) failed++;
    }
    return failed;
}

/**
 * Register the attestation scrape series on an installed registry.
 *
 * Attestation quorum loss and a request feed that admits nothing were visible
 * only through getattestationstats. These series give the scrape its own
 * detector for both, read from in-memory AttestationRound fields.
 *
 * @param {{registry: ?object}} observability  installObservability() handle.
 * @param {{attestationRound: ?object}} hub  resolved lazily at scrape time,
 *        since the round manager starts after the API installs metrics.
 * @returns {boolean} true when the metrics were registered.
 */
function installHubAttestationMetrics(observability, hub){
    const registry = observability && observability.registry;
    if(!registry || !hub) return false;
    installEngineSeries(registry, () => hub.attestationRound, ATTESTATION_SERIES);
    return true;
}

module.exports = { installHubAttestationMetrics, ATTESTATION_SERIES };
