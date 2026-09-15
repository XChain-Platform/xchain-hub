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

function registerHandlemessageEdgeCases2Tests1() {

        it('ignores messages with missing round/prices', function () {
            or._handleMessage({ type: 'ORACLE_PRICE_SUBMIT', sender: 'peer', sig_pubkey: pubkeyForTestSender('peer'), data: { round: null, prices: null } });
            expect(or.submissions.size).to.equal(0);
        });

        it('ignores submissions for rounds too far in the past', async function () {
            await or._executeRound(); // sets currentRound=N
            or._handleMessage({
                type:   'ORACLE_PRICE_SUBMIT',
                sender: 'peer', sig_pubkey: pubkeyForTestSender('peer'),
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
                sender: 'peer', sig_pubkey: pubkeyForTestSender('peer'),
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
                sender: 'latepeer', sig_pubkey: pubkeyForTestSender('latepeer'),
                data: { round, prices: [{ coinPair: 'BTC/USD', price: '100' }], sources: 1 }
            });
            // Still recorded (late but accepted)
            let subs = or.submissions.get(round);
            expect(subs && subs.has('latepeer')).to.be.true;
        });
}

function registerHandlemessageEdgeCases2Tests5() {

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
                sender: 'overflow_peer', sig_pubkey: pubkeyForTestSender('overflow_peer'),
                data: { round, prices: [{ coinPair: 'BTC/USD', price: '100' }], sources: 1 }
            });
            expect(subs.has('overflow_peer')).to.be.false;
        });

        it('ignores price submissions where all prices are invalid', async function () {
            await or._executeRound();
            let round = or.currentRound;
            or._handleMessage({
                type:   'ORACLE_PRICE_SUBMIT',
                sender: 'badpeer', sig_pubkey: pubkeyForTestSender('badpeer'),
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
}

function registerHandlemessageEdgeCases2Tests7() {

        it('persists submission when the signing key is attributed', async function () {
            await or._executeRound();
            let round = or.currentRound;
            let sender = 'ws://peer-with-pubkey:10001';
            let pubkey = 'dd'.repeat(32);
            pm.validatorPubkeys = new Map([[sender, pubkey]]);
            hub.db.doQuery = sinon.stub().resolves([]);

            or._handleMessage({
                type:   'ORACLE_PRICE_SUBMIT',
                sender: sender,
                sig_pubkey: pubkey,
                data: {
                    round,
                    prices: [{ coinPair: 'BTC/USD', price: '100000' }],
                    sources: 1
                }
            });

            expect(hub.db.doQuery.called).to.be.true;
        });

}

function registerSchedulefinalizationFallbackSuppression3Tests8() {
        it('suppresses finalization when fallback active for > roundInterval', function (done) {
            // Set a very short submissionWindow so the timer fires quickly
            or.submissionWindow = 10;
            or.roundInterval    = 1;  // 1ms so "stale" is immediate
            or.chainTipFallbackActive = true;
            or.lastSuccessfulChainTipFetchAt = Date.now() - 10000; // 10s ago
            let finalizeStub = sinon.stub().resolves();
            let storeSkippedStub = sinon.stub().resolves();
            or.oracleConsensus = { finalizeRound: finalizeStub, storeSkippedRound: storeSkippedStub };
            or.consecutiveSkippedRounds = 0;
            or.scheduleFinalization(99);
            setTimeout(() => {
                // finalizeRound should NOT have been called because fallback was active too long
                expect(finalizeStub.called).to.be.false;
                // The skip is recorded durably, unlike a silent drop.
                expect(storeSkippedStub.calledOnce).to.be.true;
                expect(storeSkippedStub.firstCall.args[0]).to.equal(99);
                // item 4942: the streak advances on the 'round:skipped' event that
                // durable write emits, never at this call site. Incrementing here
                // double-counted a round whose fetch had already failed and bumped it,
                // so the live gauge disagreed with the hydrated value after a restart.
                // The stubbed consensus emits nothing, so the gauge must stay put.
                expect(or.consecutiveSkippedRounds).to.equal(0);
                done();
            }, 50);
        });

        it('calls oracleConsensus.finalizeRound when fallback is not active', function (done) {
            or.submissionWindow = 10;
            or.chainTipFallbackActive = false;
            let finalizeStub = sinon.stub().resolves();
            or.oracleConsensus = { finalizeRound: finalizeStub };
            or.scheduleFinalization(42);
            setTimeout(() => {
                expect(finalizeStub.calledOnce).to.be.true;
                expect(finalizeStub.firstCall.args[0]).to.equal(42);
                done();
            }, 50);
        });

        // Stress-sweep 2026-07-08: the per-round timer map. A single shared timer let a
        // second round scheduled within one submission window clear the first round's
        // timer, dropping its finalization entirely.
        it('keeps a per-round timer so scheduling a second round does not evict the first', function () {
            or.submissionWindow = 100000; // long enough that neither fires during the test
            or.scheduleFinalization(1);
            or.scheduleFinalization(2);
            expect(or.finalizationTimers.has(1)).to.be.true;
            expect(or.finalizationTimers.has(2)).to.be.true;
            expect(or.finalizationTimers.size).to.equal(2);
        });
}

function registerSchedulefinalizationFallbackSuppression3Tests11() {

        it('both scheduled rounds finalize (neither is silently dropped)', function (done) {
            or.submissionWindow = 10;
            or.chainTipFallbackActive = false;
            let finalizeStub = sinon.stub().resolves();
            or.oracleConsensus = { finalizeRound: finalizeStub };
            or.scheduleFinalization(7);
            or.scheduleFinalization(8);
            setTimeout(() => {
                let rounds = finalizeStub.getCalls().map(c => c.args[0]).sort();
                expect(rounds).to.deep.equal([7, 8]);
                expect(or.finalizationTimers.size).to.equal(0); // entries deleted on fire
                done();
            }, 50);
        });

        it('re-scheduling the same round replaces its timer (no duplicate/leak)', function () {
            or.submissionWindow = 100000;
            or.scheduleFinalization(3);
            let first = or.finalizationTimers.get(3);
            or.scheduleFinalization(3);
            expect(or.finalizationTimers.size).to.equal(1);
            expect(or.finalizationTimers.get(3)).to.not.equal(first);
        });

}

function registerPrunesubmissions4Tests13() {
        it('removes rounds older than currentRound - 1', function () {
            or.currentRound = 5;
            or.submissions.set(3, new Map());  // too old
            or.submissions.set(4, new Map());  // current-1 (kept)
            or.submissions.set(5, new Map());  // current (kept)
            or.pruneSubmissions();
            expect(or.submissions.has(3)).to.be.false;
            expect(or.submissions.has(4)).to.be.true;
            expect(or.submissions.has(5)).to.be.true;
        });

}

function registerPrunesubmissionsdb5Tests14() {
        it('deletes oracle_submissions rows older than the retention window', async function () {
            or.submissionsRetentionRounds = 100;
            or.currentRound = 1000;
            let del = sinon.stub().resolves({ affectedRows: 7 });
            hub.db.doQuery = del;
            await or.pruneSubmissionsDb();
            expect(del.calledOnce).to.be.true;
            expect(del.firstCall.args[0]).to.match(/DELETE FROM oracle_submissions WHERE round_number < \?/);
            expect(del.firstCall.args[1]).to.deep.equal([900]);
        });

        it('is a no-op when retention is disabled (0)', async function () {
            or.submissionsRetentionRounds = 0;
            or.currentRound = 1000;
            let del = sinon.stub().resolves({});
            hub.db.doQuery = del;
            await or.pruneSubmissionsDb();
            expect(del.called).to.be.false;
        });

        it('is a no-op before the deployment has run a full window of rounds', async function () {
            or.submissionsRetentionRounds = 12960;
            or.currentRound = 50;
            let del = sinon.stub().resolves({});
            hub.db.doQuery = del;
            await or.pruneSubmissionsDb();
            expect(del.called).to.be.false;
        });

        it('defaults to a bounded window (does not grow unbounded)', function () {
            let fresh = new OracleRound(createMockHub({ p2pConfig: {} }));
            expect(fresh.submissionsRetentionRounds).to.be.a('number');
            expect(fresh.submissionsRetentionRounds).to.be.greaterThan(0);
        });

}

describe('OracleRound (extra coverage)', function () {
    registerOracleroundExtraCoverage1Hooks();



    // ── _handleMessage: edge cases ───────────────────────────────────────────
    describe('_handleMessage(): edge cases', function () {
        registerHandlemessageEdgeCases2Tests1();
        registerHandlemessageEdgeCases2Tests5();
        registerHandlemessageEdgeCases2Tests7();
    });



    // ── scheduleFinalization: fallback suppression ──────────────────────────
    describe('scheduleFinalization(): fallback suppression', function () {
        registerSchedulefinalizationFallbackSuppression3Tests8();
        registerSchedulefinalizationFallbackSuppression3Tests11();
    });



    // ── pruneSubmissions ────────────────────────────────────────────────────
    describe('pruneSubmissions()', function () {
        registerPrunesubmissions4Tests13();
    });



    // ── pruneSubmissionsDb (durable retention) ──────────────────────────────
    describe('pruneSubmissionsDb()', function () {
        registerPrunesubmissionsdb5Tests14();
    });
});
