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
// scheduleFinalization and the round-number anchor: a federated leader must
// refuse to lock a price snapshot at the round-number stand-in, the same height
// its followers refuse in a PROPOSE, while a single-node hub keeps the fallback.

const sinon             = require('sinon');
const { expect }        = require('chai');
const proxyquire        = require('proxyquire');
const ChainTips         = require('../../../../src/hub/chain_tips');
const { createMockHub } = require('../../../helpers/mockHub');
const { waitUntil }     = require('../../../helpers/waitUntil');

let or;
const PUSHED_HEIGHT = 900000;
const DIRECT_HEIGHT = 900050;

function tipAged(ageHours) {
    return {
        blockHeight: PUSHED_HEIGHT,
        blockTime: Math.floor(Date.now() / 1000) - ageHours * 60 * 60
    };
}

// Build a round with a short submission window and a stubbed consensus engine.
function arm(quorum, height, fallbackActive) {
    or.submissionWindow = 10;
    or.roundInterval    = 60000;
    or.chainTipFallbackActive = fallbackActive;
    or.lastSuccessfulChainTipFetchAt = Date.now();
    or.currentBtcBlockHeight = height;
    let consensus = {
        finalizeRound:     sinon.stub().resolves(),
        storeSkippedRound: sinon.stub().resolves(),
        getQuorum:         () => quorum
    };
    or.oracleConsensus = consensus;
    return consensus;
}

// Resolve once the round's finalization timer has either finalized or skipped it.
function timerFired(consensus) {
    return waitUntil(() => consensus.finalizeRound.called || consensus.storeSkippedRound.called,
        { label: 'the finalization timer' });
}

function registerAnchorSkipHooks() {
    beforeEach(function () {
        const OracleRound = proxyquire('../../../../src/oracle/round', {
            './price_fetcher': function () { return { fetchPrices: sinon.stub().resolves([]) }; }
        });
        or = new OracleRound(createMockHub({
            p2pConfig: { ORACLE_ROUND_INTERVAL: '60000', ORACLE_SUBMISSION_WINDOW: '30000' }
        }));
    });

    afterEach(function () {
        sinon.restore();
        for (let t of or.finalizationTimers.values()) clearTimeout(t);
        or.finalizationTimers.clear();
    });
}

function registerFederatedTests() {
    it('skips a round-number anchor on a federated hub inside the first interval', async function () {
        let consensus = arm(2, 77, true);
        or.scheduleFinalization(77);
        await timerFired(consensus);
        expect(consensus.finalizeRound.called).to.equal(false);
        expect(consensus.storeSkippedRound.calledOnce).to.equal(true);
        expect(consensus.storeSkippedRound.firstCall.args[0]).to.equal(77);
        expect(consensus.storeSkippedRound.firstCall.args[3]).to.match(/round-number anchor/);
    });

    // Reliability is judged when the height was captured, so a tip that recovers
    // before the timer fires does not bless the stale stand-in height.
    it('still skips when the tip recovers after a round-number anchor was captured', async function () {
        let consensus = arm(2, 78, true);
        or.scheduleFinalization(78);
        or.chainTipFallbackActive = false;
        or.currentBtcBlockHeight  = 900000;
        await timerFired(consensus);
        expect(consensus.finalizeRound.called).to.equal(false);
        expect(consensus.storeSkippedRound.calledOnce).to.equal(true);
    });

    it('finalizes a real BTC anchor on a federated hub', async function () {
        let consensus = arm(2, 900000, false);
        or.scheduleFinalization(80);
        await timerFired(consensus);
        expect(consensus.storeSkippedRound.called).to.equal(false);
        expect(consensus.finalizeRound.calledOnce).to.equal(true);
        expect(consensus.finalizeRound.firstCall.args.slice(0, 2)).to.deep.equal([80, 900000]);
    });
}

function registerSingleNodeTests() {
    // A single-node or regtest hub has no follower to disagree with.
    it('keeps the round-number fallback on a single-node hub (quorum 0)', async function () {
        let consensus = arm(0, 79, true);
        or.scheduleFinalization(79);
        await timerFired(consensus);
        expect(consensus.storeSkippedRound.called).to.equal(false);
        expect(consensus.finalizeRound.calledOnce).to.equal(true);
        expect(consensus.finalizeRound.firstCall.args.slice(0, 2)).to.deep.equal([79, 79]);
    });
}

describe('OracleRound scheduleFinalization: round-number anchor', function () {
    registerAnchorSkipHooks();
    describe('on a federated hub', registerFederatedTests);
    describe('on a single-node hub', registerSingleNodeTests);
});

describe('OracleRound stale pushed tip reference block', function () {
    let hub, round, savedMaxTipAge;
    beforeEach(function () {
        savedMaxTipAge = process.env.MAX_TIP_AGE_S;
        delete process.env.MAX_TIP_AGE_S;
        const OracleRound = proxyquire('../../../../src/oracle/round', {
            './price_fetcher': function () {
                return { fetchPrices: sinon.stub().resolves([]) };
            }
        });
        hub = createMockHub({
            p2pConfig: {
                ORACLE_EPOCH_START: Date.now() - 60000,
                ORACLE_ROUND_INTERVAL: '60000',
                ORACLE_SUBMISSION_WINDOW: '30000'
            }
        });
        hub.btcPushedTipFresh = ChainTips.prototype.btcPushedTipFresh;
        hub.resolveFreshPushedBtcTip = ChainTips.prototype.resolveFreshPushedBtcTip;
        hub.resolveBtcLatestBlock.resolves(DIRECT_HEIGHT);
        round = new OracleRound(hub);
        sinon.stub(round, 'scheduleFinalization');
    });

    afterEach(function () {
        sinon.restore();
        if (savedMaxTipAge === undefined) delete process.env.MAX_TIP_AGE_S;
        else process.env.MAX_TIP_AGE_S = savedMaxTipAge;
    });

    async function expectDirectHeightFor(ageHours) {
        hub.db.getChainTip.resolves(tipAged(ageHours));

        await round.executeRound();

        expect(round.currentBtcBlockHeight).to.equal(DIRECT_HEIGHT);
        expect(round.anchorTipBlockTime).to.equal(null);
        expect(round.chainTipFallbackActive).to.equal(false);
        expect(hub.resolveBtcLatestBlock.calledOnce).to.equal(true);
    }

    it('rejects a stale pushed tip from 22 hours ago', async function () {
        await expectDirectHeightFor(22);
    });

    it('rejects a stale pushed tip from 47 hours ago', async function () {
        await expectDirectHeightFor(47);
    });

    it('keeps a fresh pushed tip as the round reference block', async function () {
        const freshTip = tipAged(0);
        hub.db.getChainTip.resolves(freshTip);

        await round.executeRound();

        expect(round.currentBtcBlockHeight).to.equal(PUSHED_HEIGHT);
        expect(round.anchorTipBlockTime).to.equal(freshTip.blockTime);
        expect(hub.resolveBtcLatestBlock.called).to.equal(false);
    });
});

// A skipped-row write rejected by a DB outage (the circuit breaker open) must be
// re-attempted: nothing else ever writes that round's row, so a single rejection
// would leave it a permanent hole in the presence record on the hub and its mirrors.
const SKIP_REASON = 'chain-tip fallback active, anchor unreliable';
const RETRY_ROUND = 136952;
let retryClock, roundLost;

function breakerOpen() { return new Error('Circuit breaker open: database connections rejected until cooldown expires'); }

// Calls to storeSkippedRound made by the finalization path, not by stop().
function skipCalls(consensus) {
    return consensus.storeSkippedRound.getCalls().filter(c => c.args[3] === SKIP_REASON);
}

function lostCauses() {
    return roundLost.getCalls().map(c => c.args[0].cause);
}

// Arm the chain-tip-fallback skip path: fallback active for longer than one
// round interval, so the timer stores a skipped row instead of finalizing.
function armSkip(rejections) {
    or.submissionWindow = 10;
    or.roundInterval    = 60000;
    or.chainTipFallbackActive = true;
    or.lastSuccessfulChainTipFetchAt = Date.now() - 2 * or.roundInterval;
    or.currentBtcBlockHeight = 900123;
    let store = sinon.stub();
    for (let i = 0; i < rejections; i++) store.onCall(i).rejects(breakerOpen());
    store.resolves();
    let consensus = { finalizeRound: sinon.stub().resolves(), storeSkippedRound: store, getQuorum: () => 0 };
    or.oracleConsensus = consensus;
    return consensus;
}

function registerSkipRetryHooks() {
    beforeEach(function () {
        retryClock = sinon.useFakeTimers({ now: Date.now(), toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        roundLost = sinon.spy();
        const finalization = proxyquire('../../../../src/oracle/round/finalization.js', {
            '../../consensus/diagnostics': { noteRoundLost: roundLost }
        });
        const OracleRound = proxyquire('../../../../src/oracle/round', {
            './price_fetcher': function () { return { fetchPrices: sinon.stub().resolves([]) }; },
            './round/finalization.js': finalization
        });
        or = new OracleRound(createMockHub({
            p2pConfig: { ORACLE_ROUND_INTERVAL: '60000', ORACLE_SUBMISSION_WINDOW: '30000' }
        }));
    });

    afterEach(function () {
        for (let t of or.finalizationTimers.values()) clearTimeout(t);
        or.finalizationTimers.clear();
        retryClock.restore();
        sinon.restore();
    });
}

function registerSkipRetryRecoveryCases() {
    it('stores the skipped row once the DB recovers after the first writes reject', async function () {
        let consensus = armSkip(2);
        or.scheduleFinalization(RETRY_ROUND);
        await retryClock.tickAsync(10);
        expect(skipCalls(consensus)).to.have.length(1);
        await retryClock.tickAsync(30 * 60 * 1000);
        let calls = skipCalls(consensus);
        expect(calls).to.have.length(3);
        for (let c of calls) expect(c.args.slice(0, 2)).to.deep.equal([RETRY_ROUND, 900123]);
        expect(calls[2].args).to.deep.equal(calls[0].args);
        expect(consensus.finalizeRound.called).to.equal(false);
        expect(lostCauses()).to.deep.equal(['skip_store_rejected', 'skip_store_rejected']);
        expect(or.finalizationTimers.has(RETRY_ROUND)).to.equal(false);
    });

    it('stops re-attempting at the retry budget', async function () {
        let consensus = armSkip(1000);
        or.scheduleFinalization(RETRY_ROUND);
        await retryClock.tickAsync(3 * 60 * 60 * 1000);
        let made = skipCalls(consensus).length;
        expect(made).to.be.greaterThan(2);
        expect(made).to.be.lessThan(20);
        expect(lostCauses()).to.have.length(made);
        expect(or.finalizationTimers.has(RETRY_ROUND)).to.equal(false);
        await retryClock.tickAsync(3 * 60 * 60 * 1000);
        expect(skipCalls(consensus)).to.have.length(made);
    });
}

function registerSkipRetryStopCases() {
    it('stops re-attempting once a federation PROPOSE finalized the round', async function () {
        let consensus = armSkip(1);
        consensus.finalized = new Set();
        or.scheduleFinalization(RETRY_ROUND);
        await retryClock.tickAsync(10);
        consensus.finalized.add(RETRY_ROUND);
        await retryClock.tickAsync(30 * 60 * 1000);
        expect(skipCalls(consensus)).to.have.length(1);
        expect(or.finalizationTimers.has(RETRY_ROUND)).to.equal(false);
    });

    it('clears a pending re-attempt at stop and writes the row once more there', async function () {
        let consensus = armSkip(1);
        or.scheduleFinalization(RETRY_ROUND);
        await retryClock.tickAsync(10);
        expect(or.finalizationTimers.has(RETRY_ROUND)).to.equal(true);
        await or.stop();
        expect(or.finalizationTimers.size).to.equal(0);
        let atStop = consensus.storeSkippedRound.getCalls().filter(c => c.args[3] === 'hub stopped before finalization');
        expect(atStop).to.have.length(1);
        expect(atStop[0].args[0]).to.equal(RETRY_ROUND);
        await retryClock.tickAsync(30 * 60 * 1000);
        expect(skipCalls(consensus)).to.have.length(1);
    });
}

describe('OracleRound scheduleFinalization: skipped-row write retry', function () {
    registerSkipRetryHooks();
    registerSkipRetryRecoveryCases();
    registerSkipRetryStopCases();
});
