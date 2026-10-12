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

// The catch-up sweep is the only recurring retry for unpublished price windows, so
// one bad tick must never end it: the re-arm runs whatever the tick did, and a tick
// fired from the timer is caught rather than left as an unhandled rejection.

const {
    sinon,
    expect,
    bufferedFixture,
    makePublisher,
    cleanupPublisherBatch
} = require('./oracle_publisher_batch.test.js');

let logs;

// A backlog count that throws must still re-arm the sweep, at the idle cadence.
const testCase1 = async function () {
    let h = makePublisher({ cfg: { ORACLE_BATCH_CATCHUP_INTERVAL_MS: 3600000,
                                   ORACLE_BATCH_CATCHUP_BACKLOG_INTERVAL_MS: 5 } });
    await h.p.start();
    for (let r = 0; r < 13; r++) h.p._buffer.set(r, bufferedFixture(r));
    sinon.stub(h.p, 'pendingCatchupWindows').throws(new Error('window plan fault'));
    let armed = [];
    sinon.stub(h.p, 'armCatchupSweep').callsFake((ms) => armed.push(ms));
    await h.p.runCatchupSweepTick();
    expect(armed, 'the sweep survives the fault at the idle cadence').to.deep.equal([3600000]);
};

// The same fault after stop() must not bring the sweep back.
const testCase2 = async function () {
    let h = makePublisher({ cfg: { ORACLE_BATCH_CATCHUP_INTERVAL_MS: 3600000,
                                   ORACLE_BATCH_CATCHUP_BACKLOG_INTERVAL_MS: 5 } });
    await h.p.start();
    for (let r = 0; r < 13; r++) h.p._buffer.set(r, bufferedFixture(r));
    sinon.stub(h.p, 'pendingCatchupWindows').throws(new Error('window plan fault'));
    let tick = h.p.runCatchupSweepTick();
    h.p.stop();
    await tick;
    expect(h.p._catchupSweepTimer).to.equal(null);
};

// A rejecting tick fired from the timer is caught and logged, never left unhandled.
const testCase3 = async function () {
    let clock = sinon.useFakeTimers();
    try {
        let h = makePublisher({ cfg: { ORACLE_BATCH_CATCHUP_INTERVAL_MS: 3600000 } });
        // Reject only when the timer fires, so no handler-less window precedes the callback.
        let caught = null;
        sinon.stub(h.p, 'runCatchupSweepTick').callsFake(() => {
            let rejected = Promise.reject(new Error('boom'));
            caught = sinon.spy(rejected, 'catch');
            return rejected;
        });
        h.p.armCatchupSweep(10);
        await clock.tickAsync(10);
        expect(caught && caught.calledOnce, 'the timer callback attaches a handler to the tick').to.equal(true);
        expect(logs.error.join('\n')).to.match(/catch-up sweep tick failed:[\s\S]*boom/);
    } finally {
        clock.restore();
    }
};

function registerSuite1() {
    it('re-arms at the idle cadence even when counting the backlog throws', testCase1);
    it('does not re-arm after stop() even when the backlog count throws', testCase2);
    it('catches a rejecting tick fired from the timer instead of leaving it unhandled', testCase3);
}

function registerOuterSuite() {
    beforeEach(function () {
        logs = { log: [], warn: [], error: [] };
        sinon.stub(console, 'log').callsFake((...args) => logs.log.push(args.join(' ')));
        sinon.stub(console, 'warn').callsFake((...args) => logs.warn.push(args.join(' ')));
        sinon.stub(console, 'error').callsFake((...args) => logs.error.push(args.join(' ')));
    });
    afterEach(function () {
        cleanupPublisherBatch();
    });
    describe('a catch-up sweep tick that faults', registerSuite1);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite);
