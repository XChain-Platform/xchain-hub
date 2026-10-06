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
// Validators sharing one address hit the BTC indexer's per-address rate limit
// together. A 429 must be classified apart from other HTTP errors and must
// open a jittered, growing backoff window during which no fetch is sent.

const sinon      = require('sinon');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

const { ConsensusInputMonitor, REASONS, classifyFetchError } =
    require('../../../src/validators/consensus_input_monitor.js');

function makeMonitor(random) {
    const clock = { t: 1000000 };
    const monitor = new ConsensusInputMonitor({
        now: () => clock.t, log: () => {}, random: random || (() => 1),
        backoffBaseMs: 1000, backoffMaxMs: 8000
    });
    return { monitor, clock };
}

function err(status) {
    const e = new Error('status ' + status);
    e.response = { status };
    return e;
}

describe('consensus input 429 backoff', function () {
    describe('monitor', function () {
        it('classifies 429 as rate_limited, not http_error', function () {
            expect(classifyFetchError(err(429))).to.equal(REASONS.RATE_LIMITED);
            expect(classifyFetchError(err(500))).to.equal(REASONS.HTTP_ERROR);
        });

        it('opens a window that closes with the clock', function () {
            const { monitor, clock } = makeMonitor();
            expect(monitor.inBackoff()).to.equal(false);
            monitor.recordFailure('m', REASONS.RATE_LIMITED);
            expect(monitor.inBackoff()).to.equal(true);
            clock.t += 1001;
            expect(monitor.inBackoff()).to.equal(false);
        });

        it('doubles the ceiling per consecutive 429 up to the cap', function () {
            const { monitor, clock } = makeMonitor();
            const waits = [];
            for (let i = 0; i < 6; i++) {
                monitor.recordFailure('m', REASONS.RATE_LIMITED);
                waits.push(monitor.backoffUntil - clock.t);
                clock.t = monitor.backoffUntil;
            }
            expect(waits).to.deep.equal([1000, 2000, 4000, 8000, 8000, 8000]);
        });

        it('jitters within [ceiling/2, ceiling] so hubs diverge', function () {
            const lo = makeMonitor(() => 0), hi = makeMonitor(() => 1);
            lo.monitor.recordFailure('m', REASONS.RATE_LIMITED);
            hi.monitor.recordFailure('m', REASONS.RATE_LIMITED);
            expect(lo.monitor.backoffUntil - lo.clock.t).to.equal(500);
            expect(hi.monitor.backoffUntil - hi.clock.t).to.equal(1000);
        });

        it('does not open a window for other failure reasons', function () {
            const { monitor } = makeMonitor();
            monitor.recordFailure('m', REASONS.HTTP_ERROR);
            monitor.recordFailure('m', REASONS.UNREACHABLE);
            expect(monitor.inBackoff()).to.equal(false);
        });

        it('a success clears the window and restarts the growth', function () {
            const { monitor, clock } = makeMonitor();
            monitor.recordFailure('m', REASONS.RATE_LIMITED);
            monitor.recordFailure('m', REASONS.RATE_LIMITED);
            monitor.recordSuccess('m');
            expect(monitor.inBackoff()).to.equal(false);
            monitor.recordFailure('m', REASONS.RATE_LIMITED);
            expect(monitor.backoffUntil - clock.t).to.equal(1000);
        });

        it('reports the remaining window in the snapshot', function () {
            const { monitor } = makeMonitor();
            expect(monitor.snapshot().backoff_remaining_ms).to.equal(0);
            monitor.recordFailure('m', REASONS.RATE_LIMITED);
            expect(monitor.snapshot().backoff_remaining_ms).to.equal(1000);
        });
    });

    describe('CapabilitySnapshot', function () {
        let axiosStub, snap;
        const hub = {
            resolveBtcIndexerUrl: async () => 'http://indexer.local/rpc',
            btcIndexerHeaders: () => ({})
        };
        const noMinStake = () => ({ ok: true, minStake: null });

        beforeEach(function () {
            axiosStub = { post: sinon.stub() };
            const logStub = { debug() {}, info() {}, warn() {}, error() {} };
            const CapabilitySnapshot = proxyquire('../../../src/validators/capability_snapshot', {
                axios: axiosStub,
                '../observability': { getLogger: () => logStub, '@global': true }
            });
            snap = new CapabilitySnapshot(hub);
            snap.snapshotThreshold = noMinStake;
        });
        afterEach(function () { sinon.restore(); });

        it('sends no further request while backed off after a 429', async function () {
            axiosStub.post.rejects(err(429));
            expect(await snap.getActiveValidatorSnapshot(100)).to.equal(null);
            expect(axiosStub.post.callCount).to.equal(1);
            expect(snap.monitor.byReason.rate_limited).to.equal(1);

            expect(await snap.getActiveValidatorSnapshot(101)).to.equal(null);
            expect(await snap.getActiveWeightSnapshot(101)).to.equal(null);
            expect(await snap.getSnapshot('attestation', 120)).to.equal(null);
            expect(await snap.getWeightSnapshot('attestation', 120)).to.equal(null);
            expect(axiosStub.post.callCount).to.equal(1);
            expect(snap.monitor.failures).to.equal(1);
        });

        it('fetches again once the window has passed', async function () {
            axiosStub.post.onFirstCall().rejects(err(429));
            axiosStub.post.onSecondCall().resolves({ data: { result: {
                block_index: 94, count: 0, validators: [] } } });
            expect(await snap.getActiveValidatorSnapshot(100)).to.equal(null);
            snap.monitor.backoffUntil = 0;
            const res = await snap.getActiveValidatorSnapshot(100);
            expect(res).to.not.equal(null);
            expect(axiosStub.post.callCount).to.equal(2);
        });
    });
});
