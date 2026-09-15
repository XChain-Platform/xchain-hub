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



        const { formatXchainPriceMeta } = require('../../../../src/oracle/round');

        const WINDOW = { fromBlockExclusive: 1925, toBlockInclusive: 2925 };

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

function registerConfiguration2Tests1() {
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

}

function registerXchainpricegateopenWhetherThisRoundCarries3Tests4() {

        it('is CLOSED before the network resolves, so a hub that cannot tell stays quiet', function () {
            // currentBtcNetwork is only set by a successful per-round resolve. A hub
            // that does not know its own network must not guess: composing where the
            // gate is shut puts a pair in a signed round that every peer rejects wholesale.
            expect(or.currentBtcNetwork).to.equal(undefined);
            or.currentRound = 100;
            expect(or.xchainPriceGateOpen()).to.equal(false);
        });

        it('is CLOSED on a network this hub does not recognize', function () {
            // The closed-venue axis (mainnet is armed, so an unrecognized network carries
            // it). It must never compose: a pair in a signed round that peers reject kills
            // all 36.
            or.currentBtcNetwork = 'signet';
            or.currentRound = 100;
            expect(or.xchainPriceGateOpen()).to.equal(false);
        });

        it('is OPEN on every shipped network, mainnet included since the 2026-09-09 ruling', function () {
            // Mainnet armed at genesis: 0 PRICE actions have ever been indexed on any
            // mainnet chain (measured 2026-09-09), so composing from block 0 reinterprets
            // no signed round and native-coin fees are payable from the first one.
            or.currentRound = 100;
            for (const net of ['mainnet', 'regtest', 'testnet']) {
                or.currentBtcNetwork = net;
                expect(or.xchainPriceGateOpen(), net).to.equal(true);
            }
        });

        it('reads the round number, not the wall clock', function () {
            // The gate must be reproducible for a given round on every hub. Anything
            // that consults Date.now() at composition time reintroduces the skew the
            // round-start key exists to remove.
            //
            // Every shipped network is genesis-on since the 2026-09-09 ruling, so the
            // crossing is driven through a temporary network with a future threshold:
            // the subject is which KEY the gate reads, not which network is armed.
            const NET = 'boundarynet';
            XCHAIN_PRICE_ACTIVATION[NET] = 1790000000;
            try {
                or.currentBtcNetwork = NET;
                or.epochStart = 0;
                or.roundInterval = 1000;
                // Round number x 1s interval, so the round whose START crosses the
                // threshold is the one that opens the gate, regardless of when it is asked.
                or.currentRound = 1789999999;
                expect(or.xchainPriceGateOpen()).to.equal(false);
                or.currentRound = 1790000000;
                expect(or.xchainPriceGateOpen()).to.equal(true);
            } finally { delete XCHAIN_PRICE_ACTIVATION[NET]; }
        });
}

function registerXchainpricegateopenWhetherThisRoundCarries3Tests8() {

        it('is CLOSED when the round number is not yet a real round', function () {
            or.currentBtcNetwork = 'regtest';
            or.currentRound = null;
            expect(or.xchainPriceGateOpen()).to.equal(false);
        });

}

function registerFormatxchainpricemetaTheDerivationAuditLine4Tests9() {

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
}

function registerFormatxchainpricemetaTheDerivationAuditLine4Tests12() {

        it('renders an unknown window without throwing or inventing a range', function () {
            // The line must survive a shape it did not expect: a logging crash inside
            // the submission path would take the whole round's 36 pairs with it.
            expect(formatXchainPriceMeta({ derived: false, carriedFrom: 'bootstrap' }))
                .to.contain('window (?, ?]');
            expect(formatXchainPriceMeta(null)).to.equal('(no metadata)');
        });

}

function registerExecuteround5Tests13() {

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
}

function registerExecuteround5Tests18() {

        it('skips round when price fetch throws', async function () {
            mockPriceFetcher.fetchPrices.rejects(new Error('API down'));
            await or._executeRound();

            expect(pm.broadcast.called).to.be.false;
        });

        // item 4942: a local fetch failure is not a skipped ROUND. The round is still
        // scheduled for finalization and peers may salvage it, so the streak advances
        // only when consensus makes the skip durable - the same round set
        // hydrateFreshnessCounters counts back after a restart. Counting it here also
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
            // markLocallySkipped emits exactly once per round.
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
}

function registerExecuteround5Tests23() {

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

}

describe('OracleRound', function () {
    registerOracleround1Hooks();



    // -----------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------
    describe('configuration', function () {
        registerConfiguration2Tests1();
    });



    // -----------------------------------------------------------------
    // step 5: the XCHAIN/USD composition gate
    // -----------------------------------------------------------------
    describe('xchainPriceGateOpen(): whether this round carries the derived pair', function () {
        registerXchainpricegateopenWhetherThisRoundCarries3Tests4();
        registerXchainpricegateopenWhetherThisRoundCarries3Tests8();
    });



    // -----------------------------------------------------------------
    // step 6: the per-round derivation audit line
    // -----------------------------------------------------------------
    describe('formatXchainPriceMeta(): the derivation audit line', function () {
        registerFormatxchainpricemetaTheDerivationAuditLine4Tests9();
        registerFormatxchainpricemetaTheDerivationAuditLine4Tests12();
    });



    // -----------------------------------------------------------------
    // _executeRound()
    // -----------------------------------------------------------------
    describe('_executeRound()', function () {
        registerExecuteround5Tests13();
        registerExecuteround5Tests18();
        registerExecuteround5Tests23();
    });
});
