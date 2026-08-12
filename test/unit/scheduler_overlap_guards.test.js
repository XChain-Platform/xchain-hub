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
// Four hub loops poll on a bare setInterval while their pass awaits network I/O
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

// ── CrossChainDexEngine._discoverAndMatch ───────────────────────────────────

describe('CrossChainDexEngine._discoverAndMatch overlap guard', function () {

    let CrossChainDexEngine, axiosStub;

    function makeEngine() {
        axiosStub = { post: sinon.stub() };
        CrossChainDexEngine = proxyquire('../../src/CrossChainDexEngine', { axios: axiosStub });
        const hub = createMockHub();
        hub.db = { doQuery: sinon.stub().resolves([]) };
        hub.capabilitySnapshot = null;
        hub.hubDbBroadcaster   = null;
        const eng = new CrossChainDexEngine(hub);
        for (const coin of Object.keys(eng.indexers)) eng.indexers[coin] = { url: 'http://idx/' + coin, key: '' };
        eng.minConfirmations = { BTC: 1, LTC: 1, DOGE: 1 };
        return eng;
    }

    // A crossing SWAP pair: one match per pass, so a duplicated pass is visible as a
    // second _finalizeMatch on the SAME offers.
    function book(coin) {
        const base = {
            home_network: 'mainnet', give_tick: 'XCH', get_tick: 'XCH',
            give_ownership: 0, get_ownership: 0, give_decimals: 8, block_index: 10
        };
        if (coin === 'BTC') return { network: 'mainnet', latest_block_index: 20, orders: [Object.assign({
            action_index: 1, give_coin: 'BTC', give_amount: '100', get_coin: 'LTC', get_amount: '500',
            get_address: 'ltc1abc' }, base)] };
        if (coin === 'LTC') return { network: 'mainnet', latest_block_index: 20, orders: [Object.assign({
            action_index: 2, give_coin: 'LTC', give_amount: '500', get_coin: 'BTC', get_amount: '100',
            get_address: 'bc1xyz' }, base)] };
        return { network: 'mainnet', latest_block_index: 20, orders: [] };
    }

    afterEach(function () { sinon.restore(); });

    it('a pass firing while the books are still loading proposes nothing', async function () {
        const eng = makeEngine();
        const finalize = sinon.stub(eng, '_finalizeMatch').resolves();
        const { gate, release } = makeGate();

        // A slow indexer: the first pass is still awaiting its books when the poll fires again.
        let first = true;
        eng._fetchOpenOffers = async (coin) => {
            if (first) { first = false; await gate; }
            return book(coin);
        };

        const a = eng._discoverAndMatch();
        await flush();
        const b = eng._discoverAndMatch();      // fires while a is parked on the gate
        await b;
        expect(finalize.callCount, 'the guarded pass proposed nothing').to.equal(0);

        release();
        await a;
        expect(finalize.callCount, 'the crossing pair is matched exactly once').to.equal(1);
        expect(eng._matching, 'flag released in finally').to.equal(false);

        // And the loop still works on the next poll.
        await eng._discoverAndMatch();
        expect(finalize.callCount, 'a later poll runs normally').to.equal(2);
    });

    it('a rejected book fetch does not wedge matching forever', async function () {
        const eng = makeEngine();
        const finalize = sinon.stub(eng, '_finalizeMatch').resolves();
        // _resolveSnapshotBlock is awaited inside _finalizeMatch; the throw we want comes
        // from _findMatches, which runs after the books land and is not caught per-coin.
        eng._fetchOpenOffers = async (coin) => book(coin);
        const boom = sinon.stub(eng, '_findMatches').throws(new Error('matcher blew up'));

        let threw = false;
        try { await eng._discoverAndMatch(); } catch (e) { threw = true; }
        expect(threw, 'the poll wrapper swallows this, the method still rejects').to.equal(true);
        expect(eng._matching, 'a rejected pass must not wedge the poll').to.equal(false);

        boom.restore();
        await eng._discoverAndMatch();
        expect(finalize.callCount, 'the next poll matches normally').to.equal(1);
    });
});

// ── AttestationSpotChecker._schedulerTick ───────────────────────────────────

describe('AttestationSpotChecker._schedulerTick overlap guard', function () {

    const AttestationSpotChecker = require('../../src/AttestationSpotChecker');

    function makeChecker(injector) {
        const hub = {
            p2pConfig: {
                SPOT_CHECK_ENABLED: '1',
                SPOT_CHECK_CORPUS: JSON.stringify([
                    { providerId: 'http_get', prompt: 'https://example.com/a', expectedPattern: 'ok' }
                ])
            },
            attestationConsensus: new EventEmitter(),
            spotCheckInjector: injector
        };
        return new AttestationSpotChecker(hub, { getModule: () => null });
    }

    afterEach(function () { sinon.restore(); });

    it('a tick firing while an injection is in flight injects nothing', async function () {
        const { gate, release } = makeGate();
        let calls = 0;
        const checker = makeChecker(async () => {
            calls++;
            if (calls === 1) await gate;
            return { requestId: 'aa'.repeat(31) + String(calls).padStart(2, '0') };
        });

        const a = checker._schedulerTick();
        await flush();
        const b = await checker._schedulerTick();   // fires while a is parked on the gate
        expect(b, 'the guarded tick injected nothing').to.equal(0);
        expect(calls, 'the injector was not called a second time').to.equal(1);

        release();
        expect(await a, 'the first tick injected its one request').to.equal(1);
        expect(checker._tickInFlight, 'flag released in finally').to.equal(false);
        expect(checker._queue.size, 'exactly one spot-check registered').to.equal(1);
    });

    it('a rejected injection does not wedge the scheduler', async function () {
        let calls = 0;
        const checker = makeChecker(async () => {
            calls++;
            if (calls === 1) throw new Error('encoder down');
            return { requestId: 'bb'.repeat(32) };
        });

        expect(await checker._schedulerTick(), 'failed injection counts nothing').to.equal(0);
        expect(checker._tickInFlight, 'flag released after a failed injection').to.equal(false);
        expect(await checker._schedulerTick(), 'the next tick still injects').to.equal(1);
    });
});

// ── AttestationPublisher._processQueue ──────────────────────────────────────

describe('AttestationPublisher._processQueue overlap guard', function () {

    const AttestationPublisher = require('../../src/AttestationPublisher');
    const MY_PUB = 'aa'.repeat(32);
    const RID    = 'cc'.repeat(32);

    let queueFile;

    function makePublisher() {
        const hub = {
            getIdentity: () => ({ getPubkeyHex: () => MY_PUB }),
            p2pConfig: {},
            attestationConsensus: null,
            capabilitySnapshot: { getSnapshot: async () => ({ validators: [{ pubkey: MY_PUB }] }) },
            _resolveBtcIndexerUrl: async () => 'http://indexer.local/rpc',
            _btcIndexerHeaders: () => ({})
        };
        const pub = new AttestationPublisher(hub);
        pub.queuePath = queueFile;
        return pub;
    }

    function writeQueue(entries) {
        fs.writeFileSync(queueFile, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
    }

    function leaderEntry() {
        return {
            ts: Date.now() - 10 * 60000,      // old enough that the leader retry is eligible
            requestId: RID,
            wire: 'ATTEST|1|' + RID + '|http_get|Zm9v|ok||1|' + MY_PUB + '|' + 'ee'.repeat(64),
            responsible: [MY_PUB],
            leaderPubkey: MY_PUB
        };
    }

    beforeEach(function () {
        queueFile = path.join(os.tmpdir(), 'xc1250-attq-' + process.pid + '-' + Math.floor(Math.random() * 1e9) + '.jsonl');
    });

    afterEach(function () {
        sinon.restore();
        try { fs.unlinkSync(queueFile); } catch (_) {}
    });

    it('a sweep firing while the pending set is still loading spends nothing', async function () {
        const pub   = makePublisher();
        const bcast = sinon.stub().resolves({ txid: 'replay-txid' });
        pub.setBroadcastHook(bcast);
        writeQueue([leaderEntry()]);

        // A slow indexer: the first sweep is still paging the pending set when the
        // 30s failover poll fires again. Both sweeps read the same queue FILE.
        const { gate, release } = makeGate();
        let first = true;
        sinon.stub(pub, '_fetchPendingRequestIds').callsFake(async () => {
            if (first) { first = false; await gate; }
            return new Set([RID.toLowerCase()]);
        });

        const a = pub._processQueue();
        await flush();
        await pub._processQueue();          // fires while a is parked on the gate
        expect(bcast.callCount, 'the guarded sweep spent no BTC fee').to.equal(0);

        release();
        await a;
        expect(bcast.callCount, 'the finalized response is broadcast exactly once').to.equal(1);
        expect(pub._sweeping, 'flag released in finally').to.equal(false);
    });

    it('a rejected pending-set fetch does not wedge the sweep', async function () {
        const pub   = makePublisher();
        const bcast = sinon.stub().resolves({ txid: 'replay-txid' });
        pub.setBroadcastHook(bcast);
        writeQueue([leaderEntry()]);

        const fetchStub = sinon.stub(pub, '_fetchPendingRequestIds').rejects(new Error('indexer exploded'));
        await pub._processQueue().catch(() => {});     // start()'s wrapper swallows this
        expect(pub._sweeping, 'a rejected sweep must not wedge the failover poll').to.equal(false);

        fetchStub.resolves(new Set([RID.toLowerCase()]));
        await pub._processQueue();
        expect(bcast.callCount, 'the next sweep replays normally').to.equal(1);
    });
});

// ── OracleRound._executeRound ───────────────────────────────────────────────

describe('OracleRound._executeRound overlap guard', function () {

    let hub, pm, or, OracleRound, fetchPrices, clock;

    beforeEach(function () {
        fetchPrices = sinon.stub().resolves([{ coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }]);
        OracleRound = proxyquire('../../src/OracleRound', {
            './PriceFetcher': function () { return { fetchPrices: (...a) => fetchPrices(...a) }; }
        });
        hub = createMockHub({ p2pConfig: { ORACLE_ROUND_INTERVAL: '60000', ORACLE_SUBMISSION_WINDOW: '30000' } });
        pm  = hub._peerManager;
        or  = new OracleRound(hub);
    });

    afterEach(function () {
        if (clock) { clock.restore(); clock = null; }
        sinon.restore();
        if (or.finalizationTimers) { for (let t of or.finalizationTimers.values()) clearTimeout(t); or.finalizationTimers.clear(); }
    });

    it('the next round tick is skipped while the previous round is still fetching prices', async function () {
        // Only Date is faked, so setImmediate still drives the parked round forward.
        clock = sinon.useFakeTimers({ now: or.epochStart + 1000, toFake: ['Date'] });

        const { gate, release } = makeGate();
        let first = true;
        fetchPrices = async () => {
            if (first) { first = false; await gate; }
            return [{ coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }];
        };

        const a = or._executeRound();           // round 0
        await flush();
        clock.tick(60000);                      // wall clock crosses into round 1
        await or._executeRound();               // the interval fires on top of round 0

        expect(or.currentRound, 'the in-flight round was not renumbered').to.equal(0);
        expect(or.lastExecutedRound, 'the skipped round did not claim a number').to.equal(0);
        expect(pm.broadcast.callCount, 'the guarded round broadcast nothing').to.equal(0);

        release();
        await a;
        expect(pm.broadcast.callCount, 'exactly one submission was broadcast').to.equal(1);
        expect(pm.broadcast.firstCall.args[1].round, 'stamped with the round it actually ran').to.equal(0);
        expect(or.submissions.has(1), 'nothing was recorded against the skipped round').to.equal(false);
        expect(or._roundInFlight, 'flag released in finally').to.equal(false);
    });

    it('a rejected price fetch does not wedge the oracle', async function () {
        clock = sinon.useFakeTimers({ now: or.epochStart + 1000, toFake: ['Date'] });

        fetchPrices = sinon.stub().rejects(new Error('all price APIs down'));
        await or._executeRound();               // caught internally: the round is recorded as skipped
        expect(or._roundInFlight, 'a failed fetch must not wedge the round timer').to.equal(false);

        fetchPrices = sinon.stub().resolves([{ coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }]);
        clock.tick(60000);
        await or._executeRound();
        expect(pm.broadcast.callCount, 'the next round runs normally').to.equal(1);
    });
});

// ── XChainHub._runOwnCapabilityCheck ────────────────────────────────────────

describe('XChainHub._runOwnCapabilityCheck overlap guard', function () {

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

        const a = hub._runOwnCapabilityCheck('pk');   // parks inside runAllSelfTests
        await flush();
        await hub._runOwnCapabilityCheck('pk');       // the interval (or config watch) fires on top

        expect(runAllSelfTests.callCount, 'the second pass never re-ran the self-tests').to.equal(1);
        expect(broadcast.callCount, 'the second pass broadcast nothing').to.equal(0);

        release();
        await a;
        expect(broadcast.callCount, 'exactly one capability broadcast per capability').to.equal(1);
        expect(hub._capabilityCheckRunning, 'flag released in finally').to.equal(false);
    });

    it('a rejected self-test pass does not wedge the re-check loop', async function () {
        runAllSelfTests.rejects(new Error('capability module blew up'));
        await hub._runOwnCapabilityCheck('pk').catch(() => {});
        expect(hub._capabilityCheckRunning, 'a failed pass must not wedge the timer').to.equal(false);

        runAllSelfTests.resolves();
        await hub._runOwnCapabilityCheck('pk');
        expect(broadcast.callCount, 'the next pass runs normally').to.equal(1);
    });
});

// ── XChainHub._pollOwnStake ─────────────────────────────────────────────────

describe('XChainHub._pollOwnStake overlap guard', function () {

    let hub, axiosStub, refreshOwnQualification;

    beforeEach(function () {
        axiosStub = { post: sinon.stub().resolves({ data: { result: { amount: '1', block_index: 5 } } }) };
        const XChainHub = proxyquire('../../src/XChainHub', { axios: axiosStub });
        hub = new XChainHub('h', 1, 'd', 'u', 'p', null);
        refreshOwnQualification     = sinon.stub().resolves();
        hub.refreshOwnQualification = refreshOwnQualification;
        hub._btcIndexerHeaders      = () => ({});
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

        const a = hub._pollOwnStake('pk');            // parks before the indexer round-trip
        await flush();
        await hub._pollOwnStake('pk');                // the interval fires on top

        expect(axiosStub.post.callCount, 'the second pass never hit the indexer').to.equal(0);

        release();
        await a;
        expect(axiosStub.post.callCount, 'exactly one indexer round-trip').to.equal(1);
        expect(refreshOwnQualification.callCount, 'qualification refreshed once').to.equal(1);
        expect(hub._stakePollRunning, 'flag released in finally').to.equal(false);
    });

    it('a rejected stake poll does not wedge the poll loop', async function () {
        hub._resolveBtcIndexerUrl = async () => { throw new Error('config lookup failed'); };
        await hub._pollOwnStake('pk').catch(() => {});
        expect(hub._stakePollRunning, 'a failed poll must not wedge the timer').to.equal(false);

        hub._resolveBtcIndexerUrl = async () => 'http://indexer.test';
        await hub._pollOwnStake('pk');
        expect(refreshOwnQualification.callCount, 'the next poll runs normally').to.equal(1);
    });
});
