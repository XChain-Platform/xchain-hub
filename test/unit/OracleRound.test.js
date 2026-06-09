'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
const { createMockHub }     = require('../helpers/mockHub');
const { buildSubmissions }  = require('../helpers/fixtures');

describe('OracleRound', function () {

    let hub, pm, or, mockPriceFetcher, OracleRound;

    beforeEach(function () {
        // Stub PriceFetcher to avoid real HTTP
        mockPriceFetcher = {
            fetchPrices: sinon.stub().resolves([
                { coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }
            ])
        };

        OracleRound = proxyquire('../../src/OracleRound', {
            './PriceFetcher': function () { return mockPriceFetcher; }
        });

        hub = createMockHub({
            p2pConfig: {
                ORACLE_ROUND_INTERVAL:   '60000',
                ORACLE_SUBMISSION_WINDOW: '30000'
            }
        });
        pm = hub._peerManager;
        or = new OracleRound(hub);
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------

    describe('configuration', function () {
        it('reads round interval from config', function () {
            // Config values are strings; OracleRound may or may not parse
            expect(Number(or.roundInterval)).to.equal(60000);
        });

        it('reads submission window from config', function () {
            expect(Number(or.submissionWindow)).to.equal(30000);
        });

        it('uses defaults when config is empty', function () {
            let or2 = new OracleRound(createMockHub({ p2pConfig: {} }));
            expect(or2.roundInterval).to.equal(600000);
            expect(or2.submissionWindow).to.equal(180000);
        });
    });

    // -----------------------------------------------------------------
    // _executeRound()
    // -----------------------------------------------------------------

    describe('_executeRound()', function () {

        it('fetches prices and broadcasts ORACLE_PRICE_SUBMIT', async function () {
            await or._executeRound();

            expect(mockPriceFetcher.fetchPrices.calledOnce).to.be.true;
            expect(pm.broadcast.calledOnce).to.be.true;
            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PRICE_SUBMIT');
            expect(data.prices).to.deep.equal([
                { coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }
            ]);
        });

        it('records own submission in local map', async function () {
            await or._executeRound();

            let round = or.getCurrentRound();
            let subs = or.getSubmissions(round);
            expect(subs).to.be.an.instanceOf(Map);
            expect(subs.has(pm.validatorAddr)).to.be.true;
        });

        // BTC chain-tip anchor resolution. getChainTip (the pushed hub-DB tip) is
        // null in these mocks, so they exercise the resolver fallback added for hubs
        // not co-located with a BTC indexer.
        it('anchors on the direct indexer height when no pushed tip exists', async function () {
            // getChainTip stays null (mockHub default); the resolver returns a height.
            hub._resolveBtcLatestBlock.resolves(952913);
            await or._executeRound();

            expect(or.currentBtcBlockHeight).to.equal(952913);
            // A real height must clear the fallback so finalization is not suppressed.
            expect(or.chainTipFallbackActive).to.be.false;
            expect(or.lastSuccessfulChainTipFetchAt).to.be.a('number');
        });

        it('falls back to the round number when both tip sources are empty', async function () {
            // getChainTip null + resolver null (both mockHub defaults).
            await or._executeRound();

            expect(or.chainTipFallbackActive).to.be.true;
            expect(or.currentBtcBlockHeight).to.equal(or.getCurrentRound());
        });

        it('skips round when price fetch returns empty', async function () {
            mockPriceFetcher.fetchPrices.resolves([]);
            await or._executeRound();

            expect(pm.broadcast.called).to.be.false;
        });

        it('skips round when price fetch throws', async function () {
            mockPriceFetcher.fetchPrices.rejects(new Error('API down'));
            await or._executeRound();

            expect(pm.broadcast.called).to.be.false;
        });

        it('increments consecutiveSkippedRounds on fetch failure', async function () {
            mockPriceFetcher.fetchPrices.rejects(new Error('API down'));
            await or._executeRound();

            expect(or.consecutiveSkippedRounds).to.equal(1);
            expect(or.lastSuccessfulRoundTime).to.be.null;
        });

        it('increments consecutiveSkippedRounds on empty price set', async function () {
            mockPriceFetcher.fetchPrices.resolves([]);
            await or._executeRound();

            expect(or.consecutiveSkippedRounds).to.equal(1);
            expect(or.lastSuccessfulRoundTime).to.be.null;
        });

        it('resets consecutiveSkippedRounds and sets lastSuccessfulRoundTime on success', async function () {
            // Simulate prior skips
            mockPriceFetcher.fetchPrices.rejects(new Error('API down'));
            await or._executeRound();
            expect(or.consecutiveSkippedRounds).to.equal(1);

            // Force idempotency guard to allow a second execution
            or.lastExecutedRound = -1;

            // Now a successful round
            mockPriceFetcher.fetchPrices.resolves([
                { coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }
            ]);
            let before = Date.now();
            await or._executeRound();
            let after = Date.now();

            expect(or.consecutiveSkippedRounds).to.equal(0);
            expect(or.lastSuccessfulRoundTime).to.be.at.least(before);
            expect(or.lastSuccessfulRoundTime).to.be.at.most(after);
        });
    });

    // -----------------------------------------------------------------
    // Peer submission handling
    // -----------------------------------------------------------------

    describe('peer submission handling', function () {

        it('records peer submission for current round', async function () {
            await or._executeRound(); // sets currentRound
            let round = or.getCurrentRound();

            or._handleMessage({
                type:   'ORACLE_PRICE_SUBMIT',
                sender: 'ws://peer-1:10001',
                data: {
                    round:  round,
                    prices: [{ coinPair: 'BTC/USD', price: '100001', sources: 1 }],
                    sources: 1,
                    timestamp: Date.now()
                }
            });

            let subs = or.getSubmissions(round);
            expect(subs.has('ws://peer-1:10001')).to.be.true;
        });

        it('first submission wins (duplicate sender ignored)', async function () {
            await or._executeRound();
            let round = or.getCurrentRound();

            or._handleMessage({
                type: 'ORACLE_PRICE_SUBMIT', sender: 'ws://peer-1:10001',
                data: { round, prices: [{ coinPair: 'BTC/USD', price: '111' }], sources: 1, timestamp: Date.now() }
            });
            or._handleMessage({
                type: 'ORACLE_PRICE_SUBMIT', sender: 'ws://peer-1:10001',
                data: { round, prices: [{ coinPair: 'BTC/USD', price: '222' }], sources: 1, timestamp: Date.now() }
            });

            let subs = or.getSubmissions(round);
            let sub = subs.get('ws://peer-1:10001');
            expect(sub.prices[0].price).to.equal('111'); // first wins
        });

        it('ignores non-ORACLE_PRICE_SUBMIT messages', function () {
            or._handleMessage({ type: 'HEARTBEAT', sender: 'x', data: {} });
            expect(or.getSubmissions(0)).to.be.undefined;
        });
    });

    // -----------------------------------------------------------------
    // getSubmissionsInfo()
    // -----------------------------------------------------------------

    describe('getSubmissionsInfo()', function () {
        it('returns info object with core fields', async function () {
            await or._executeRound();
            let info = await or.getSubmissionsInfo();
            expect(info).to.have.property('currentRound');
            expect(info).to.have.property('roundInterval');
            expect(info).to.have.property('submissionWindow');
        });

        it('includes consecutiveSkippedRounds and lastSuccessfulRoundTime', async function () {
            await or._executeRound();
            let info = await or.getSubmissionsInfo();
            expect(info).to.have.property('consecutiveSkippedRounds').that.equals(0);
            expect(info).to.have.property('lastSuccessfulRoundTime').that.is.a('number');
        });

        it('reflects skipped count when rounds fail', async function () {
            mockPriceFetcher.fetchPrices.rejects(new Error('feed down'));
            await or._executeRound();
            let info = await or.getSubmissionsInfo();
            expect(info.consecutiveSkippedRounds).to.equal(1);
            expect(info.lastSuccessfulRoundTime).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // Cold-start hydration of freshness counters from price_snapshots.
    // Regression guard: before this, start() left consecutiveSkippedRounds at 0
    // and lastSuccessfulRoundTime at null after any restart, so a hub that came
    // back up mid-outage looked clean even though the durable record showed a gap.
    // -----------------------------------------------------------------

    describe('cold-start hydration (start)', function () {

        // Route the two hydration queries by SQL shape. The first returns the most
        // recent finalized round (round_number + epoch-ms), the second the count of
        // trailing non-finalized rounds.
        function stubHydration(db, { lastFinalized, skipped }) {
            db.doQuery = sinon.stub().callsFake(async (sql) => {
                if (/status = 'finalized'[\s\S]*ORDER BY round_number DESC LIMIT 1/.test(sql)) {
                    return lastFinalized ? [lastFinalized] : [];
                }
                if (/COUNT\(DISTINCT round_number\) AS skipped/.test(sql)) {
                    return [{ skipped: skipped }];
                }
                return [];
            });
        }

        beforeEach(function () {
            // We only exercise hydration here, not the scheduler — stub the timer
            // setup so start() leaves no real timers running after the test.
            sinon.stub(or, '_startRoundTimer');
        });

        it('rehydrates skip streak and last-success time from pre-existing rounds', async function () {
            let finalizedMs = Date.now() - 3600000; // an hour ago
            stubHydration(hub.db, {
                lastFinalized: { round_number: 100, ms: finalizedMs },
                skipped:       5
            });

            await or.start();

            expect(or.consecutiveSkippedRounds).to.equal(5);
            expect(or.lastSuccessfulRoundTime).to.equal(finalizedMs);
        });

        it('leaves constructor defaults when no finalized round exists', async function () {
            stubHydration(hub.db, { lastFinalized: null, skipped: 3 });

            await or.start();

            // No finalized round ever → last-success stays null, but the skip streak
            // still reflects the recorded non-finalized rounds.
            expect(or.lastSuccessfulRoundTime).to.be.null;
            expect(or.consecutiveSkippedRounds).to.equal(3);
        });

        it('does not throw or block start() when hydration query fails', async function () {
            hub.db.doQuery = sinon.stub().rejects(new Error('db down'));

            await or.start();

            // Hydration is best-effort; a failure must leave the clean-slate defaults.
            expect(or.consecutiveSkippedRounds).to.equal(0);
            expect(or.lastSuccessfulRoundTime).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // setConsensus / scheduler / fresh-round submission map
    // -----------------------------------------------------------------

    describe('additional coverage', function () {
        it('setConsensus wires the consensus engine', function () {
            let c = { finalizeRound: sinon.stub() };
            or.setConsensus(c);
            expect(or.oracleConsensus).to.equal(c);
        });

        it('_handleMessage initializes the submission map for a not-yet-seen round', async function () {
            await or._executeRound();              // sets currentRound + its own round map
            let next = or.getCurrentRound() + 1;   // a round with no map yet
            or._handleMessage({
                type: 'ORACLE_PRICE_SUBMIT', sender: 'ws://peer-9:10001',
                data: { round: next, prices: [{ coinPair: 'BTC/USD', price: '123' }], sources: 1, timestamp: Date.now() }
            });
            expect(or.getSubmissions(next).has('ws://peer-9:10001')).to.be.true;
        });

        it('_startRoundTimer schedules an aligned execution plus a steady interval', function () {
            let clock = sinon.useFakeTimers({ now: or.epochStart + 1000 }); // 1s into a round
            let exec = sinon.stub(or, '_executeRound').resolves();
            or._startRoundTimer();

            clock.tick(5001);                       // initial-delay timer (1000+5000 < window)
            expect(exec.callCount).to.be.greaterThan(0);
            clock.tick(Number(or.roundInterval));   // next boundary + first interval tick
            expect(exec.callCount).to.be.greaterThan(1);

            if (or.initialRoundTimer) clearTimeout(or.initialRoundTimer);
            if (or.roundTimer) clearInterval(or.roundTimer);
            clock.restore();
        });
    });
});
