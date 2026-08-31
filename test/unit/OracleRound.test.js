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
const { createMockHub }     = require('../helpers/mockHub');
const { buildSubmissions, pubkeyForTestSender }  = require('../helpers/fixtures');

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
    // step 5: the XCHAIN/USD composition gate
    // -----------------------------------------------------------------

    describe('_xchainPriceGateOpen(): whether this round carries the derived pair', function () {

        it('is CLOSED before the network resolves, so a hub that cannot tell stays quiet', function () {
            // currentBtcNetwork is only set by a successful per-round resolve. A hub
            // that does not know its own network must not guess: composing on mainnet
            // before D6 puts a pair in a signed round that every peer rejects wholesale.
            expect(or.currentBtcNetwork).to.equal(undefined);
            or.currentRound = 100;
            expect(or._xchainPriceGateOpen()).to.equal(false);
        });

        it('is CLOSED on mainnet, which is unarmed pending D6', function () {
            or.currentBtcNetwork = 'mainnet';
            or.currentRound = 100;
            expect(or._xchainPriceGateOpen()).to.equal(false);
        });

        it('is OPEN on regtest and testnet, which are genesis-on', function () {
            or.currentRound = 100;
            or.currentBtcNetwork = 'regtest';
            expect(or._xchainPriceGateOpen()).to.equal(true);
            or.currentBtcNetwork = 'testnet';
            expect(or._xchainPriceGateOpen()).to.equal(true);
        });

        it('reads the round number, not the wall clock', function () {
            // The gate must be reproducible for a given round on every hub. Anything
            // that consults Date.now() at composition time reintroduces the skew the
            // round-start key exists to remove.
            or.currentBtcNetwork = 'mainnet';
            or.epochStart = 0;
            or.roundInterval = 1000;
            // Round number x 1s interval, so the round whose start crosses the mainnet
            // sentinel is the one that opens the gate - regardless of when it is asked.
            or.currentRound = 9999999998;
            expect(or._xchainPriceGateOpen()).to.equal(false);
            or.currentRound = 9999999999;
            expect(or._xchainPriceGateOpen()).to.equal(true);
        });

        it('is CLOSED when the round number is not yet a real round', function () {
            or.currentBtcNetwork = 'regtest';
            or.currentRound = null;
            expect(or._xchainPriceGateOpen()).to.equal(false);
        });
    });

    // -----------------------------------------------------------------
    // step 6: the per-round derivation audit line
    // -----------------------------------------------------------------

    describe('formatXchainPriceMeta(): the derivation audit line', function () {

        const { formatXchainPriceMeta } = require('../../src/OracleRound');
        const WINDOW = { fromBlockExclusive: 1925, toBlockInclusive: 2925 };

        it('records every input behind a derived print', function () {
            // §5's promise that manipulation is "visible" depends entirely on this line
            // existing, so the spec enumerates the fields and this asserts them.
            const line = formatXchainPriceMeta({
                derived: true, window: WINDOW,
                usedFills: 4, clampedFills: 1, droppedFills: 2,
                btcVolume: '0.05000000', totalXchain: '1000.00000000',
                rawXchainBtc: '0.00050500', xchainBtc: '0.00001500',
                refRate: '0.00001000',
            });
            expect(line).to.contain('window (1925, 2925]');
            expect(line).to.contain('4 fills');
            expect(line).to.contain('1 clamped');
            expect(line).to.contain('2 excluded');
            expect(line).to.contain('vol 0.05000000 BTC / 1000.00000000 XCHAIN');
            expect(line).to.contain('ref 0.00001000');
        });

        it('shows the raw VWAP beside the published one, which is how a clamp is seen', function () {
            // Without both numbers a winsorized round is indistinguishable from a quiet
            // one: the published rate alone never reveals that the defence fired.
            const line = formatXchainPriceMeta({
                derived: true, window: WINDOW,
                usedFills: 2, clampedFills: 1, droppedFills: 0,
                btcVolume: '0.10100000', totalXchain: '200.00000000',
                rawXchainBtc: '0.00050500', xchainBtc: '0.00001500',
                refRate: '0.00001000',
            });
            expect(line).to.contain('raw 0.00050500 -> published 0.00001500 BTC');
        });

        it('distinguishes a quiet market from a market it chose not to follow', function () {
            // The failure this guards: with supersession disabled, every round prints the
            // carry-forward, and an operator reading only the price cannot tell whether
            // trades happened. The volume and the threshold must both be on the line.
            const held = formatXchainPriceMeta({
                derived: false, window: WINDOW, fillCount: 3,
                carriedFrom: 'bootstrap',
                reason: 'supersession disabled (D2 threshold undecided)',
                btcVolume: '0.01100000', minBtcVolume: null,
                wouldHaveBeen: '0.00220000',
            });
            expect(held).to.contain('carry-forward from bootstrap');
            expect(held).to.contain('3 fills in window');
            expect(held).to.contain('supersession disabled');
            expect(held).to.contain('vol 0.01100000 BTC vs threshold DISABLED');
            expect(held).to.contain('would have been 0.00220000 BTC');

            const quiet = formatXchainPriceMeta({
                derived: false, window: WINDOW, fillCount: 0, carriedFrom: 'last-finalized',
            });
            expect(quiet).to.contain('0 fills in window');
            expect(quiet).to.not.contain('vs threshold');
        });

        it('renders an unknown window without throwing or inventing a range', function () {
            // The line must survive a shape it did not expect: a logging crash inside
            // the submission path would take the whole round's 36 pairs with it.
            expect(formatXchainPriceMeta({ derived: false, carriedFrom: 'bootstrap' }))
                .to.contain('window (?, ?]');
            expect(formatXchainPriceMeta(null)).to.equal('(no metadata)');
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

        // item 4942: a local fetch failure is not a skipped ROUND. The round is still
        // scheduled for finalization and peers may salvage it, so the streak advances
        // only when consensus makes the skip durable - the same round set
        // _hydrateFreshnessCounters counts back after a restart. Counting it here also
        // double-counted a round that went on to hit the chain-tip-fallback skip.
        it('does not advance the skip streak on fetch failure alone', async function () {
            mockPriceFetcher.fetchPrices.rejects(new Error('API down'));
            await or._executeRound();

            expect(or.consecutiveSkippedRounds).to.equal(0);
            expect(or.lastSuccessfulRoundTime).to.be.null;
        });

        it('does not advance the skip streak on an empty price set alone', async function () {
            mockPriceFetcher.fetchPrices.resolves([]);
            await or._executeRound();

            expect(or.consecutiveSkippedRounds).to.equal(0);
            expect(or.lastSuccessfulRoundTime).to.be.null;
        });

        it('advances the skip streak once per durably-skipped round', function () {
            // noteRoundSkipped() is wired to the consensus 'round:skipped' event, which
            // _markLocallySkipped emits exactly once per round.
            or.noteRoundSkipped();
            or.noteRoundSkipped();
            expect(or.consecutiveSkippedRounds).to.equal(2);
            expect(or.lastSuccessfulRoundTime).to.be.null;
        });

        it('does not clear the stall gauges on a successful local submission', async function () {
            // Simulate a prior durably-skipped round
            or.noteRoundSkipped();
            expect(or.consecutiveSkippedRounds).to.equal(1);

            // Force idempotency guard to allow a second execution
            or.lastExecutedRound = -1;

            // A successful local submission is NOT a finalized round: the gauges
            // must stay put so a commit-quorum stall (fetch succeeds, nothing
            // finalizes) remains visible.
            mockPriceFetcher.fetchPrices.resolves([
                { coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }
            ]);
            await or._executeRound();
            expect(or.consecutiveSkippedRounds).to.equal(1);
            expect(or.lastSuccessfulRoundTime).to.be.null;
        });

        it('resets consecutiveSkippedRounds and sets lastSuccessfulRoundTime on finalization', async function () {
            or.noteRoundSkipped();
            expect(or.consecutiveSkippedRounds).to.equal(1);

            // markRoundFinalized() is wired to the consensus 'round:finalized' event.
            let before = Date.now();
            or.markRoundFinalized();
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
            await or._executeRound();
            let round = or.getCurrentRound();

            or._handleMessage({
                type: 'ORACLE_PRICE_SUBMIT', sender: 'ws://peer-1:10001', sig_pubkey: pubkeyForTestSender('ws://peer-1:10001'),
                data: { round, prices: [{ coinPair: 'BTC/USD', price: '111' }], sources: 1, timestamp: Date.now() }
            });
            or._handleMessage({
                type: 'ORACLE_PRICE_SUBMIT', sender: 'ws://peer-1:10001', sig_pubkey: pubkeyForTestSender('ws://peer-1:10001'),
                data: { round, prices: [{ coinPair: 'BTC/USD', price: '222' }], sources: 1, timestamp: Date.now() }
            });

            let subs = or.getSubmissions(round);
            let sub = subs.get('ws://peer-1:10001');
            expect(sub.prices[0].price).to.equal('111'); // first wins
        });

        it('ignores non-ORACLE_PRICE_SUBMIT messages', function () {
            or._handleMessage({ type: 'HEARTBEAT', sender: 'x', sig_pubkey: pubkeyForTestSender('x'), data: {} });
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
            or.markRoundFinalized();
            let info = await or.getSubmissionsInfo();
            expect(info).to.have.property('consecutiveSkippedRounds').that.equals(0);
            expect(info).to.have.property('lastSuccessfulRoundTime').that.is.a('number');
        });

        it('reflects skipped count when rounds fail', async function () {
            mockPriceFetcher.fetchPrices.rejects(new Error('feed down'));
            await or._executeRound();
            // The durable skip is what advances the streak (item 4942).
            or.noteRoundSkipped();
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
            // We only exercise hydration here, not the scheduler: stub the timer
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
                type: 'ORACLE_PRICE_SUBMIT', sender: 'ws://peer-9:10001', sig_pubkey: pubkeyForTestSender('ws://peer-9:10001'),
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
