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
const { installHubAttestationMetrics } = require('../../../../src/api/hub_metrics');
const { _resetObservability } = require('../../../../src/observability');
const {
    realObservability, sample, sourceUnder, assignsField, definesMethod
} = require('../../../helpers/engine_series');

const NOW = 1754870400000;

// A fake AttestationRound carrying only the fields the collector reads.
function fakeRound(overrides = {}){
    return Object.assign({
        consensus: { roundTimeoutCount: 5 },
        pollRpcErrorCount: 2,
        pollTransportErrorCount: 3,
        pollAuthErrorCount: 1,
        lastPollOkAt: NOW,
        pollUnsuccessfulForMs: () => 42000,
        rounds: new Map([['a', { error: 'fetch failed' }], ['b', {}], ['c', { error: 'x' }]])
    }, overrides);
}

function install(hub){
    const observability = realObservability();
    expect(installHubAttestationMetrics(observability, hub)).to.equal(true);
    return observability.registry;
}

describe('hub attestation scrape series', function () {
    afterEach(function () {
        _resetObservability();
    });

    it('refuses to install without a registry', function () {
        expect(installHubAttestationMetrics(null, {})).to.equal(false);
        expect(installHubAttestationMetrics({ registry: null }, {})).to.equal(false);
    });

    it('renders no attestation series while the round manager is absent', function () {
        const registry = install({ attestationRound: null });
        expect(registry.render()).to.not.match(/^xchain_attestation_/m);
    });

    it('renders quorum loss, poll errors by kind and poll freshness from live fields', function () {
        const out = install({ attestationRound: fakeRound() }).render();
        expect(sample(out, 'xchain_attestation_consensus_timeouts_total')).to.equal(5);
        expect(sample(out, 'xchain_attestation_poll_errors_total', '{kind="rpc"}')).to.equal(2);
        expect(sample(out, 'xchain_attestation_poll_errors_total', '{kind="transport"}')).to.equal(3);
        expect(sample(out, 'xchain_attestation_poll_errors_total', '{kind="auth"}')).to.equal(1);
        expect(sample(out, 'xchain_attestation_last_successful_poll_timestamp_seconds')).to.equal(NOW / 1000);
        expect(sample(out, 'xchain_attestation_poll_unsuccessful_seconds')).to.equal(42);
        expect(sample(out, 'xchain_attestation_failed_rounds')).to.equal(2);
    });

    it('resolves the round manager at scrape time, not at registration', function () {
        const hub = { attestationRound: null };
        const registry = install(hub);
        expect(sample(registry.render(), 'xchain_attestation_consensus_timeouts_total')).to.equal(null);
        hub.attestationRound = fakeRound();
        expect(sample(registry.render(), 'xchain_attestation_consensus_timeouts_total')).to.equal(5);
    });

    it('never walks a counter backwards when the round manager is recreated', function () {
        const hub = { attestationRound: fakeRound() };
        const registry = install(hub);
        registry.render();
        hub.attestationRound = fakeRound({ consensus: { roundTimeoutCount: 1 }, pollRpcErrorCount: 0 });
        const out = registry.render();
        expect(sample(out, 'xchain_attestation_consensus_timeouts_total')).to.equal(5);
        expect(sample(out, 'xchain_attestation_poll_errors_total', '{kind="rpc"}')).to.equal(2);
    });
});

describe('hub attestation scrape series', function () {
    afterEach(function () {
        _resetObservability();
    });

    it('drops a gauge whose reading goes missing instead of serving the last value', function () {
        const round = fakeRound();
        const hub = { attestationRound: round };
        const registry = install(hub);
        registry.render();
        round.lastPollOkAt = null;
        round.pollUnsuccessfulForMs = () => null;
        let out = registry.render();
        expect(sample(out, 'xchain_attestation_last_successful_poll_timestamp_seconds')).to.equal(null);
        expect(sample(out, 'xchain_attestation_poll_unsuccessful_seconds')).to.equal(null);
        hub.attestationRound = null;
        out = registry.render();
        expect(sample(out, 'xchain_attestation_failed_rounds')).to.equal(null);
    });

    it('leaves a series absent when a partly wired round manager lacks its source', function () {
        const out = install({
            attestationRound: fakeRound({ consensus: null, pollUnsuccessfulForMs: undefined, rounds: undefined })
        }).render();
        expect(sample(out, 'xchain_attestation_consensus_timeouts_total')).to.equal(null);
        expect(sample(out, 'xchain_attestation_poll_unsuccessful_seconds')).to.equal(null);
        expect(sample(out, 'xchain_attestation_failed_rounds')).to.equal(null);
        expect(sample(out, 'xchain_attestation_poll_errors_total', '{kind="rpc"}')).to.equal(2);
    });

    it('reads fields directly and never calls the round manager getStats', function () {
        let calls = 0;
        const round = fakeRound({ getStats: () => { calls++; throw new Error('getStats must not run'); } });
        const out = install({ attestationRound: round }).render();
        expect(calls).to.equal(0);
        expect(sample(out, 'xchain_attestation_failed_rounds')).to.equal(2);
    });

    it('reads only fields the real attestation engine assigns', function () {
        const roundSource = sourceUnder('attestation/round');
        for(const field of ['pollRpcErrorCount', 'pollTransportErrorCount', 'pollAuthErrorCount',
            'lastPollOkAt', 'rounds', 'consensus']){
            expect(assignsField(roundSource, field), field).to.equal(true);
        }
        expect(definesMethod(roundSource, 'pollUnsuccessfulForMs')).to.equal(true);
        expect(assignsField(sourceUnder('attestation/consensus'), 'roundTimeoutCount')).to.equal(true);
    });
});
