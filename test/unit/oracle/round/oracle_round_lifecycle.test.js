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

const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
const { createMockHub }     = require('../../../helpers/mockHub');
const { buildSubmissions, pubkeyForTestSender }  = require('../../../helpers/fixtures');
// The composition gate's own map. Every shipped network is genesis-on since the
// 2026-09-09 ruling, so the boundary case below installs a temporary network on it.
const { XCHAIN_PRICE_ACTIVATION } = require('../../../../src/xchain_price_activation.js');



    let hub, pm, or, mockPriceFetcher, OracleRound;



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

function registerOracleround1Hooks() {

    beforeEach(function () {
        // Stub PriceFetcher to avoid real HTTP
        mockPriceFetcher = {
            fetchPrices: sinon.stub().resolves([
                { coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }
            ])
        };

        OracleRound = proxyquire('../../../../src/oracle/round', {
            './price_fetcher': function () { return mockPriceFetcher; }
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
}

function registerColdStartHydrationStart4Hooks() {

        beforeEach(function () {
            // We only exercise hydration here, not the scheduler: stub the timer
            // setup so start() leaves no real timers running after the test.
            sinon.stub(or, 'startRoundTimer');
        });
}

function registerPeerSubmissionHandling2Tests1() {

        it('records peer submission for current round', async function () {
            await or.executeRound(); // sets currentRound
            let round = or.getCurrentRound();

            or.handleMessage({
                type:   'ORACLE_PRICE_SUBMIT',
                sender: 'ws://peer-1:10001', sig_pubkey: pubkeyForTestSender('ws://peer-1:10001'),
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
            await or.executeRound();
            let round = or.getCurrentRound();

            or.handleMessage({
                type: 'ORACLE_PRICE_SUBMIT', sender: 'ws://peer-1:10001', sig_pubkey: pubkeyForTestSender('ws://peer-1:10001'),
                data: { round, prices: [{ coinPair: 'BTC/USD', price: '111' }], sources: 1, timestamp: Date.now() }
            });
            or.handleMessage({
                type: 'ORACLE_PRICE_SUBMIT', sender: 'ws://peer-1:10001', sig_pubkey: pubkeyForTestSender('ws://peer-1:10001'),
                data: { round, prices: [{ coinPair: 'BTC/USD', price: '222' }], sources: 1, timestamp: Date.now() }
            });

            let subs = or.getSubmissions(round);
            let sub = subs.get('ws://peer-1:10001');
            expect(sub.prices[0].price).to.equal('111'); // first wins
        });

        it('ignores non-ORACLE_PRICE_SUBMIT messages', function () {
            or.handleMessage({ type: 'HEARTBEAT', sender: 'x', sig_pubkey: pubkeyForTestSender('x'), data: {} });
            expect(or.getSubmissions(0)).to.be.undefined;
        });

}

function registerGetsubmissionsinfo3Tests4() {
        it('returns info object with core fields', async function () {
            await or.executeRound();
            let info = await or.getSubmissionsInfo();
            expect(info).to.have.property('currentRound');
            expect(info).to.have.property('roundInterval');
            expect(info).to.have.property('submissionWindow');
        });

        it('includes consecutiveSkippedRounds and lastSuccessfulRoundTime', async function () {
            await or.executeRound();
            or.markRoundFinalized();
            let info = await or.getSubmissionsInfo();
            expect(info).to.have.property('consecutiveSkippedRounds').that.equals(0);
            expect(info).to.have.property('lastSuccessfulRoundTime').that.is.a('number');
        });

        it('reflects skipped count when rounds fail', async function () {
            mockPriceFetcher.fetchPrices.rejects(new Error('feed down'));
            await or.executeRound();
            // The durable skip is what advances the streak (item 4942).
            or.noteRoundSkipped();
            let info = await or.getSubmissionsInfo();
            expect(info.consecutiveSkippedRounds).to.equal(1);
            expect(info.lastSuccessfulRoundTime).to.be.null;
        });

}

function registerColdStartHydrationStart4Tests7() {

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

}

function registerAdditionalCoverage5Tests10() {
        it('setConsensus wires the consensus engine', function () {
            let c = { finalizeRound: sinon.stub() };
            or.setConsensus(c);
            expect(or.oracleConsensus).to.equal(c);
        });

        it('handleMessage initializes the submission map for a not-yet-seen round', async function () {
            await or.executeRound();              // sets currentRound + its own round map
            let next = or.getCurrentRound() + 1;   // a round with no map yet
            or.handleMessage({
                type: 'ORACLE_PRICE_SUBMIT', sender: 'ws://peer-9:10001', sig_pubkey: pubkeyForTestSender('ws://peer-9:10001'),
                data: { round: next, prices: [{ coinPair: 'BTC/USD', price: '123' }], sources: 1, timestamp: Date.now() }
            });
            expect(or.getSubmissions(next).has('ws://peer-9:10001')).to.be.true;
        });

        it('startRoundTimer schedules an aligned execution plus a steady interval', function () {
            let clock = sinon.useFakeTimers({ now: or.epochStart + 1000 }); // 1s into a round
            let exec = sinon.stub(or, 'executeRound').resolves();
            or.startRoundTimer();

            clock.tick(5001);                       // initial-delay timer (1000+5000 < window)
            expect(exec.callCount).to.be.greaterThan(0);
            clock.tick(Number(or.roundInterval));   // next boundary + first interval tick
            expect(exec.callCount).to.be.greaterThan(1);

            if (or.initialRoundTimer) clearTimeout(or.initialRoundTimer);
            if (or.roundTimer) clearInterval(or.roundTimer);
            clock.restore();
        });

}

describe('OracleRound', function () {
    registerOracleround1Hooks();



    // -----------------------------------------------------------------
    // Peer submission handling
    // -----------------------------------------------------------------
    describe('peer submission handling', function () {
        registerPeerSubmissionHandling2Tests1();
    });



    // -----------------------------------------------------------------
    // getSubmissionsInfo()
    // -----------------------------------------------------------------
    describe('getSubmissionsInfo()', function () {
        registerGetsubmissionsinfo3Tests4();
    });



    // -----------------------------------------------------------------
    // Cold-start hydration of freshness counters from price_snapshots.
    // Regression guard: before this, start() left consecutiveSkippedRounds at 0
    // and lastSuccessfulRoundTime at null after any restart, so a hub that came
    // back up mid-outage looked clean even though the durable record showed a gap.
    // -----------------------------------------------------------------
    describe('cold-start hydration (start)', function () {
        registerColdStartHydrationStart4Hooks();
        registerColdStartHydrationStart4Tests7();
    });



    // -----------------------------------------------------------------
    // setConsensus / scheduler / fresh-round submission map
    // -----------------------------------------------------------------
    describe('additional coverage', function () {
        registerAdditionalCoverage5Tests10();
    });
});
