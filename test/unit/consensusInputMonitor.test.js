'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// consensus-input fetch failures must ALERT, not merely fail closed in
// silence. Before this, only a 401/403 and a block-echo mismatch logged; an
// unreachable indexer, a JSON-RPC error, a malformed body or an unresolvable
// indexer URL each returned null with no output at all, so a hub that had
// stopped participating in every round looked identical to an idle healthy one.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const { ConsensusInputMonitor, REASONS, classifyFetchError } =
    require('../../src/lib/consensus_input_monitor.js');

describe('ConsensusInputMonitor', function () {

    // Injected clock + log sink: the monitor's throttle and streak are
    // time-based, and a real clock would make these tests either slow or flaky.
    function makeMonitor(opts) {
        const lines = [];
        const clock = { t: 1000000 };
        const monitor = new ConsensusInputMonitor(Object.assign({
            throttleMs: 60000,
            now: () => clock.t,
            log: (msg) => lines.push(msg)
        }, opts || {}));
        return { monitor, lines, clock };
    }

    describe('counting', function () {

        it('counts failures per reason and tracks the consecutive streak', function () {
            const { monitor } = makeMonitor();
            monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE, 'down');
            monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE, 'down');
            monitor.recordFailure('getcapabilityvalidators', REASONS.AUTH, 'key mismatch');

            const snap = monitor.snapshot();
            expect(snap.failures).to.equal(3);
            expect(snap.by_reason).to.deep.equal({ unreachable: 2, auth: 1 });
            expect(snap.consecutive_failures).to.equal(3);
            expect(snap.last_failure.reason).to.equal('auth');
            expect(snap.last_failure.method).to.equal('getcapabilityvalidators');
        });

        it('a success clears the streak but keeps the cumulative counters', function () {
            const { monitor } = makeMonitor();
            monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            monitor.recordSuccess('getactivevalidators');

            const snap = monitor.snapshot();
            expect(snap.ok).to.equal(1);
            expect(snap.failures).to.equal(1);          // cumulative, not reset
            expect(snap.consecutive_failures).to.equal(0);
            expect(snap.streak_age_s).to.equal(null);
            expect(snap.alerting).to.equal(false);
        });

        it('reports the streak age in seconds', function () {
            const { monitor, clock } = makeMonitor();
            monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            clock.t += 90000;
            expect(monitor.snapshot().streak_age_s).to.equal(90);
        });
    });

    describe('alerting', function () {

        it('does NOT alert on a single blip (a rolling indexer restart)', function () {
            const { monitor } = makeMonitor();
            monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            expect(monitor.isAlerting()).to.equal(false);
        });

        it('alerts once the consecutive-failure threshold is crossed', function () {
            const { monitor, lines } = makeMonitor();
            for (let i = 0; i < 3; i++) monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            expect(monitor.isAlerting()).to.equal(true);
            expect(lines.filter(l => l.indexOf('ALERT:') === 0).length).to.equal(1);
            expect(monitor.snapshot().alerting).to.equal(true);
        });

        it('escalates ONCE per outage even when the failure reason rotates', function () {
            // A key rotation mid-outage flips unreachable -> auth. That must not
            // re-page: one outage, one escalation.
            const { monitor, lines } = makeMonitor();
            monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            monitor.recordFailure('getactivevalidators', REASONS.AUTH);
            monitor.recordFailure('getactivevalidators', REASONS.AUTH);
            expect(lines.filter(l => l.indexOf('ALERT:') === 0).length).to.equal(1);
        });

        it('honours a custom threshold', function () {
            const { monitor } = makeMonitor({ alertAfterFailures: 1 });
            monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            expect(monitor.isAlerting()).to.equal(true);
        });

        it('announces recovery so a fixed hub is distinguishable from a stalled one', function () {
            const { monitor, lines } = makeMonitor();
            for (let i = 0; i < 3; i++) monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            monitor.recordSuccess('getactivevalidators');
            expect(lines.filter(l => l.indexOf('ALERT CLEARED:') === 0).length).to.equal(1);
            expect(monitor.isAlerting()).to.equal(false);
        });

        it('does not announce recovery when no alert was raised', function () {
            const { monitor, lines } = makeMonitor();
            monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            monitor.recordSuccess('getactivevalidators');
            expect(lines.filter(l => l.indexOf('ALERT CLEARED:') === 0).length).to.equal(0);
        });

        it('re-alerts on a NEW outage after a recovery', function () {
            const { monitor, lines } = makeMonitor();
            for (let i = 0; i < 3; i++) monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            monitor.recordSuccess('getactivevalidators');
            for (let i = 0; i < 3; i++) monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            expect(lines.filter(l => l.indexOf('ALERT:') === 0).length).to.equal(2);
        });
    });

    describe('log throttling', function () {

        it('logs one line per reason per window', function () {
            const { monitor, lines, clock } = makeMonitor();
            monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            expect(lines.filter(l => l.indexOf('(unreachable)') !== -1).length).to.equal(1);

            clock.t += 60001;
            monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            expect(lines.filter(l => l.indexOf('(unreachable)') !== -1).length).to.equal(2);
        });

        it('one reason never swallows another inside the same window', function () {
            const { monitor, lines } = makeMonitor();
            monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            monitor.recordFailure('getcapabilityvalidators', REASONS.AUTH);
            expect(lines.filter(l => l.indexOf('(unreachable)') !== -1).length).to.equal(1);
            expect(lines.filter(l => l.indexOf('(auth)') !== -1).length).to.equal(1);
        });

        it('sub-keys the window so a second missing capability is not swallowed', function () {
            const { monitor, lines } = makeMonitor();
            monitor.recordFailure('getsnapshot', REASONS.MIN_STAKE, 'attestation has no MIN_STAKE', 'attestation');
            monitor.recordFailure('getsnapshot', REASONS.MIN_STAKE, 'price has no MIN_STAKE', 'price');
            const minStakeLines = lines.filter(l => l.indexOf('(min_stake_unconfigured)') !== -1);
            expect(minStakeLines.length).to.equal(2);
        });

        it('a fresh outage logs immediately instead of inheriting the old window', function () {
            const { monitor, lines } = makeMonitor();
            monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            monitor.recordSuccess('getactivevalidators');
            monitor.recordFailure('getactivevalidators', REASONS.UNREACHABLE);
            expect(lines.filter(l => l.indexOf('(unreachable)') !== -1).length).to.equal(2);
        });
    });

    describe('classifyFetchError()', function () {

        it('separates an auth mismatch from an outage', function () {
            expect(classifyFetchError({ response: { status: 401 } })).to.equal(REASONS.AUTH);
            expect(classifyFetchError({ response: { status: 403 } })).to.equal(REASONS.AUTH);
            expect(classifyFetchError({ response: { status: 500 } })).to.equal(REASONS.HTTP_ERROR);
            expect(classifyFetchError(new Error('ECONNREFUSED'))).to.equal(REASONS.UNREACHABLE);
            expect(classifyFetchError(undefined)).to.equal(REASONS.UNREACHABLE);
        });
    });
});

// -----------------------------------------------------------------
// Fault injection through the real CapabilitySnapshot: every path that
// returns the null "no snapshot" sentinel must reach the monitor. This is
// the regression that matters, because the fail-closed nulls are correct
// and would stay correct while going silent again.
// -----------------------------------------------------------------
describe('CapabilitySnapshot consensus-input alarms', function () {

    let axiosStub, CapabilitySnapshot;

    beforeEach(function () {
        axiosStub = { post: sinon.stub() };
        CapabilitySnapshot = proxyquire('../../src/CapabilitySnapshot', { axios: axiosStub });
        // Silence the loud operator lines; the assertions read the monitor.
        sinon.stub(console, 'error');
    });

    afterEach(function () { sinon.restore(); });

    function makeHub(opts) {
        opts = opts || {};
        return {
            capabilityRegistry: opts.registry || null,
            _resolveBtcIndexerUrl: async () => (opts.url === undefined ? 'http://indexer.local/rpc' : opts.url),
            _btcIndexerHeaders: () => ({})
        };
    }

    function okData(block) {
        return { data: { result: { capability: 'attestation', block_index: block, count: 1,
                                   validators: [{ pubkey: 'ab', amount: '50000' }] } } };
    }

    it('records an unreachable indexer (previously the silent case)', async function () {
        axiosStub.post.rejects(new Error('ECONNREFUSED'));
        const snap = new CapabilitySnapshot(makeHub());

        expect(await snap.getSnapshot('attestation', 106)).to.equal(null);
        expect(snap.monitor.byReason[REASONS.UNREACHABLE]).to.equal(1);
    });

    it('records a JSON-RPC error body', async function () {
        axiosStub.post.resolves({ data: { result: { error: 'boom' } } });
        const snap = new CapabilitySnapshot(makeHub());

        expect(await snap.getActiveValidatorSnapshot(106)).to.equal(null);
        expect(snap.monitor.byReason.rpc_error).to.equal(1);
    });

    it('records a malformed validators field', async function () {
        axiosStub.post.resolves({ data: { result: { capability: 'attestation', block_index: 100, count: 1,
                                                    validators: 'not-an-array' } } });
        const snap = new CapabilitySnapshot(makeHub());

        expect(await snap.getSnapshot('attestation', 106)).to.equal(null);
        expect(snap.monitor.byReason.malformed).to.equal(1);
    });

    it('records a block-echo mismatch', async function () {
        axiosStub.post.resolves(okData(999));
        const snap = new CapabilitySnapshot(makeHub());

        expect(await snap.getSnapshot('attestation', 106)).to.equal(null);
        expect(snap.monitor.byReason.echo_mismatch).to.equal(1);
    });

    it('records an unresolvable indexer URL without ever calling out', async function () {
        const snap = new CapabilitySnapshot(makeHub({ url: '' }));

        expect(await snap.getActiveWeightSnapshot(106)).to.equal(null);
        expect(axiosStub.post.called).to.equal(false);
        expect(snap.monitor.byReason.no_indexer_url).to.equal(1);
    });

    it('records a capability with no configured MIN_STAKE, keyed per capability', async function () {
        const snap = new CapabilitySnapshot(makeHub({ registry: { getMinStake: () => null } }));

        expect(await snap.getSnapshot('attestation', 106)).to.equal(null);
        expect(await snap.getSnapshot('price', 106)).to.equal(null);
        expect(snap.monitor.byReason.min_stake_unconfigured).to.equal(2);
        // Both capabilities get their own line rather than one masking the other.
        const lines = console.error.getCalls().map(c => String(c.args[0]))
            .filter(l => l.indexOf('(min_stake_unconfigured)') !== -1);
        expect(lines.length).to.equal(2);
    });

    it('a fault-injected outage raises the alert after the third failed fetch', async function () {
        // Fault-inject the consensus input and
        // the alert must fire. Distinct methods/heights so the 60s snapshot
        // cache cannot short-circuit any of the three calls.
        axiosStub.post.rejects(new Error('ETIMEDOUT'));
        const snap = new CapabilitySnapshot(makeHub());

        await snap.getSnapshot('attestation', 106);
        expect(snap.monitor.isAlerting()).to.equal(false);
        await snap.getWeightSnapshot('attestation', 101);
        await snap.getActiveValidatorSnapshot(102);

        expect(snap.monitor.isAlerting()).to.equal(true);
        const alerts = console.error.getCalls().map(c => String(c.args[0]))
            .filter(l => l.indexOf('ALERT:') === 0);
        expect(alerts.length).to.equal(1);
        expect(alerts[0]).to.contain('NOT participating');
    });

    it('a successful fetch clears the alert', async function () {
        axiosStub.post.rejects(new Error('ETIMEDOUT'));
        const snap = new CapabilitySnapshot(makeHub());
        await snap.getSnapshot('attestation', 106);
        await snap.getWeightSnapshot('attestation', 101);
        await snap.getActiveValidatorSnapshot(102);
        expect(snap.monitor.isAlerting()).to.equal(true);

        axiosStub.post.resolves(okData(97));                 // 103 - 6 reorg buffer
        expect(await snap.getSnapshot('attestation', 103)).to.not.equal(null);
        expect(snap.monitor.isAlerting()).to.equal(false);
        expect(snap.monitor.snapshot().ok).to.equal(1);
    });

    it('a healthy hub records successes and never alerts', async function () {
        axiosStub.post.resolves(okData(100));
        const snap = new CapabilitySnapshot(makeHub());

        expect(await snap.getSnapshot('attestation', 106)).to.not.equal(null);
        expect(snap.monitor.snapshot().failures).to.equal(0);
        expect(snap.monitor.snapshot().alerting).to.equal(false);
    });

    describe('HUB_CONSENSUS_INPUT_ALERT_AFTER', function () {

        afterEach(function () { delete process.env.HUB_CONSENSUS_INPUT_ALERT_AFTER; });

        it('tunes the threshold', function () {
            process.env.HUB_CONSENSUS_INPUT_ALERT_AFTER = '1';
            const snap = new CapabilitySnapshot(makeHub());
            expect(snap.monitor.alertAfterFailures).to.equal(1);
        });

        it('falls back to the default on a bad value instead of disabling the alarm', function () {
            process.env.HUB_CONSENSUS_INPUT_ALERT_AFTER = '0';
            const snap = new CapabilitySnapshot(makeHub());
            expect(snap.monitor.alertAfterFailures).to.equal(3);

            process.env.HUB_CONSENSUS_INPUT_ALERT_AFTER = 'lots';
            expect(new CapabilitySnapshot(makeHub()).monitor.alertAfterFailures).to.equal(3);
        });
    });
});
