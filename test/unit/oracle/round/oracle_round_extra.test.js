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
// Extra OracleRound tests covering branches not already exercised by
// the existing OracleRound.test.js:
//   - stop() clears all timers
//   - handleMessage: invalid round, late submission, duplicate sender,
//     max submissions, invalid prices, known validator pubkey → DB persist path
//   - scheduleFinalization: fallback-suppression branch
//   - pruneSubmissions: old round eviction
//   - persistSubmissions: null pubkey fallback

const sinon             = require('sinon');
const { expect }        = require('chai');
const proxyquire        = require('proxyquire');
const { createMockHub } = require('../../../helpers/mockHub');
const { pubkeyForTestSender } = require('../../../helpers/fixtures');



    let hub, pm, or, mockPriceFetcher, OracleRound;

function registerOracleroundExtraCoverage1Hooks() {

    beforeEach(function () {
        mockPriceFetcher = {
            fetchPrices: sinon.stub().resolves([
                { coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }
            ])
        };

        OracleRound = proxyquire('../../../../src/oracle/round', {
            './price_fetcher': function () { return mockPriceFetcher; }
        });

        hub = createMockHub({ p2pConfig: { ORACLE_ROUND_INTERVAL: '60000', ORACLE_SUBMISSION_WINDOW: '30000' } });
        pm  = hub._peerManager;
        or  = new OracleRound(hub);
    });

    afterEach(function () {
        sinon.restore();
        // Clean up any timers
        if (or.roundTimer)        { clearInterval(or.roundTimer); or.roundTimer = null; }
        if (or.initialRoundTimer) { clearTimeout(or.initialRoundTimer); or.initialRoundTimer = null; }
        if (or.boundaryTimer)     { clearTimeout(or.boundaryTimer); or.boundaryTimer = null; }
        if (or.finalizationTimers) { for (let t of or.finalizationTimers.values()) clearTimeout(t); or.finalizationTimers.clear(); }
    });
}

function registerStop2Tests1() {
        it('removes the message listener from peerManager', async function () {
            sinon.stub(or, 'startRoundTimer');
            sinon.stub(or, 'hydrateFreshnessCounters').resolves();
            await or.start();
            expect(pm.listenerCount('message')).to.equal(1);
            await or.stop();
            expect(pm.listenerCount('message')).to.equal(0);
        });

        it('clears initialRoundTimer', async function () {
            or.initialRoundTimer = setTimeout(() => {}, 100000);
            await or.stop();
            expect(or.initialRoundTimer).to.be.null;
        });

        it('clears all finalization timers', async function () {
            or.finalizationTimers.set(1, setTimeout(() => {}, 100000));
            or.finalizationTimers.set(2, setTimeout(() => {}, 100000));
            await or.stop();
            expect(or.finalizationTimers.size).to.equal(0);
        });

        it('clears roundTimer', async function () {
            or.roundTimer = setInterval(() => {}, 100000);
            await or.stop();
            expect(or.roundTimer).to.be.null;
        });

        it('clears the untracked boundary timer so it cannot fire after stop()', async function () {
            let clock = sinon.useFakeTimers({ now: or.epochStart + 1000 });
            try {
                let ran = sinon.stub(or, 'executeRound').resolves();
                or.startRoundTimer();
                // Boundary timer is now scheduled but not yet fired.
                expect(or.boundaryTimer).to.not.be.null;
                await or.stop();
                expect(or.boundaryTimer).to.be.null;
                // Advance well past the boundary: the cancelled timer must not fire
                // a round or install a lingering interval.
                clock.tick(or.roundInterval * 3);
                expect(ran.called).to.be.false;
                expect(or.roundTimer).to.be.null;
            } finally {
                clock.restore();
            }
        });

}

function registerStartIdempotency3Tests6() {
        it('does not install a second round loop when already running', async function () {
            sinon.stub(or, 'hydrateFreshnessCounters').resolves();
            let spy = sinon.spy(or, 'startRoundTimer');
            await or.start();
            expect(spy.callCount).to.equal(1);
            // Second start() with no intervening stop() is a no-op.
            await or.start();
            expect(spy.callCount).to.equal(1);
            await or.stop();
        });

}

function registerGetcurrentroundGetsubmissions4Tests7() {
        it('getCurrentRound returns 0 before any round', function () {
            expect(or.getCurrentRound()).to.equal(0);
        });

        it('getSubmissions with no argument uses currentRound', async function () {
            await or.executeRound();
            let round = or.currentRound;
            let subs1 = or.getSubmissions(round);
            let subs2 = or.getSubmissions();  // default = currentRound
            expect(subs1).to.equal(subs2);
        });

}

function registerExecuteroundBtcChainTipFallback5Tests9() {
        it('uses round number as fallback when getChainTip returns null', async function () {
            hub.db.getChainTip = sinon.stub().resolves(null);
            await or.executeRound();
            expect(or.chainTipFetchFailures).to.equal(1);
            expect(or.chainTipFallbackActive).to.be.true;
            expect(or.currentBtcBlockHeight).to.equal(or.currentRound);
        });

        it('increments chainTipFetchFailures on repeated failures', async function () {
            hub.db.getChainTip = sinon.stub().resolves(null);
            await or.executeRound();
            // Reset idempotency guard
            or.lastExecutedRound = -1;
            await or.executeRound();
            expect(or.chainTipFetchFailures).to.equal(2);
        });

        it('uses round number as fallback when getChainTip throws', async function () {
            hub.db.getChainTip = sinon.stub().rejects(new Error('db error'));
            await or.executeRound();
            expect(or.chainTipFetchFailures).to.be.greaterThan(0);
            expect(or.chainTipFallbackActive).to.be.true;
        });

        it('uses BTC chain tip values when getChainTip succeeds', async function () {
            hub.db.getChainTip = sinon.stub().resolves({ blockHeight: 800000, blockTime: 1700000000 });
            await or.executeRound();
            expect(or.currentBtcBlockHeight).to.equal(800000);
            expect(or.chainTipFetchFailures).to.equal(0);
            expect(or.chainTipFallbackActive).to.be.false;
        });

        it('resets fallback state after a successful chain-tip read', async function () {
            // First: simulate a failure
            hub.db.getChainTip = sinon.stub().resolves(null);
            await or.executeRound();
            expect(or.chainTipFallbackActive).to.be.true;

            // Second: successful read
            or.lastExecutedRound = -1;
            hub.db.getChainTip = sinon.stub().resolves({ blockHeight: 800001, blockTime: 1700000001 });
            await or.executeRound();
            expect(or.chainTipFallbackActive).to.be.false;
            expect(or.chainTipFetchFailures).to.equal(0);
        });

}

function registerGetsubmissionsinfoAnchorTipBlockAge6Tests14() {
        it('flags a frozen-but-present pushed tip as block-stale while fetch counters stay clean', async function () {
            let staleBlockTime = Math.floor(Date.now() / 1000) - 100000; // ~28h old
            hub.db.getChainTip = sinon.stub().resolves({ blockHeight: 800000, blockTime: staleBlockTime });
            await or.executeRound();
            // The bug: fetch counters all read healthy on a frozen tip.
            expect(or.chainTipFallbackActive).to.be.false;
            expect(or.chainTipFetchFailures).to.equal(0);
            let info = await or.getSubmissionsInfo();
            expect(info.usingFallback).to.be.false;
            // The fix: the tip's own age is surfaced and flagged stale.
            expect(info.chainTipBlockAgeMs).to.be.greaterThan(120000);
            expect(info.chainTipBlockStale).to.be.true;
        });

        it('reports a fresh pushed tip as not block-stale', async function () {
            let freshBlockTime = Math.floor(Date.now() / 1000);
            hub.db.getChainTip = sinon.stub().resolves({ blockHeight: 800001, blockTime: freshBlockTime });
            await or.executeRound();
            let info = await or.getSubmissionsInfo();
            expect(info.chainTipBlockStale).to.be.false;
            expect(info.chainTipBlockAgeMs).to.be.lessThan(120000);
        });

        it('returns null block age when anchored on the round-number fallback', async function () {
            hub.db.getChainTip = sinon.stub().resolves(null);
            await or.executeRound();
            let info = await or.getSubmissionsInfo();
            // Wall-clock-stamped fallback anchor has no real block time to age.
            expect(info.chainTipBlockAgeMs).to.equal(null);
            expect(info.chainTipBlockStale).to.equal(null);
        });

}

describe('OracleRound (extra coverage)', function () {
    registerOracleroundExtraCoverage1Hooks();



    // ── stop() ──────────────────────────────────────────────────────────────
    describe('stop()', function () {
        registerStop2Tests1();
    });



    // ── start() idempotency ──────────────────────────────────────────────────
    describe('start() idempotency', function () {
        registerStartIdempotency3Tests6();
    });



    // ── getCurrentRound / getSubmissions ────────────────────────────────────
    describe('getCurrentRound() / getSubmissions()', function () {
        registerGetcurrentroundGetsubmissions4Tests7();
    });



    // ── executeRound: chain-tip branch coverage ─────────────────────────────
    describe('executeRound(): BTC chain tip fallback', function () {
        registerExecuteroundBtcChainTipFallback5Tests9();
    });



    // ── getSubmissionsInfo: anchor-tip block age (#4544) ──────────────────────
    // A present-but-frozen pushed tip (indexer suppressing pushes during catch-up)
    // resets every fetch-freshness counter, so chainTipStalenessMs (read time) stays
    // small and usingFallback stays false. The tip's OWN block age must surface the
    // freeze. Threshold = 2x round interval = 120s here (ORACLE_ROUND_INTERVAL 60000).
    describe('getSubmissionsInfo(): anchor tip block age (#4544)', function () {
        registerGetsubmissionsinfoAnchorTipBlockAge6Tests14();
    });
});
