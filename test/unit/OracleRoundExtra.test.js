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
//   - _handleMessage: invalid round, late submission, duplicate sender,
//     max submissions, invalid prices, known validator pubkey → DB persist path
//   - _scheduleFinalization: fallback-suppression branch
//   - _pruneSubmissions: old round eviction
//   - _persistSubmissions: null pubkey fallback

const sinon             = require('sinon');
const { expect }        = require('chai');
const proxyquire        = require('proxyquire');
const { createMockHub } = require('../helpers/mockHub');

describe('OracleRound (extra coverage)', function () {

    let hub, pm, or, mockPriceFetcher, OracleRound;

    beforeEach(function () {
        mockPriceFetcher = {
            fetchPrices: sinon.stub().resolves([
                { coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }
            ])
        };

        OracleRound = proxyquire('../../src/OracleRound', {
            './PriceFetcher': function () { return mockPriceFetcher; }
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
        if (or.finalizationTimer) { clearTimeout(or.finalizationTimer); or.finalizationTimer = null; }
    });

    // ── stop() ──────────────────────────────────────────────────────────────

    describe('stop()', function () {
        it('removes the message listener from peerManager', async function () {
            sinon.stub(or, '_startRoundTimer');
            sinon.stub(or, '_hydrateFreshnessCounters').resolves();
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

        it('clears finalizationTimer', async function () {
            or.finalizationTimer = setTimeout(() => {}, 100000);
            await or.stop();
            expect(or.finalizationTimer).to.be.null;
        });

        it('clears roundTimer', async function () {
            or.roundTimer = setInterval(() => {}, 100000);
            await or.stop();
            expect(or.roundTimer).to.be.null;
        });
    });

    // ── getCurrentRound / getSubmissions ────────────────────────────────────

    describe('getCurrentRound() / getSubmissions()', function () {
        it('getCurrentRound returns 0 before any round', function () {
            expect(or.getCurrentRound()).to.equal(0);
        });

        it('getSubmissions with no argument uses currentRound', async function () {
            await or._executeRound();
            let round = or.currentRound;
            let subs1 = or.getSubmissions(round);
            let subs2 = or.getSubmissions();  // default = currentRound
            expect(subs1).to.equal(subs2);
        });
    });

    // ── _executeRound: chain-tip branch coverage ─────────────────────────────

    describe('_executeRound() — BTC chain tip fallback', function () {
        it('uses round number as fallback when getChainTip returns null', async function () {
            hub.db.getChainTip = sinon.stub().resolves(null);
            await or._executeRound();
            expect(or.chainTipFetchFailures).to.equal(1);
            expect(or.chainTipFallbackActive).to.be.true;
            expect(or.currentBtcBlockHeight).to.equal(or.currentRound);
        });

        it('increments chainTipFetchFailures on repeated failures', async function () {
            hub.db.getChainTip = sinon.stub().resolves(null);
            await or._executeRound();
            // Reset idempotency guard
            or.lastExecutedRound = -1;
            await or._executeRound();
            expect(or.chainTipFetchFailures).to.equal(2);
        });

        it('uses round number as fallback when getChainTip throws', async function () {
            hub.db.getChainTip = sinon.stub().rejects(new Error('db error'));
            await or._executeRound();
            expect(or.chainTipFetchFailures).to.be.greaterThan(0);
            expect(or.chainTipFallbackActive).to.be.true;
        });

        it('uses BTC chain tip values when getChainTip succeeds', async function () {
            hub.db.getChainTip = sinon.stub().resolves({ blockHeight: 800000, blockTime: 1700000000 });
            await or._executeRound();
            expect(or.currentBtcBlockHeight).to.equal(800000);
            expect(or.chainTipFetchFailures).to.equal(0);
            expect(or.chainTipFallbackActive).to.be.false;
        });

        it('resets fallback state after a successful chain-tip read', async function () {
            // First: simulate a failure
            hub.db.getChainTip = sinon.stub().resolves(null);
            await or._executeRound();
            expect(or.chainTipFallbackActive).to.be.true;

            // Second: successful read
            or.lastExecutedRound = -1;
            hub.db.getChainTip = sinon.stub().resolves({ blockHeight: 800001, blockTime: 1700000001 });
            await or._executeRound();
            expect(or.chainTipFallbackActive).to.be.false;
            expect(or.chainTipFetchFailures).to.equal(0);
        });
    });

    // ── getSubmissionsInfo: anchor-tip block age (#4544) ──────────────────────
    // A present-but-frozen pushed tip (indexer suppressing pushes during catch-up)
    // resets every fetch-freshness counter, so chainTipStalenessMs (read time) stays
    // small and usingFallback stays false. The tip's OWN block age must surface the
    // freeze. Threshold = 2x round interval = 120s here (ORACLE_ROUND_INTERVAL 60000).
    describe('getSubmissionsInfo(): anchor tip block age (#4544)', function () {
        it('flags a frozen-but-present pushed tip as block-stale while fetch counters stay clean', async function () {
            let staleBlockTime = Math.floor(Date.now() / 1000) - 100000; // ~28h old
            hub.db.getChainTip = sinon.stub().resolves({ blockHeight: 800000, blockTime: staleBlockTime });
            await or._executeRound();
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
            await or._executeRound();
            let info = await or.getSubmissionsInfo();
            expect(info.chainTipBlockStale).to.be.false;
            expect(info.chainTipBlockAgeMs).to.be.lessThan(120000);
        });

        it('returns null block age when anchored on the round-number fallback', async function () {
            hub.db.getChainTip = sinon.stub().resolves(null);
            await or._executeRound();
            let info = await or.getSubmissionsInfo();
            // Wall-clock-stamped fallback anchor has no real block time to age.
            expect(info.chainTipBlockAgeMs).to.equal(null);
            expect(info.chainTipBlockStale).to.equal(null);
        });
    });

    // ── _handleMessage: edge cases ───────────────────────────────────────────

    describe('_handleMessage() — edge cases', function () {

        it('ignores messages with missing round/prices', function () {
            or._handleMessage({ type: 'ORACLE_PRICE_SUBMIT', sender: 'peer', data: { round: null, prices: null } });
            expect(or.submissions.size).to.equal(0);
        });

        it('ignores submissions for rounds too far in the past', async function () {
            await or._executeRound(); // sets currentRound=N
            or._handleMessage({
                type:   'ORACLE_PRICE_SUBMIT',
                sender: 'peer',
                data: {
                    round:  or.currentRound - 2,  // too old
                    prices: [{ coinPair: 'BTC/USD', price: '100' }]
                }
            });
            expect(or.submissions.has(or.currentRound - 2)).to.be.false;
        });

        it('ignores submissions for rounds too far in the future', async function () {
            await or._executeRound();
            or._handleMessage({
                type:   'ORACLE_PRICE_SUBMIT',
                sender: 'peer',
                data: {
                    round:  or.currentRound + 2,  // too far ahead
                    prices: [{ coinPair: 'BTC/USD', price: '100' }]
                }
            });
            expect(or.submissions.has(or.currentRound + 2)).to.be.false;
        });

        it('logs late submission but still records it', async function () {
            await or._executeRound();
            let round = or.currentRound;
            // Simulate late submission: elapsed > submissionWindow
            or.roundStartTime = Date.now() - (or.submissionWindow + 1000);
            or._handleMessage({
                type:   'ORACLE_PRICE_SUBMIT',
                sender: 'latepeer',
                data: { round, prices: [{ coinPair: 'BTC/USD', price: '100' }], sources: 1 }
            });
            // Still recorded (late but accepted)
            let subs = or.submissions.get(round);
            expect(subs && subs.has('latepeer')).to.be.true;
        });

        it('enforces max submissions per round', async function () {
            await or._executeRound();
            let round = or.currentRound;
            let subs = or.submissions.get(round);
            // Fill to max
            for (let i = 0; i < or.maxSubmissionsPerRound; i++) {
                subs.set('peer' + i, { prices: [], sources: 0, timestamp: Date.now() });
            }
            // Now try to add one more
            or._handleMessage({
                type:   'ORACLE_PRICE_SUBMIT',
                sender: 'overflow_peer',
                data: { round, prices: [{ coinPair: 'BTC/USD', price: '100' }], sources: 1 }
            });
            expect(subs.has('overflow_peer')).to.be.false;
        });

        it('ignores price submissions where all prices are invalid', async function () {
            await or._executeRound();
            let round = or.currentRound;
            or._handleMessage({
                type:   'ORACLE_PRICE_SUBMIT',
                sender: 'badpeer',
                data: {
                    round,
                    prices: [
                        { coinPair: 'BTC/USD', price: '-100' },  // negative
                        { coinPair: 'BTC/USD', price: 'NaN' }    // non-numeric
                    ]
                }
            });
            let subs = or.submissions.get(round);
            expect(subs && subs.has('badpeer')).to.be.false;
        });

        it('persists submission when validator pubkey is known', async function () {
            await or._executeRound();
            let round = or.currentRound;
            let sender = 'ws://peer-with-pubkey:10001';
            pm.validatorPubkeys = new Map([[sender, 'pubkey_hex']]);
            hub.db.doQuery = sinon.stub().resolves([]);

            or._handleMessage({
                type:   'ORACLE_PRICE_SUBMIT',
                sender: sender,
                data: {
                    round,
                    prices: [{ coinPair: 'BTC/USD', price: '100000' }],
                    sources: 1
                }
            });

            expect(hub.db.doQuery.called).to.be.true;
        });
    });

    // ── _scheduleFinalization: fallback suppression ──────────────────────────

    describe('_scheduleFinalization() — fallback suppression', function () {
        it('suppresses finalization when fallback active for > roundInterval', function (done) {
            // Set a very short submissionWindow so the timer fires quickly
            or.submissionWindow = 10;
            or.roundInterval    = 1;  // 1ms so "stale" is immediate
            or.chainTipFallbackActive = true;
            or.lastSuccessfulChainTipFetchAt = Date.now() - 10000; // 10s ago
            let finalizeStub = sinon.stub().resolves();
            or.oracleConsensus = { finalizeRound: finalizeStub };
            or._scheduleFinalization(99);
            setTimeout(() => {
                // finalizeRound should NOT have been called because fallback was active too long
                expect(finalizeStub.called).to.be.false;
                done();
            }, 50);
        });

        it('calls oracleConsensus.finalizeRound when fallback is not active', function (done) {
            or.submissionWindow = 10;
            or.chainTipFallbackActive = false;
            let finalizeStub = sinon.stub().resolves();
            or.oracleConsensus = { finalizeRound: finalizeStub };
            or._scheduleFinalization(42);
            setTimeout(() => {
                expect(finalizeStub.calledOnce).to.be.true;
                expect(finalizeStub.firstCall.args[0]).to.equal(42);
                done();
            }, 50);
        });
    });

    // ── _pruneSubmissions ────────────────────────────────────────────────────

    describe('_pruneSubmissions()', function () {
        it('removes rounds older than currentRound - 1', function () {
            or.currentRound = 5;
            or.submissions.set(3, new Map());  // too old
            or.submissions.set(4, new Map());  // current-1 (kept)
            or.submissions.set(5, new Map());  // current (kept)
            or._pruneSubmissions();
            expect(or.submissions.has(3)).to.be.false;
            expect(or.submissions.has(4)).to.be.true;
            expect(or.submissions.has(5)).to.be.true;
        });
    });

    // ── _persistSubmissions: pubkey fallbacks ────────────────────────────────

    describe('_persistSubmissions() — pubkey fallbacks', function () {
        it('uses identity pubkey when validatorPubkey is null', function () {
            hub.db.doQuery = sinon.stub().resolves([]);
            or._persistSubmissions(1, 'me', [{ coinPair: 'BTC/USD', price: '100', sources: 1 }], null);
            // Called once for the one price pair
            expect(hub.db.doQuery.called).to.be.true;
            // Identity.getPubkeyHex should have been called
            expect(hub._identity.getPubkeyHex.called).to.be.true;
        });

        it('uses zero-padded pubkey when both validatorPubkey and identity are null', function () {
            hub.db.doQuery = sinon.stub().resolves([]);
            or.identity = null;
            or._persistSubmissions(1, 'me', [{ coinPair: 'BTC/USD', price: '100', sources: 1 }], null);
            let vals = hub.db.doQuery.firstCall.args[1];
            expect(vals[2]).to.equal('0'.repeat(64));
        });
    });

    // ── getSubmissionsInfo: DB error fallback ────────────────────────────────

    describe('getSubmissionsInfo() — DB error', function () {
        it('returns info without skippedRounds when DB query fails', async function () {
            hub.db.doQuery = sinon.stub().rejects(new Error('db error'));
            await or._executeRound();
            let info = await or.getSubmissionsInfo();
            expect(info).to.have.property('currentRound');
            expect(info.skippedRounds).to.deep.equal([]);
        });
    });
});
