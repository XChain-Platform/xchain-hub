'use strict';


// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
//
// Reorg rollback and retraction signing scrape series: each counter mirrors the
// field the real engine increments, and a hub without either engine renders none.

const { expect } = require('chai');
const { installHubReorgRetractionMetrics } = require('../../../../src/api/hub_metrics');
const { _resetObservability } = require('../../../../src/observability');
const { realObservability, sample } = require('../../../helpers/engine_series');

const REORG_COUNTERS = [
    ['_roundTimeouts', 'xchain_reorg_round_timeouts_total', 3],
    ['_followerRoundTimeouts', 'xchain_reorg_follower_round_timeouts_total', 5],
    ['_rollbacksExecuted', 'xchain_reorg_rollbacks_executed_total', 7],
    ['_rollbackFailures', 'xchain_reorg_rollback_failures_total', 2],
    ['_selfVerifyAbstains', 'xchain_reorg_self_verify_abstains_total', 11]
];

function install(hub){
    const observability = realObservability();
    expect(installHubReorgRetractionMetrics(observability, hub)).to.equal(true);
    return observability.registry;
}

function fakeReorgHandler(){
    const handler = {};
    for(const [field, , value] of REORG_COUNTERS) handler[field] = value;
    return handler;
}

function fakeRetraction(overrides = {}){
    return Object.assign({
        _roundTimeouts: 4,
        unsignedFallbackCount: { round_timeout: 4, out_of_class: 9, no_signing_deps: 1, gate_inactive: 6 },
        _retractionSubmitDeferrals: new Map([['a', {}], ['b', {}]])
    }, overrides);
}

describe('hub reorg and retraction scrape series', function () {
    afterEach(function () {
        _resetObservability();
    });

    it('refuses to install without a registry', function () {
        expect(installHubReorgRetractionMetrics(null, {})).to.equal(false);
        expect(installHubReorgRetractionMetrics({ registry: null }, {})).to.equal(false);
    });

    it('renders neither series while both engines are absent', function () {
        const out = install({}).render();
        expect(out).to.not.match(/^xchain_reorg_/m);
        expect(out).to.not.match(/^xchain_retraction_/m);
    });

    it('renders every reorg count from live fields', function () {
        const out = install({ reorgHandler: fakeReorgHandler() }).render();
        for(const [, name, value] of REORG_COUNTERS) expect(sample(out, name), name).to.equal(value);
    });

    it('renders retraction timeouts, unsigned fallbacks by reason and the deferral gauge', function () {
        const out = install({ retractionConsensus: fakeRetraction() }).render();
        expect(sample(out, 'xchain_retraction_round_timeouts_total')).to.equal(4);
        const fallbacks = 'xchain_retraction_unsigned_fallbacks_total';
        expect(sample(out, fallbacks, '{reason="round_timeout"}')).to.equal(4);
        expect(sample(out, fallbacks, '{reason="out_of_class"}')).to.equal(9);
        expect(sample(out, fallbacks, '{reason="no_signing_deps"}')).to.equal(1);
        expect(sample(out, fallbacks, '{reason="gate_inactive"}')).to.equal(6);
        expect(sample(out, 'xchain_retraction_deferred_rounds')).to.equal(2);
    });

    it('reads no deferrals as zero and a missing fallback table as no series', function () {
        const out = install({
            retractionConsensus: fakeRetraction({ unsignedFallbackCount: undefined, _retractionSubmitDeferrals: undefined })
        }).render();
        expect(sample(out, 'xchain_retraction_deferred_rounds')).to.equal(0);
        expect(sample(out, 'xchain_retraction_unsigned_fallbacks_total', '{reason="round_timeout"}')).to.equal(null);
    });

    it('never walks a counter backwards when the engine is recreated', function () {
        const hub = { reorgHandler: fakeReorgHandler() };
        const registry = install(hub);
        expect(sample(registry.render(), 'xchain_reorg_round_timeouts_total')).to.equal(3);
        hub.reorgHandler = Object.assign(fakeReorgHandler(), { _roundTimeouts: 1 });
        expect(sample(registry.render(), 'xchain_reorg_round_timeouts_total')).to.equal(3);
    });
});
