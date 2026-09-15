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
// scheduler self-overlap (TOCTOU) guards.
//
// Five hub loops poll on a bare setInterval while their pass awaits network I/O
// whose duration nothing here bounds, so a slow dependency lets the next interval
// fire on top of the previous pass. Each pass then re-reads shared state the
// in-flight pass has not written yet, and both act on it. The reference fix is
// FullNodeChallengeRound._tick (its own tests live in FullNodeChallengeRound.test.js).
//
// Every test below DRIVES the overlap (parks the first pass on a gate, fires the
// second) and asserts the work that would have been duplicated did not happen. The
// paired test proves the finally releases: a pass that rejects must leave the loop
// able to run again, since only the timer ever clears the flag.

const sinon             = require('sinon');
const { expect }        = require('chai');
const fs                = require('fs');
const os                = require('os');
const path              = require('path');
const EventEmitter      = require('events');
const proxyquire        = require('proxyquire');
const { createMockHub } = require('../helpers/mockHub');

// Warm the mathjs/bcmath require cache once, OUTSIDE any timed hook (mathjs is large
// and the first load on the Parallels share can exceed a 5s hook timeout).
require('mathjs');
require('../../src/bcmath.js');

// Park a caller until release() is called.
function makeGate() {
    let release;
    const gate = new Promise((res) => { release = res; });
    return { gate, release: () => release() };
}

// Yield the event loop so a parked pass reaches its first await.
function flush() {
    return new Promise((res) => setImmediate(res));
}

// ── XChainHub.runOwnCapabilityCheck ────────────────────────────────────────

describe('XChainHub.runOwnCapabilityCheck overlap guard', function () {

    let hub, runAllSelfTests, broadcast;

    beforeEach(function () {
        const XChainHub = require('../../src/XChainHub');
        hub = new XChainHub('h', 1, 'd', 'u', 'p', null);
        broadcast       = sinon.stub();
        runAllSelfTests = sinon.stub().resolves();
        hub.peerManager = { broadcast };
        hub.identity    = { getPubkeyHex: () => 'pk' };
        hub.capabilityRegistry = {
            runAllSelfTests,
            getCapabilities: () => ['llm'],
            isActive:        async () => true,
            getState:        async () => null
        };
    });

    afterEach(function () {
        sinon.restore();
    });

    it('a re-check firing on top of an in-flight pass is skipped', async function () {
        const { gate, release } = makeGate();
        let first = true;
        runAllSelfTests.callsFake(async () => { if (first) { first = false; await gate; } });

        const a = hub.runOwnCapabilityCheck('pk');   // parks inside runAllSelfTests
        await flush();
        await hub.runOwnCapabilityCheck('pk');       // the interval (or config watch) fires on top

        expect(runAllSelfTests.callCount, 'the second pass never re-ran the self-tests').to.equal(1);
        expect(broadcast.callCount, 'the second pass broadcast nothing').to.equal(0);

        release();
        await a;
        expect(broadcast.callCount, 'exactly one capability broadcast per capability').to.equal(1);
        expect(hub._capabilityCheckRunning, 'flag released in finally').to.equal(false);
    });

    it('a rejected self-test pass does not wedge the re-check loop', async function () {
        runAllSelfTests.rejects(new Error('capability module blew up'));
        await hub.runOwnCapabilityCheck('pk').catch(() => {});
        expect(hub._capabilityCheckRunning, 'a failed pass must not wedge the timer').to.equal(false);

        runAllSelfTests.resolves();
        await hub.runOwnCapabilityCheck('pk');
        expect(broadcast.callCount, 'the next pass runs normally').to.equal(1);
    });
});

// ── XChainHub.pollOwnStake ─────────────────────────────────────────────────

describe('XChainHub.pollOwnStake overlap guard', function () {

    let hub, axiosStub, refreshOwnQualification;

    beforeEach(function () {
        axiosStub = { post: sinon.stub().resolves({ data: { result: { amount: '1', block_index: 5 } } }) };
        const XChainHub = proxyquire('../../src/XChainHub', { axios: axiosStub });
        hub = new XChainHub('h', 1, 'd', 'u', 'p', null);
        refreshOwnQualification     = sinon.stub().resolves();
        hub.refreshOwnQualification = refreshOwnQualification;
        hub.btcIndexerHeaders      = () => ({});
        hub._resolveBtcIndexerUrl   = async () => 'http://indexer.test';
    });

    afterEach(function () {
        sinon.restore();
    });

    it('a stake poll firing on top of an in-flight poll is skipped', async function () {
        const { gate, release } = makeGate();
        let first = true;
        hub._resolveBtcIndexerUrl = async () => {
            if (first) { first = false; await gate; }
            return 'http://indexer.test';
        };

        const a = hub.pollOwnStake('pk');            // parks before the indexer round-trip
        await flush();
        await hub.pollOwnStake('pk');                // the interval fires on top

        expect(axiosStub.post.callCount, 'the second pass never hit the indexer').to.equal(0);

        release();
        await a;
        expect(axiosStub.post.callCount, 'exactly one indexer round-trip').to.equal(1);
        expect(refreshOwnQualification.callCount, 'qualification refreshed once').to.equal(1);
        expect(hub._stakePollRunning, 'flag released in finally').to.equal(false);
    });

    it('a rejected stake poll does not wedge the poll loop', async function () {
        hub._resolveBtcIndexerUrl = async () => { throw new Error('config lookup failed'); };
        await hub.pollOwnStake('pk').catch(() => {});
        expect(hub._stakePollRunning, 'a failed poll must not wedge the timer').to.equal(false);

        hub._resolveBtcIndexerUrl = async () => 'http://indexer.test';
        await hub.pollOwnStake('pk');
        expect(refreshOwnQualification.callCount, 'the next poll runs normally').to.equal(1);
    });
});

// ── XChainHub.refreshTransportSignerSet ────────────────────────────────────

// The sharper half of this one is not duplicated work but ORDER. Each pass resolves
// the BTC tip at its own start, so two passes in flight can finish out of order and
// the older one's validator snapshot lands last, dropping a just-rotated key from
// transport auth until the next tick.

{

    const NEWER = 'ab'.repeat(32);

    const OLDER = 'cd'.repeat(32);

    let hub, setEffectiveSignerSet, snapshot;

    async function aRefreshFiringOnTopOfTest11() {
        const { gate, release } = makeGate();
        let first = true;
        hub._resolveBtcLatestBlock = async () => {
            if (first) { first = false; await gate; return 100; }
            return 200;
        };

        const a = hub.refreshTransportSignerSet();   // parks before the snapshot round-trip
        await flush();
        await hub.refreshTransportSignerSet();       // the interval fires on top

        expect(snapshot.callCount, 'the second pass never asked for a snapshot').to.equal(0);

        release();
        await a;
        expect(snapshot.callCount, 'exactly one snapshot round-trip').to.equal(1);
        expect(setEffectiveSignerSet.callCount, 'the effective set is written once').to.equal(1);
        expect(hub._transportSetRefreshRunning, 'flag released in finally').to.equal(false);

        // And the loop still works on the next tick, with the newer block's set.
        await hub.refreshTransportSignerSet();
        expect(setEffectiveSignerSet.lastCall.args[0].has(NEWER), 'the later tick writes the newer set').to.equal(true);
    }

    async function aRejectedRefreshDoesNotWedgeTest12() {
        hub._resolveBtcLatestBlock = async () => { throw new Error('BTC tip lookup failed'); };
        await hub.refreshTransportSignerSet().catch(() => {});
        expect(hub._transportSetRefreshRunning, 'a failed refresh must not wedge the timer').to.equal(false);

        hub._resolveBtcLatestBlock = async () => 200;
        await hub.refreshTransportSignerSet();
        expect(setEffectiveSignerSet.callCount, 'the next refresh runs normally').to.equal(1);
    }

    async function anUnresolvedTipReleasesTheFlagTest13() {
        hub._resolveBtcLatestBlock = async () => null;
        await hub.refreshTransportSignerSet();
        expect(setEffectiveSignerSet.callCount, 'no set is written on an unresolved tip').to.equal(0);
        expect(hub._transportSetRefreshRunning, 'the early return still clears the flag').to.equal(false);
    }

    function xchainhubRefreshtransportsignersetOverlapGuardSuite10() {
        beforeEach(function () {
            const XChainHub = require('../../src/XChainHub');
            hub = new XChainHub('h', 1, 'd', 'u', 'p', null);
            setEffectiveSignerSet = sinon.stub();
            hub.peerManager = { setEffectiveSignerSet };
            // Older block, older validator set: the block a pass resolved decides the set it
            // would write, which is what makes an out-of-order write visible here.
            snapshot = sinon.stub().callsFake(async (block) => ({
                validators: [{ pubkey: block >= 200 ? NEWER : OLDER }]
            }));
            hub.capabilitySnapshot = { getActiveValidatorSnapshot: snapshot };
        });
        afterEach(function () {
            sinon.restore();
        });
        it('a refresh firing on top of an in-flight refresh is skipped', aRefreshFiringOnTopOfTest11);
        it('a rejected refresh does not wedge the refresh loop', aRejectedRefreshDoesNotWedgeTest12);
        it('an unresolved tip releases the flag without writing the set', anUnresolvedTipReleasesTheFlagTest13);
    }

    describe('XChainHub.refreshTransportSignerSet overlap guard', xchainhubRefreshtransportsignersetOverlapGuardSuite10);

}

// ── OraclePublisher._processQueue ───────────────────────────────────────────
//
// Not a timer: this pass is driven per PBFT event (onRoundFinalized awaits it), so
// the overlap arrives when two rounds finalize inside one pass duration, which is
// what a consensus backlog draining after a partition looks like. Every at-most-once
// check in the pass closes only AFTER the awaited broadcast, and the pre-send intent
// write is deliberately idempotent, so an unguarded second pass re-broadcasts the
// round the first is still sending: a duplicate DOGE spend, not a duplicate log line.

{

    const OraclePublisher = require('../../src/oracle/publisher');

    const MY_PUB = 'aa'.repeat(32);

    let queueFile;

    function makePublisher() {
        const hub = {
            db:                 null,
            getIdentity:        () => ({ getPubkeyHex: () => MY_PUB, sign: () => 'bb'.repeat(64) }),
            p2pConfig:          {},
            oracleConsensus:    null,
            capabilitySnapshot: null
        };
        const pub = new OraclePublisher(hub);
        pub.queuePath      = queueFile;
        pub.deadLetterPath = queueFile.replace(/\.jsonl$/, '') + '.deadletter.jsonl';
        pub.encoder        = null;      // no balance source, so the floor gate is inert
        return pub;
    }

    function entry(round) {
        return {
            round:          round,
            btcBlockHeight: 900000 + round,
            btcBlockTime:   1750000000,
            prices:         [{ pair: 'BTC/USD', price: '100000' }],
            sigs:           [{ pubkey: MY_PUB, sig: 'ee'.repeat(64) }],
            attempts:       0,
            enqueuedAt:     Date.now()
        };
    }

    function writeQueue(entries) {
        fs.writeFileSync(queueFile, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
    }

    function readQueue() {
        return fs.readFileSync(queueFile, 'utf8').split('\n').filter(l => l.trim().length > 0).map(l => JSON.parse(l));
    }

    async function aSecondFinalizedRoundArrivingMidTest15() {
        const pub = makePublisher();
        writeQueue([entry(7)]);

        const { gate, release } = makeGate();
        let first = true;
        const bcast = sinon.stub().callsFake(async () => {
            if (first) { first = false; await gate; }
            return { txid: 'tx-7' };
        });
        pub.setBroadcastHook(bcast);

        const a = pub._processQueue();
        await flush();
        await pub._processQueue();      // the next round:finalized pass, while a is parked
        expect(bcast.callCount, 'the guarded pass spent no DOGE').to.equal(1);

        release();
        await a;
        expect(bcast.callCount, 'round 7 is broadcast exactly once').to.equal(1);
        expect(pub._sweeping, 'flag released in finally').to.equal(false);
    }

    async function aRoundEnqueuedWhileAPassTest16() {
        // onRoundFinalized APPENDS before it calls the pass, so the new round is on
        // disk but not in the in-flight pass's snapshot. A rewrite that truncates to
        // that snapshot erases it, and the overlap guard makes the case reachable
        // rather than rarer (the skipped pass leaves the round for the next one).
        const pub = makePublisher();
        writeQueue([entry(7)]);

        const { gate, release } = makeGate();
        const bcast = sinon.stub().callsFake(async () => { await gate; return { txid: 'tx-7' }; });
        pub.setBroadcastHook(bcast);

        const a = pub._processQueue();
        await flush();
        await pub._enqueue(entry(8));
        await pub._processQueue();      // skipped by the guard
        release();
        await a;

        expect(readQueue().map(e => e.round), 'the mid-pass round is still queued').to.deep.equal([8]);
        expect(bcast.callCount, 'only the snapshot round was broadcast').to.equal(1);
    }

    async function aRejectedPassReleasesTheGuardTest17() {
        const pub = makePublisher();
        writeQueue([entry(7)]);
        const balance = sinon.stub(pub, 'checkBalance').rejects(new Error('balance source exploded'));

        await pub._processQueue().catch(() => {});
        expect(pub._sweeping, 'a rejected pass must not wedge the publish path').to.equal(false);

        balance.resolves(null);
        const bcast = sinon.stub().resolves({ txid: 'tx-7' });
        pub.setBroadcastHook(bcast);
        await pub._processQueue();
        expect(bcast.callCount, 'the next pass publishes normally').to.equal(1);
    }

    function oraclepublisherProcessqueueOverlapGuardSuite14() {
        beforeEach(function () {
            queueFile = path.join(os.tmpdir(), 'oracleq-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.jsonl');
        });
        afterEach(function () {
            sinon.restore();
            try { fs.unlinkSync(queueFile); } catch (_) {}
            try { fs.unlinkSync(queueFile.replace(/\.jsonl$/, '') + '.deadletter.jsonl'); } catch (_) {}
        });
        it('a second finalized round arriving mid-broadcast does not re-broadcast the round in flight', aSecondFinalizedRoundArrivingMidTest15);
        it('a round enqueued while a pass is in flight survives the queue rewrite', aRoundEnqueuedWhileAPassTest16);
        it('a rejected pass releases the guard instead of wedging the publisher', aRejectedPassReleasesTheGuardTest17);
    }

    describe('OraclePublisher._processQueue overlap guard', oraclepublisherProcessqueueOverlapGuardSuite14);

}
