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
const { installHubOraclePublisherMetrics } = require('../../../../src/api/hub_metrics');
const { _resetObservability } = require('../../../../src/observability');
const {
    realObservability, sample, sourceUnder, assignsField, definesMethod
} = require('../../../helpers/engine_series');

// Engine field -> the counter series that mirrors it, with the fake's value.
const COUNTERS = [
    ['publishedCount', 'xchain_oracle_publisher_published_total', 40],
    ['abandonedCount', 'xchain_oracle_publisher_abandoned_total', 2],
    ['takeoverAttempts', 'xchain_oracle_publisher_takeover_attempts_total', 5],
    ['takeoverPublished', 'xchain_oracle_publisher_takeover_published_total', 3]
];

// A fake OraclePublisher carrying only the fields the collector reads.
function fakePublisher(overrides = {}){
    const publisher = {
        lastPublishedRound: 9182,
        _pendingConfirmations: new Map([['tx1', {}], ['tx2', {}]]),
        batchSignTimeouts: () => 6
    };
    for(const [field, , value] of COUNTERS) publisher[field] = value;
    return Object.assign(publisher, overrides);
}

function install(hub){
    const observability = realObservability();
    expect(installHubOraclePublisherMetrics(observability, hub)).to.equal(true);
    return observability.registry;
}

describe('hub oracle publisher scrape series', function () {
    afterEach(function () {
        _resetObservability();
    });

    it('refuses to install without a registry', function () {
        expect(installHubOraclePublisherMetrics(null, {})).to.equal(false);
        expect(installHubOraclePublisherMetrics({ registry: null }, {})).to.equal(false);
    });

    it('renders no publisher series while the publisher is absent', function () {
        expect(install({ oraclePublisher: null }).render()).to.not.match(/^xchain_oracle_publisher_/m);
    });

    it('renders publish progress, takeover and unlanded sends from live fields', function () {
        const out = install({ oraclePublisher: fakePublisher() }).render();
        for(const [, name, value] of COUNTERS) expect(sample(out, name), name).to.equal(value);
        expect(sample(out, 'xchain_oracle_publisher_batch_sign_timeouts_total')).to.equal(6);
        expect(sample(out, 'xchain_oracle_publisher_last_published_round')).to.equal(9182);
        expect(sample(out, 'xchain_oracle_publisher_unconfirmed_publishes')).to.equal(2);
    });

    it('never walks a counter backwards when the publisher is recreated', function () {
        const hub = { oraclePublisher: fakePublisher() };
        const registry = install(hub);
        registry.render();
        hub.oraclePublisher = fakePublisher({ publishedCount: 0, batchSignTimeouts: () => 0 });
        const out = registry.render();
        expect(sample(out, 'xchain_oracle_publisher_published_total')).to.equal(40);
        expect(sample(out, 'xchain_oracle_publisher_batch_sign_timeouts_total')).to.equal(6);
    });
});

describe('hub oracle publisher scrape series', function () {
    afterEach(function () {
        _resetObservability();
    });

    it('drops a gauge whose reading goes missing instead of serving the last value', function () {
        const publisher = fakePublisher();
        const hub = { oraclePublisher: publisher };
        const registry = install(hub);
        registry.render();
        publisher.lastPublishedRound = null;
        let out = registry.render();
        expect(sample(out, 'xchain_oracle_publisher_last_published_round')).to.equal(null);
        hub.oraclePublisher = null;
        out = registry.render();
        expect(sample(out, 'xchain_oracle_publisher_unconfirmed_publishes')).to.equal(null);
    });

    it('never calls the publisher getStats, which reads the durable queue file', function () {
        let calls = 0;
        let queueReads = 0;
        const publisher = fakePublisher({
            getStats: () => { calls++; throw new Error('getStats must not run'); },
            readQueue: () => { queueReads++; throw new Error('readQueue must not run'); }
        });
        const out = install({ oraclePublisher: publisher }).render();
        expect(calls).to.equal(0);
        expect(queueReads).to.equal(0);
        expect(sample(out, 'xchain_oracle_publisher_published_total')).to.equal(40);
    });

    it('reads only fields the real publisher assigns', function () {
        const source = sourceUnder('oracle/publisher');
        const fields = COUNTERS.map(([field]) => field).concat(['lastPublishedRound', '_pendingConfirmations']);
        for(const field of fields) expect(assignsField(source, field), field).to.equal(true);
        expect(definesMethod(source, 'batchSignTimeouts')).to.equal(true);
    });
});
