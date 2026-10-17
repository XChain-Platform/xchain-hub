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
const { installHubCheckpointMetrics } = require('../../../../src/api/hub_metrics');
const { _resetObservability } = require('../../../../src/observability');
const { realObservability, sample, sourceUnder, assignsField } = require('../../../helpers/engine_series');

// Engine field -> the counter series that mirrors it, with the fake's value.
const COUNTERS = [
    ['_roundTimeouts', 'xchain_checkpoint_round_timeouts_total', 7],
    ['_subQuorumFinalized', 'xchain_checkpoint_sub_quorum_finalized_total', 4],
    ['_malformedFinalized', 'xchain_checkpoint_malformed_finalized_total', 1],
    ['_seqConflicts', 'xchain_checkpoint_seq_conflicts_total', 2],
    ['_seqDoubleSignRefusals', 'xchain_checkpoint_seq_double_sign_refusals_total', 3],
    ['_cadenceStalls', 'xchain_checkpoint_cadence_stalls_total', 9],
    ['_roundFailures', 'xchain_checkpoint_round_failures_total', 5],
    ['_selfAcceptFailures', 'xchain_checkpoint_self_accept_failures_total', 6]
];

// A fake StateCheckpointEngine carrying only the fields the collector reads.
function fakeEngine(overrides = {}){
    const engine = {
        _cadenceStallReason: 'capability unqualified',
        _observerIdle: false,
        _notMySlotTicks: 12,
        _frozenTipTicks: 60
    };
    for(const [field, , value] of COUNTERS) engine[field] = value;
    return Object.assign(engine, overrides);
}

function install(hub){
    const observability = realObservability();
    expect(installHubCheckpointMetrics(observability, hub)).to.equal(true);
    return observability.registry;
}

describe('hub state checkpoint scrape series', function () {
    afterEach(function () {
        _resetObservability();
    });

    it('refuses to install without a registry', function () {
        expect(installHubCheckpointMetrics(null, {})).to.equal(false);
        expect(installHubCheckpointMetrics({ registry: null }, {})).to.equal(false);
    });

    it('renders no checkpoint series while the engine is absent', function () {
        expect(install({}).render()).to.not.match(/^xchain_checkpoint_/m);
    });

    it('renders every lifetime count and the cadence state from live fields', function () {
        const out = install({ stateCheckpoints: fakeEngine() }).render();
        for(const [, name, value] of COUNTERS) expect(sample(out, name), name).to.equal(value);
        expect(sample(out, 'xchain_checkpoint_cadence_stalled')).to.equal(1);
        expect(sample(out, 'xchain_checkpoint_observer_idle')).to.equal(0);
        expect(sample(out, 'xchain_checkpoint_frozen_tip_ticks')).to.equal(12);
        expect(sample(out, 'xchain_checkpoint_frozen_tip_stall_ticks')).to.equal(60);
    });

    it('reads a cleared stall as zero and an observer hold as one', function () {
        const out = install({
            stateCheckpoints: fakeEngine({ _cadenceStallReason: null, _observerIdle: true })
        }).render();
        expect(sample(out, 'xchain_checkpoint_cadence_stalled')).to.equal(0);
        expect(sample(out, 'xchain_checkpoint_observer_idle')).to.equal(1);
    });

    it('never walks a counter backwards when the engine is recreated', function () {
        const hub = { stateCheckpoints: fakeEngine() };
        const registry = install(hub);
        registry.render();
        hub.stateCheckpoints = fakeEngine({ _roundTimeouts: 0, _cadenceStalls: 1 });
        const out = registry.render();
        expect(sample(out, 'xchain_checkpoint_round_timeouts_total')).to.equal(7);
        expect(sample(out, 'xchain_checkpoint_cadence_stalls_total')).to.equal(9);
    });
});

describe('hub state checkpoint scrape series', function () {
    afterEach(function () {
        _resetObservability();
    });

    it('drops a gauge whose reading goes missing instead of serving the last value', function () {
        const engine = fakeEngine();
        const hub = { stateCheckpoints: engine };
        const registry = install(hub);
        registry.render();
        engine._notMySlotTicks = null;
        engine._observerIdle = undefined;
        let out = registry.render();
        expect(sample(out, 'xchain_checkpoint_frozen_tip_ticks')).to.equal(null);
        expect(sample(out, 'xchain_checkpoint_observer_idle')).to.equal(null);
        hub.stateCheckpoints = null;
        out = registry.render();
        expect(sample(out, 'xchain_checkpoint_cadence_stalled')).to.equal(null);
    });

    it('never calls the engine getStats, which is async and reads the database', function () {
        let calls = 0;
        const engine = fakeEngine({ getStats: () => { calls++; throw new Error('getStats must not run'); } });
        const out = install({ stateCheckpoints: engine }).render();
        expect(calls).to.equal(0);
        expect(sample(out, 'xchain_checkpoint_round_timeouts_total')).to.equal(7);
    });

    it('reads only fields the real checkpoint engine assigns', function () {
        const source = sourceUnder('anchor/checkpoint_engine');
        const fields = COUNTERS.map(([field]) => field)
            .concat(['_cadenceStallReason', '_observerIdle', '_notMySlotTicks', '_frozenTipTicks']);
        for(const field of fields) expect(assignsField(source, field), field).to.equal(true);
    });
});
