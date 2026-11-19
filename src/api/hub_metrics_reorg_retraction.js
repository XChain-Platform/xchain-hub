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
 * XChain Hub - reorg rollback and retraction signing scrape series.
 *
 **********************************************************************/

'use strict';

const { installEngineSeries } = require('./hub_metrics_engine_series');

function countSpec(name, help, field){
    return { name, help, read: (engine) => engine[field] };
}

function unsignedFallbackSpec(reason){
    return {
        name: 'xchain_retraction_unsigned_fallbacks_total',
        help: 'Retractions this hub broadcast without a quorum signature, by reason; round_timeout is a signing round that lost quorum',
        labels: { reason },
        read: (engine) => engine.unsignedFallbackCount && engine.unsignedFallbackCount[reason]
    };
}

// Reorg rollback rounds that lose quorum, rollbacks run or failed, and claims declined.
const REORG_SERIES = {
    counters: [
        countSpec('xchain_reorg_round_timeouts_total',
            'Reorg rollback rounds this hub led that timed out below quorum', '_roundTimeouts'),
        countSpec('xchain_reorg_follower_round_timeouts_total',
            'Reorg rollback rounds this hub joined from a PREPARE that timed out below quorum',
            '_followerRoundTimeouts'),
        countSpec('xchain_reorg_rollbacks_executed_total',
            'Reorg rollbacks this hub completed', '_rollbacksExecuted'),
        countSpec('xchain_reorg_rollback_failures_total',
            'Reorg rollbacks that reached quorum but threw while executing', '_rollbackFailures'),
        countSpec('xchain_reorg_self_verify_abstains_total',
            'Reorg claims this hub declined to co-sign because its own node did not confirm them',
            '_selfVerifyAbstains')
    ],
    gauges: []
};

// Retraction signing rounds that lose quorum and the deferrals still waiting to open.
const RETRACTION_SERIES = {
    counters: [
        countSpec('xchain_retraction_round_timeouts_total',
            'Retraction signing rounds this hub opened that timed out below quorum', '_roundTimeouts'),
        unsignedFallbackSpec('round_timeout'),
        unsignedFallbackSpec('out_of_class'),
        unsignedFallbackSpec('no_signing_deps'),
        unsignedFallbackSpec('gate_inactive')
    ],
    gauges: [
        {
            name: 'xchain_retraction_deferred_rounds',
            help: 'Retractions waiting for a snapshot block or validator set before a signing round can open',
            read: (engine) => (engine._retractionSubmitDeferrals ? engine._retractionSubmitDeferrals.size : 0)
        }
    ]
};

/**
 * Register the reorg rollback and retraction signing scrape series.
 *
 * Both engines drop their work with a warn line and an event nothing listens
 * to when a round loses quorum; these read the in-memory counts they keep and
 * never touch the database.
 *
 * @param {{registry: ?object}} observability  installObservability() handle.
 * @param {{reorgHandler: ?object, retractionConsensus: ?object}} hub  each
 *        resolved lazily at scrape time, since both start after the API
 *        installs metrics.
 * @returns {boolean} true when the metrics were registered.
 */
function installHubReorgRetractionMetrics(observability, hub){
    const registry = observability && observability.registry;
    if(!registry || !hub) return false;
    installEngineSeries(registry, () => hub.reorgHandler, REORG_SERIES);
    installEngineSeries(registry, () => hub.retractionConsensus, RETRACTION_SERIES);
    return true;
}

module.exports = { installHubReorgRetractionMetrics, REORG_SERIES, RETRACTION_SERIES };
