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
        if (or.boundaryTimer)     { clearTimeout(or.boundaryTimer); or.boundaryTimer = null; }
        if (or.finalizationTimers) { for (let t of or.finalizationTimers.values()) clearTimeout(t); or.finalizationTimers.clear(); }
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
                let ran = sinon.stub(or, '_executeRound').resolves();
                or._startRoundTimer();
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
    });

    // ── start() idempotency ──────────────────────────────────────────────────

    describe('start() idempotency', function () {
        it('does not install a second round loop when already running', async function () {
            sinon.stub(or, '_hydrateFreshnessCounters').resolves();
            let spy = sinon.spy(or, '_startRoundTimer');
            await or.start();
            expect(spy.callCount).to.equal(1);
            // Second start() with no intervening stop() is a no-op.
            await or.start();
            expect(spy.callCount).to.equal(1);
            await or.stop();
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

    describe('_executeRound(): BTC chain tip fallback', function () {
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

    describe('_handleMessage(): edge cases', function () {

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

    describe('_scheduleFinalization(): fallback suppression', function () {
        it('suppresses finalization when fallback active for > roundInterval', function (done) {
            // Set a very short submissionWindow so the timer fires quickly
            or.submissionWindow = 10;
            or.roundInterval    = 1;  // 1ms so "stale" is immediate
            or.chainTipFallbackActive = true;
            or.lastSuccessfulChainTipFetchAt = Date.now() - 10000; // 10s ago
            let finalizeStub = sinon.stub().resolves();
            let storeSkippedStub = sinon.stub().resolves();
            or.oracleConsensus = { finalizeRound: finalizeStub, _storeSkippedRound: storeSkippedStub };
            or.consecutiveSkippedRounds = 0;
            or._scheduleFinalization(99);
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
            or._scheduleFinalization(42);
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
            or._scheduleFinalization(1);
            or._scheduleFinalization(2);
            expect(or.finalizationTimers.has(1)).to.be.true;
            expect(or.finalizationTimers.has(2)).to.be.true;
            expect(or.finalizationTimers.size).to.equal(2);
        });

        it('both scheduled rounds finalize (neither is silently dropped)', function (done) {
            or.submissionWindow = 10;
            or.chainTipFallbackActive = false;
            let finalizeStub = sinon.stub().resolves();
            or.oracleConsensus = { finalizeRound: finalizeStub };
            or._scheduleFinalization(7);
            or._scheduleFinalization(8);
            setTimeout(() => {
                let rounds = finalizeStub.getCalls().map(c => c.args[0]).sort();
                expect(rounds).to.deep.equal([7, 8]);
                expect(or.finalizationTimers.size).to.equal(0); // entries deleted on fire
                done();
            }, 50);
        });

        it('re-scheduling the same round replaces its timer (no duplicate/leak)', function () {
            or.submissionWindow = 100000;
            or._scheduleFinalization(3);
            let first = or.finalizationTimers.get(3);
            or._scheduleFinalization(3);
            expect(or.finalizationTimers.size).to.equal(1);
            expect(or.finalizationTimers.get(3)).to.not.equal(first);
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

    // ── _pruneSubmissionsDb (durable retention) ──────────────────────────────

    describe('_pruneSubmissionsDb()', function () {
        it('deletes oracle_submissions rows older than the retention window', async function () {
            or.submissionsRetentionRounds = 100;
            or.currentRound = 1000;
            let del = sinon.stub().resolves({ affectedRows: 7 });
            hub.db.doQuery = del;
            await or._pruneSubmissionsDb();
            expect(del.calledOnce).to.be.true;
            expect(del.firstCall.args[0]).to.match(/DELETE FROM oracle_submissions WHERE round_number < \?/);
            expect(del.firstCall.args[1]).to.deep.equal([900]);
        });

        it('is a no-op when retention is disabled (0)', async function () {
            or.submissionsRetentionRounds = 0;
            or.currentRound = 1000;
            let del = sinon.stub().resolves({});
            hub.db.doQuery = del;
            await or._pruneSubmissionsDb();
            expect(del.called).to.be.false;
        });

        it('is a no-op before the deployment has run a full window of rounds', async function () {
            or.submissionsRetentionRounds = 12960;
            or.currentRound = 50;
            let del = sinon.stub().resolves({});
            hub.db.doQuery = del;
            await or._pruneSubmissionsDb();
            expect(del.called).to.be.false;
        });

        it('defaults to a bounded window (does not grow unbounded)', function () {
            let fresh = new OracleRound(createMockHub({ p2pConfig: {} }));
            expect(fresh.submissionsRetentionRounds).to.be.a('number');
            expect(fresh.submissionsRetentionRounds).to.be.greaterThan(0);
        });
    });

    // ── ORACLE_SUBMISSIONS_RETENTION_ROUNDS is actually reachable (item 2664) ─
    //
    // OracleRound reads this knob off hub.p2pConfig, which is a fixed object literal
    // in src/api.js. The key was absent from that literal, so it was always undefined:
    // parseInt(undefined) -> NaN -> the 12960 default won on every deployment and the
    // documented "0 disables pruning" setting was unreachable. The consumer-side
    // behaviour below passed even then, which is exactly why the source-side assertion
    // is here too: it is the half that was actually broken.

    describe('ORACLE_SUBMISSIONS_RETENTION_ROUNDS wiring', function () {
        const fs   = require('fs');
        const path = require('path');

        // Brace-match the `const p2pConfig = P2P_VALIDATOR_ADDR ? { ... }` literal.
        function p2pConfigLiteral() {
            const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
            const at  = src.indexOf('const p2pConfig = P2P_VALIDATOR_ADDR ? {');
            expect(at, 'p2pConfig literal not found in src/api.js').to.not.equal(-1);
            const open = src.indexOf('{', at);
            let depth = 0;
            for (let i = open; i < src.length; i++) {
                if (src[i] === '{') depth++;
                else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
            }
            throw new Error('unbalanced p2pConfig literal in src/api.js');
        }

        it('the key is present in the api.js p2pConfig literal', function () {
            expect(p2pConfigLiteral()).to.match(/\n\s*ORACLE_SUBMISSIONS_RETENTION_ROUNDS\s*:/,
                'OracleRound reads this off hub.p2pConfig; absent from the literal it is permanently '
                + 'undefined and the retention window is un-tunable');
        });

        it('is passed through unparsed so an explicit 0 survives', function () {
            const line = /ORACLE_SUBMISSIONS_RETENTION_ROUNDS\s*:\s*([^\n,]+)/.exec(p2pConfigLiteral());
            expect(line, 'ORACLE_SUBMISSIONS_RETENTION_ROUNDS not wired').to.not.equal(null);
            expect(line[1].trim()).to.equal('process.env.ORACLE_SUBMISSIONS_RETENTION_ROUNDS',
                'wrap it in parseInt(...) || DEFAULT and the documented "0 disables pruning" setting '
                + 'collapses back to the default; OracleRound.js owns the parse and the default');
        });

        it('an operator-supplied window reaches the pruner', function () {
            const fresh = new OracleRound(createMockHub({
                p2pConfig: { ORACLE_SUBMISSIONS_RETENTION_ROUNDS: '500' }
            }));
            expect(fresh.submissionsRetentionRounds).to.equal(500);
        });

        it('an explicit 0 disables pruning rather than falling back to the default', function () {
            const fresh = new OracleRound(createMockHub({
                p2pConfig: { ORACLE_SUBMISSIONS_RETENTION_ROUNDS: '0' }
            }));
            expect(fresh.submissionsRetentionRounds).to.equal(0);
        });

        it('a garbage or negative value falls back to the bounded default', function () {
            for (const bad of ['nonsense', '-5', '']) {
                const fresh = new OracleRound(createMockHub({
                    p2pConfig: { ORACLE_SUBMISSIONS_RETENTION_ROUNDS: bad }
                }));
                expect(fresh.submissionsRetentionRounds, 'value ' + JSON.stringify(bad)).to.equal(12960);
            }
        });
    });

    // ── ORACLE_MAX_SUBMISSIONS_PER_ROUND is actually reachable ─
    //
    // Same dead-knob mechanism as ORACLE_SUBMISSIONS_RETENTION_ROUNDS above: the key
    // was missing from the api.js p2pConfig literal, so this.config.ORACLE_MAX_
    // SUBMISSIONS_PER_ROUND was undefined on every deployment and the 200 default
    // won no matter what the operator exported. The consumer-side assertions passed
    // even then, so the source-side shape check is the half that matters.

    describe('ORACLE_MAX_SUBMISSIONS_PER_ROUND wiring', function () {
        const fs   = require('fs');
        const path = require('path');

        // Brace-match the `const p2pConfig = P2P_VALIDATOR_ADDR ? { ... }` literal.
        function p2pConfigLiteral() {
            const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
            const at  = src.indexOf('const p2pConfig = P2P_VALIDATOR_ADDR ? {');
            expect(at, 'p2pConfig literal not found in src/api.js').to.not.equal(-1);
            const open = src.indexOf('{', at);
            let depth = 0;
            for (let i = open; i < src.length; i++) {
                if (src[i] === '{') depth++;
                else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
            }
            throw new Error('unbalanced p2pConfig literal in src/api.js');
        }

        it('the key is present in the api.js p2pConfig literal', function () {
            expect(p2pConfigLiteral()).to.match(/\n\s*ORACLE_MAX_SUBMISSIONS_PER_ROUND\s*:/,
                'OracleRound reads this off hub.p2pConfig; absent from the literal it is permanently '
                + 'undefined and the per-round submission cap is un-tunable');
        });

        it('is passed through unparsed so the consumer owns the parse and the default', function () {
            const line = /ORACLE_MAX_SUBMISSIONS_PER_ROUND\s*:\s*([^\n,]+)/.exec(p2pConfigLiteral());
            expect(line, 'ORACLE_MAX_SUBMISSIONS_PER_ROUND not wired').to.not.equal(null);
            expect(line[1].trim()).to.equal('process.env.ORACLE_MAX_SUBMISSIONS_PER_ROUND',
                'a parseInt(...) || 200 tidy-up here forks the default into two files and lets the '
                + 'api.js copy eat values (0, negatives) that OracleRound.js handles deliberately');
        });

        it('an operator-supplied cap reaches the ingest guard', function () {
            const fresh = new OracleRound(createMockHub({
                p2pConfig: { ORACLE_MAX_SUBMISSIONS_PER_ROUND: '25' }
            }));
            expect(fresh.maxSubmissionsPerRound).to.equal(25);
        });

        it('an explicit 0 falls back to the default rather than stalling the round', function () {
            // 0 is not a "disable" here (contrast the retention knob): the cap gates
            // ingest, so honouring 0 would drop every peer submission silently.
            const fresh = new OracleRound(createMockHub({
                p2pConfig: { ORACLE_MAX_SUBMISSIONS_PER_ROUND: '0' }
            }));
            expect(fresh.maxSubmissionsPerRound).to.equal(200);
        });

        it('garbage, negative and absent values fall back to the default', function () {
            for (const bad of ['nonsense', '-5', '', undefined]) {
                const fresh = new OracleRound(createMockHub({
                    p2pConfig: { ORACLE_MAX_SUBMISSIONS_PER_ROUND: bad }
                }));
                expect(fresh.maxSubmissionsPerRound, 'value ' + JSON.stringify(bad)).to.equal(200);
            }
        });
    });

    // ── _persistSubmissions: pubkey fallbacks ────────────────────────────────

    describe('_persistSubmissions(): pubkey fallbacks', function () {
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

    describe('getSubmissionsInfo(): DB error', function () {
        it('returns info without skippedRounds when DB query fails', async function () {
            hub.db.doQuery = sinon.stub().rejects(new Error('db error'));
            await or._executeRound();
            let info = await or.getSubmissionsInfo();
            expect(info).to.have.property('currentRound');
            expect(info.skippedRounds).to.deep.equal([]);
            expect(info.droppedPairs).to.deep.equal([]);
            // Item 5548: the failure is marked, so the empty arrays cannot be
            // mistaken for a clean round downstream.
            expect(info.skippedRoundsReadError).to.equal(true);
            expect(info.droppedPairsReadError).to.equal(true);
        });

        it('marks both read flags false when the diagnostic reads succeed', async function () {
            hub.db.doQuery = sinon.stub().resolves([]);
            let info = await or.getSubmissionsInfo();
            expect(info.skippedRoundsReadError).to.equal(false);
            expect(info.droppedPairsReadError).to.equal(false);
        });
    });

    // ── getSubmissionsInfo: whole-round skips vs per-pair drops (item #180) ──

    describe('getSubmissionsInfo(): skipped rounds and per-pair drops', function () {
        it('separates whole-round skips (skippedRounds) from per-pair drops (droppedPairs)', async function () {
            hub.db.doQuery = sinon.stub().callsFake(async (sql) => {
                if (/NOT EXISTS/i.test(sql)) return [{ round_number: 41 }, { round_number: 40 }];
                if (/coin_pair/i.test(sql))  return [{ round_number: 42, coin_pair: 'LTC/USD' }];
                return [];
            });
            let info = await or.getSubmissionsInfo();
            expect(info.skippedRounds).to.deep.equal([41, 40]);
            expect(info.skippedCount).to.equal(2);
            expect(info.droppedPairs).to.deep.equal([{ round: 42, coinPair: 'LTC/USD' }]);
            expect(info.droppedPairCount).to.equal(1);
        });
    });

    // ── getSubmissionsInfo: PBFT round-timeout counter (reviews 1468/1469) ───

    describe('getSubmissionsInfo(): round_timeouts', function () {
        it('surfaces the consensus _roundTimeouts counter', async function () {
            or.setConsensus({ _roundTimeouts: 3 });
            let info = await or.getSubmissionsInfo();
            expect(info.round_timeouts).to.equal(3);
        });

        it('defaults to 0 when no consensus is wired or the counter is unset', async function () {
            let info = await or.getSubmissionsInfo();
            expect(info.round_timeouts).to.equal(0);
            or.setConsensus({});
            info = await or.getSubmissionsInfo();
            expect(info.round_timeouts).to.equal(0);
        });
    });
});
