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
    makeDb,
    ME,
    PEER1,
    PEER2,
    readJsonl,
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

// A hub that follows window 1 (ME ranks first of three, so it leads 0, 3, 6...), with
// takeover armed and a batch observed so a takeover timer is a possible outcome.
async function followerHub() {
    let snapshots = [{ round_number: 99, batch: true, status: 'finalized' }];
    for (let r = 0; r < 12; r++) snapshots.push({ round_number: r, status: 'finalized' });
    let h = makePublisher({ publishers: [ME, PEER1, PEER2], db: makeDb({ snapshots: snapshots }),
                            cfg: { ORACLE_PUBLISH_FAILOVER_WINDOW_BLOCKS: '2' } });
    await h.p.start();
    for (let r = 0; r < 12; r++) h.p._buffer.set(r, bufferedFixture(r));
    return h;
}

const testCase4 = async function () {
    let h = await followerHub();
    let release;
    let gate = new Promise(resolve => { release = resolve; });
    let elect = h.p.getActiveOraclePublishPubkeys;
    sinon.stub(h.p, 'getActiveOraclePublishPubkeys').callsFake(async (anchor) => {
        await gate;
        return elect.call(h.p, anchor);
    });
    let assembly = h.p.assembleWindow(1);
    await new Promise(resolve => setImmediate(resolve));
    h.p.stop();
    release();
    await assembly;
    expect(h.p._takeoverTimers.size, 'no takeover timer outlives stop()').to.equal(0);
    expect(h.signer.calls, 'no signing round starts on a stopped publisher').to.have.length(0);
};

const testCase5 = async function () {
    let h = await followerHub();
    h.p.stop();
    h.p.rearmTakeover(1, 1000);
    expect(h.p._takeoverTimers.size).to.equal(0);
    expect(await h.p.runTakeoverAttempt(1)).to.equal(false);
};

const testCase6 = async function () {
    let h = await followerHub();
    expect(h.p.pendingCatchupWindows().length, 'closed windows are waiting (control)').to.be.greaterThan(0);
    h.p.stop();
    expect(h.p.sweepBufferCatchup()).to.equal(0);
    await h.p.assembleWindow(1);
    expect(h.p._assembledWindows.has(1)).to.equal(false);
};

const testCase7 = async function () {
    let h = await followerHub();
    h.p.stop();
    await h.p.start();
    for (let r = 0; r < 12; r++) h.p._buffer.set(r, bufferedFixture(r));
    await h.p.assembleWindow(1);
    expect(h.p._takeoverTimers.has(1), 'the guards key on _stopped, not a sticky flag').to.equal(true);
};

function registerSuite2() {
    it('does not arm a takeover timer from an assembly that was mid-await when stop() ran', testCase4);
    it('does not re-arm or run a takeover after stop()', testCase5);
    it('queues no catch-up assembly and runs no window after stop()', testCase6);
    it('arms takeover normally again after a stop and start cycle', testCase7);
}

function signedWires() {
    return [[0, 1, 2], [3, 4, 5]].map((rounds, index) => ({
        firstRound: rounds[0],
        lastRound: rounds[rounds.length - 1],
        anchor: 800000 + rounds[rounds.length - 1],
        rounds: rounds.map(round => bufferedFixture(round)),
        sigCount: 1,
        compressed: false,
        wire: 'signed-wire-' + index
    }));
}

function queuedEntry(wire, index, count) {
    return {
        round: wire.firstRound,
        batch: {
            windowIndex: 0,
            firstRound: wire.firstRound,
            lastRound: wire.lastRound,
            anchor: wire.anchor,
            rounds: wire.rounds.map(round => round.round),
            sigCount: wire.sigCount,
            compressed: wire.compressed,
            wireIndex: index,
            wireCount: count
        },
        wire: wire.wire
    };
}

async function publisherWithTwoWires() {
    let h = makePublisher();
    await h.p.start();
    for (let r = 0; r < 6; r++) h.p._buffer.set(r, bufferedFixture(r));
    sinon.stub(h.p, 'signWindowWires').resolves(signedWires());
    sinon.stub(h.p, 'processQueue').resolves();
    return h;
}

const testCase8 = async function () {
    let h = await publisherWithTwoWires();
    let rewrite = sinon.stub(h.p, 'rewriteDurableFile').throws(new Error('EIO'));
    let error;
    try { await h.p.assembleWindow(0); } catch (caught) { error = caught; }
    expect(error && error.message).to.equal('EIO');
    expect(h.p._assembledWindows.has(0)).to.equal(false);
    expect(h.p.pendingCatchupWindows()).to.include(0);
    expect(readJsonl(h.queuePath)).to.deep.equal([]);

    rewrite.restore();
    await h.p.assembleWindow(0);
    expect(readJsonl(h.queuePath).map(entry => entry.batch.rounds))
        .to.deep.equal([[0, 1, 2], [3, 4, 5]]);
    expect(h.p._assembledWindows.has(0)).to.equal(true);
};

const testCase9 = async function () {
    let h = await publisherWithTwoWires();
    let original = h.p.rewriteDurableFile.bind(h.p);
    let writes = 0;
    sinon.stub(h.p, 'rewriteDurableFile').callsFake((filePath, text) => {
        writes++;
        original(filePath, text);
        if (writes === 1) throw new Error('late EIO');
    });
    try { await h.p.assembleWindow(0); } catch (error) { /* retry below */ }
    expect(h.p._assembledWindows.has(0)).to.equal(false);

    await h.p.assembleWindow(0);
    expect(writes).to.equal(1);
    expect(readJsonl(h.queuePath).map(entry => entry.batch.rounds))
        .to.deep.equal([[0, 1, 2], [3, 4, 5]]);
    expect(h.p._assembledWindows.has(0)).to.equal(true);
};

const testCase10 = async function () {
    let h = await publisherWithTwoWires();
    sinon.stub(h.p, 'readQueueState').returns(null);
    let error;
    try { await h.p.assembleWindow(0); } catch (caught) { error = caught; }
    expect(error && error.message).to.equal('durable queue is unreadable');
    expect(h.p._assembledWindows.has(0)).to.equal(false);
    expect(readJsonl(h.queuePath)).to.deep.equal([]);
};

const testCase11 = async function () {
    let h = await publisherWithTwoWires();
    let wires = signedWires();
    await h.p.enqueue(queuedEntry(wires[0], 0, wires.length));

    await h.p.assembleWindow(0);

    expect(readJsonl(h.queuePath).map(entry => entry.batch.rounds))
        .to.deep.equal([[0, 1, 2], [3, 4, 5]]);
    expect(h.p._assembledWindows.has(0)).to.equal(true);
};

const testCase12 = async function () {
    let h = await publisherWithTwoWires();
    let wires = signedWires();
    await h.p.enqueue(queuedEntry(wires[0], 0, wires.length));
    h.p._sweeping = true;
    let error;
    try { await h.p.assembleWindow(0); } catch (caught) { error = caught; }
    expect(error && error.message).to.match(/partial window/);
    expect(readJsonl(h.queuePath).map(entry => entry.batch.rounds)).to.deep.equal([[0, 1, 2]]);
    expect(h.p._assembledWindows.has(0)).to.equal(false);
};

function registerSuite3() {
    it('keeps every wire retryable when the atomic window enqueue fails', testCase8);
    it('recognizes a window write that landed before reporting failure', testCase9);
    it('leaves the window unmemoized when the durable queue cannot be read', testCase10);
    it('atomically replaces a legacy partial window when no publish pass is active', testCase11);
    it('does not replace a legacy partial window during an active publish pass', testCase12);
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
    describe('work in flight when stop() runs', registerSuite2);
    describe('a window queue write that faults', registerSuite3);
}

describe('OraclePublisher PRICE batch rail', registerOuterSuite);
