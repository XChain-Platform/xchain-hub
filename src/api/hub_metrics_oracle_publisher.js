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
 * XChain Hub - oracle publisher scrape series.
 *
 **********************************************************************/

'use strict';

const { installEngineSeries, callIf } = require('./hub_metrics_engine_series');

// Publish progress, dead letters, takeover of a silent leader and unlanded sends.
const ORACLE_PUBLISHER_SERIES = {
    counters: [
        {
            name: 'xchain_oracle_publisher_published_total',
            help: 'Oracle price publishes this hub broadcast',
            read: (publisher) => publisher.publishedCount
        },
        {
            name: 'xchain_oracle_publisher_abandoned_total',
            help: 'Oracle rounds this hub gave up publishing and moved to the dead-letter file',
            read: (publisher) => publisher.abandonedCount
        },
        {
            name: 'xchain_oracle_publisher_takeover_attempts_total',
            help: 'Windows this hub re-assembled to cover a publish leader that went silent',
            read: (publisher) => publisher.takeoverAttempts
        },
        {
            name: 'xchain_oracle_publisher_takeover_published_total',
            help: 'Takeover windows this hub went on to publish',
            read: (publisher) => publisher.takeoverPublished
        },
        {
            name: 'xchain_oracle_publisher_batch_sign_timeouts_total',
            help: 'PRICE batch signing rounds that timed out waiting for co-signatures',
            read: (publisher) => callIf(publisher, 'batchSignTimeouts')
        }
    ],
    gauges: [
        {
            name: 'xchain_oracle_publisher_last_published_round',
            help: 'Last oracle round this hub published; absent until it has published one',
            read: (publisher) => publisher.lastPublishedRound
        },
        {
            name: 'xchain_oracle_publisher_unconfirmed_publishes',
            help: 'Publishes this hub broadcast that have not yet reached a block',
            read: (publisher) => (publisher._pendingConfirmations instanceof Map
                ? publisher._pendingConfirmations.size : null)
        }
    ]
};

/**
 * Register the oracle publisher scrape series on an installed registry.
 *
 * Publish-rail health and leader takeover were visible only through
 * getoraclepublisherstatus. These read in-memory publisher fields and never
 * call its getStats(), which reads the durable queue file.
 *
 * @param {{registry: ?object}} observability  installObservability() handle.
 * @param {{oraclePublisher: ?object}} hub  resolved lazily at scrape time,
 *        since startOracle() runs after the API installs metrics.
 * @returns {boolean} true when the metrics were registered.
 */
function installHubOraclePublisherMetrics(observability, hub){
    const registry = observability && observability.registry;
    if(!registry || !hub) return false;
    installEngineSeries(registry, () => hub.oraclePublisher, ORACLE_PUBLISHER_SERIES);
    return true;
}

module.exports = { installHubOraclePublisherMetrics, ORACLE_PUBLISHER_SERIES };
