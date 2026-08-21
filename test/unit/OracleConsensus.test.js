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

const crypto           = require('crypto');
const sinon            = require('sinon');
const { expect }       = require('chai');
const OracleConsensus  = require('../../src/OracleConsensus');
const swq              = require('../../src/stake_weighted_quorum.js');
const { createMockHub }       = require('../helpers/mockHub');
const { waitUntil }           = require('../helpers/waitUntil');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, VALIDATORS_10, VALIDATORS_13,
        buildSubmissions, buildUniformSubmissions, SAMPLE_PRICES } = require('../helpers/fixtures');

describe('OracleConsensus', function () {

    let hub, pm, oc, oracleRound;

    beforeEach(function () {
        hub = createMockHub();
        pm  = hub._peerManager;
        oracleRound = {
            getSubmissions: sinon.stub().returns(new Map())
        };
        oc = new OracleConsensus(hub, oracleRound);
        // These cases exercise finalize/propose logic with small fixed submission sets and model a
        // configured single/small deployment, so use the regtest override (ORACLE_MIN_SUBMISSIONS=1).
        // The 2-hub default diversity floor is covered in OracleConsensus.propose-validation.test.js.
        oc.minSubmissions = 1;
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // _aggregate(): trimmed median
    // -----------------------------------------------------------------

    describe('_aggregate(): trimmed median', function () {

        function submissionsForPair(prices) {
            let entries = prices.map((p, i) => ({
                sender: 'validator-' + i,
                prices: [{ coinPair: 'BTC/USD', price: String(p) }]
            }));
            return buildSubmissions(entries);
        }

        it('single submission: returns that value', function () {
            let subs = submissionsForPair([100000]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100000.00000000');
        });

        it('two submissions: returns average (median of 2)', function () {
            let subs = submissionsForPair([100000, 100002]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100001.00000000');
        });

        it('two submissions just within the deviation gate: returns the mean', function () {
            // (105-95)/(105+95) = 0.05 = threshold; the 2-source gate is strictly
            // greater-than, so a spread exactly at the threshold still finalizes (item 4496).
            let subs = submissionsForPair([95, 105]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100.00000000');
        });

        it('two submissions beyond the deviation gate: drops the pair (returns null)', function () {
            // (110-90)/(110+90) = 0.10 > 0.05 threshold; the mean would put both sources
            // outside the slash threshold, so the pair is omitted this round (item 4496).
            let subs = submissionsForPair([90, 110]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.be.null;
        });

        it('two submissions a hair past the gate: drops the pair at scale 18', function () {
            // (110.52631579-100)/(110.52631579+100) = 0.050000000047500000, which the
            // old scale-8 publish gate truncated to 0.05000000 and passed while the
            // scale-18 co-sign gate and SlashDetector both read it as over the band.
            // Publishing here federation-signed a median the followers withhold and
            // the slash detector punishes the low submitter for.
            let subs = submissionsForPair(['100.00000000', '110.52631579']);
            expect(oc._aggregate(subs, 'BTC/USD')).to.be.null;
        });

        it('deviation gate does not apply to an odd count: three divergent submissions still finalize', function () {
            // An odd post-trim count medians to a REAL submitted value, so at least one
            // source stands behind the published price and the gate has nothing to refuse.
            let subs = submissionsForPair([100, 200, 300]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('200.00000000');
        });

        it('4 submissions in a 2-2 split: the post-trim pair trips the gate and drops (item 5333)', function () {
            // ceil(4 * 0.15) = 1 → after trim: [100, 111], whose mean 105.5 puts EVERY
            // submitter 5.21% out, past the 5% band. Gating only the RAW count missed this:
            // the leader published 105.5, every follower re-derived a single camp value over
            // the proposer-excluded set, tripped the co-sign band and rejected the whole
            // proposal, wedging the round for every pair.
            let subs = submissionsForPair([100, 100, 111, 111]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.be.null;
        });

        it('6 submissions in a 3-3 split: the gate still fires after the trim (item 5333)', function () {
            // ceil(6 * 0.15) = 1 → after trim: [100, 100, 111, 111] → middle pair 100/111.
            // A post-trim length of exactly 2 is not the only wedge shape.
            let subs = submissionsForPair([100, 100, 100, 111, 111, 111]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.be.null;
        });

        it('4 submissions split inside the band: still publishes the even-split mean', function () {
            // After trim: [100, 103] → spread 3/203 = 1.48% < 5%, so the pair publishes.
            let subs = submissionsForPair([100, 100, 103, 103]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('101.50000000');
        });

        it('three submissions: returns middle value', function () {
            let subs = submissionsForPair([100000, 100010, 100005]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100005.00000000');
        });

        it('all identical values: returns that value', function () {
            let subs = submissionsForPair([50000, 50000, 50000, 50000, 50000]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('50000.00000000');
        });

        it('7 submissions: trims top and bottom 15% (1 each)', function () {
            // 7 * 0.15 = 1.05, floor = 1 → trim 1 from each end
            let prices = [90000, 99000, 100000, 100100, 100200, 101000, 110000];
            let subs = submissionsForPair(prices);
            // After trim: [99000, 100000, 100100, 100200, 101000] → median = 100100
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100100.00000000');
        });

        it('10 submissions: trims 1 from each end', function () {
            // 10 * 0.15 = 1.5, floor = 1
            let prices = [1, 100, 101, 102, 103, 104, 105, 106, 107, 999];
            let subs = submissionsForPair(prices);
            // After trim: [100, 101, 102, 103, 104, 105, 106, 107] → median = (103+104)/2 = 103.5
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('103.50000000');
        });

        it('outlier resistance: extreme outlier in 7 submissions is trimmed', function () {
            let prices = [100000, 100001, 100002, 100003, 100004, 100005, 999999];
            let subs = submissionsForPair(prices);
            // After trim: [100001, 100002, 100003, 100004, 100005] → median = 100003
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100003.00000000');
        });

        it('returns 8-decimal fixed-point string', function () {
            let subs = submissionsForPair([1.5]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('1.50000000');
        });

        it('returns null for no submissions', function () {
            expect(oc._aggregate(new Map(), 'BTC/USD')).to.be.null;
        });

        it('returns null for unknown coin pair', function () {
            let subs = submissionsForPair([100]);
            expect(oc._aggregate(subs, 'ETH/USD')).to.be.null;
        });

        // Item #180: the clamp-emptied null path previously had NO log line at
        // all, so a pair whose every submission failed the >0/<PRICE_MAX clamp
        // vanished from the round with no signal.
        it('logs a drop warning naming the pair when no usable values survive the clamp', function () {
            let warn = sinon.stub(console, 'warn');
            try {
                expect(oc._aggregate(new Map(), 'BTC/USD')).to.be.null;
                expect(warn.calledOnce).to.be.true;
                expect(warn.firstCall.args[0]).to.include('BTC/USD');
                expect(warn.firstCall.args[0]).to.include('dropping');
            } finally {
                warn.restore();
            }
        });

        it('ignores zero and negative prices', function () {
            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '0' }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '-100' }] },
                { sender: 'v3', prices: [{ coinPair: 'BTC/USD', price: '50000' }] }
            ];
            let subs = buildSubmissions(entries);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('50000.00000000');
        });

        it('ignores NaN prices', function () {
            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: 'not-a-number' }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '42000' }] }
            ];
            let subs = buildSubmissions(entries);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('42000.00000000');
        });

        it('counts duplicate same-pair entries from one sender as a single data point', function () {
            // A sender may include N entries for the same pair in one submission.
            // Each sender must contribute at most one value, otherwise values.length
            // is inflated and the trim boundary (floor(N * 0.15)) shifts so the
            // duplicated outlier survives instead of being trimmed.
            //
            // Six honest senders at 100, plus one sender at 200 duplicated 20×.
            //   Deduped: [100×6, 200×1] → 7 values, trimCount=floor(7*0.15)=1,
            //            trim removes the 200 → median 100.
            //   If duplicates counted: [100×6, 200×20] → 26 values,
            //            trimCount=floor(26*0.15)=3, the 200s dominate → median 200.
            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100' }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '100' }] },
                { sender: 'v3', prices: [{ coinPair: 'BTC/USD', price: '100' }] },
                { sender: 'v4', prices: [{ coinPair: 'BTC/USD', price: '100' }] },
                { sender: 'v5', prices: [{ coinPair: 'BTC/USD', price: '100' }] },
                { sender: 'v6', prices: [{ coinPair: 'BTC/USD', price: '100' }] },
                { sender: 'attacker', prices: Array.from({ length: 20 },
                    () => ({ coinPair: 'BTC/USD', price: '200' })) }
            ];
            let subs = buildSubmissions(entries);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100.00000000');
        });

        it('uses the first valid entry per sender, skipping an invalid leading duplicate', function () {
            // The first entry for the pair is invalid (zero) and must be skipped;
            // the next valid entry is the sender's single data point. A single
            // valid value alone is returned as-is.
            let entries = [
                { sender: 'v1', prices: [
                    { coinPair: 'BTC/USD', price: '0' },       // skipped (invalid)
                    { coinPair: 'BTC/USD', price: '55000' },   // first valid → used
                    { coinPair: 'BTC/USD', price: '999999' }   // ignored (already have one)
                ]}
            ];
            let subs = buildSubmissions(entries);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('55000.00000000');
        });
    });

    // -----------------------------------------------------------------
    // _clampToLastFinalized(): per-pair bounded-change clamp
    // -----------------------------------------------------------------

    describe('_aggregate(): bounded-change clamp vs last finalized', function () {

        function submissionsForPair(prices) {
            let entries = prices.map((p, i) => ({
                sender: 'validator-' + i,
                prices: [{ coinPair: 'BTC/USD', price: String(p) }]
            }));
            return buildSubmissions(entries);
        }

        it('no finalized history: aggregate passes through unclamped', function () {
            let subs = submissionsForPair([100000, 100000, 100000]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('100000.00000000');
        });

        it('within the +/-25% band: aggregate passes through unchanged', function () {
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100000.00000000' }]);
            let subs = submissionsForPair([110000, 110000, 110000]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('110000.00000000');
        });

        it('exactly on the +25% boundary: not clamped', function () {
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100000.00000000' }]);
            let subs = submissionsForPair([125000, 125000, 125000]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('125000.00000000');
        });

        it('upward fat-tail spike: clamped to last * 1.25', function () {
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100000.00000000' }]);
            // Every source agrees on the spike (survives trim and median), so only
            // the clamp bounds it.
            let subs = submissionsForPair([500000, 500000, 500000]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('125000.00000000');
        });

        it('downward fat-tail crash: clamped to last * 0.75', function () {
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100000.00000000' }]);
            let subs = submissionsForPair([10000, 10000, 10000]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('75000.00000000');
        });

        it('sustained genuine move walks to the new level over successive rounds', function () {
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100000.00000000' }]);
            let subs = submissionsForPair([200000, 200000, 200000]);
            let r1 = oc._aggregate(subs, 'BTC/USD');
            expect(r1).to.equal('125000.00000000');
            // Round 1 finalizes at the clamped value; round 2 clamps from there.
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: r1 }]);
            let r2 = oc._aggregate(subs, 'BTC/USD');
            expect(r2).to.equal('156250.00000000');
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: r2 }]);
            let r3 = oc._aggregate(subs, 'BTC/USD');
            expect(r3).to.equal('195312.50000000');
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: r3 }]);
            // Fourth round reaches the true level (200000 < 195312.5 * 1.25).
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('200000.00000000');
        });

        it('clamp is per-pair: an unrelated pair with history does not clamp BTC/USD', function () {
            oc._updateLastFinalizedPrices([{ coinPair: 'LTC/USD', price: '100.00000000' }]);
            let subs = submissionsForPair([500000, 500000, 500000]);
            expect(oc._aggregate(subs, 'BTC/USD')).to.equal('500000.00000000');
        });

        it('a clamped aggregate stays within the propose-gate historical band (5x deviation)', function () {
            // Coherence check: ORACLE_MAX_CHANGE_PER_ROUND (0.25) must never exceed
            // 5 * ORACLE_DEVIATION_THRESHOLD, or a leader's clamped proposal would be
            // rejected by followers with no live submission for the pair.
            const { ORACLE_MAX_CHANGE_PER_ROUND, ORACLE_DEVIATION_THRESHOLD } = require('../../src/constants.js');
            expect(ORACLE_MAX_CHANGE_PER_ROUND).to.be.at.most(5 * ORACLE_DEVIATION_THRESHOLD);
        });
    });

    // -----------------------------------------------------------------
    // Per-pair clamp override for the derived pair
    // -----------------------------------------------------------------

    describe('_aggregate(): tighter per-pair clamp for XCHAIN/USD', function () {

        function subsFor(pair, prices) {
            return buildSubmissions(prices.map((p, i) => ({
                sender: 'validator-' + i,
                prices: [{ coinPair: pair, price: String(p) }]
            })));
        }

        it('bounds XCHAIN/USD at 10%/round, not the global 25%', function () {
            // XCHAIN trades in a market thin by construction pre-launch, so the generic
            // clamp is the wrong size for it: 25%/round compounds to roughly 10x in 80
            // minutes at the default cadence.
            oc._updateLastFinalizedPrices([{ coinPair: 'XCHAIN/USD', price: '2.00000000' }]);
            expect(oc._aggregate(subsFor('XCHAIN/USD', [10, 10, 10]), 'XCHAIN/USD')).to.equal('2.20000000');
        });

        it('bounds the DOWN direction identically: fee-cheapening is the other attack', function () {
            // §5 is explicit that the incentive is bidirectional - a lower XCHAIN/USD
            // makes native-coin fees cheaper for whoever pushed it there.
            oc._updateLastFinalizedPrices([{ coinPair: 'XCHAIN/USD', price: '2.00000000' }]);
            expect(oc._aggregate(subsFor('XCHAIN/USD', [0.01, 0.01, 0.01]), 'XCHAIN/USD')).to.equal('1.80000000');
        });

        it('leaves every other pair on the global bound', function () {
            // The override must not leak: BTC/USD tracks a deep external market and a
            // 10% cap would suppress genuine moves it should follow.
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100000.00000000' }]);
            expect(oc._aggregate(subsFor('BTC/USD', [500000, 500000, 500000]), 'BTC/USD')).to.equal('125000.00000000');
        });

        it('walks the bootstrap to a market level over rounds, never in one print', function () {
            // §7: an attacker who wash-trades exactly the volume threshold still cannot
            // set the first market print - it walks from the bootstrap at the clamp rate
            // like any other move, which is what buys the operator time to notice.
            oc._updateLastFinalizedPrices([{ coinPair: 'XCHAIN/USD', price: '2.00000000' }]);
            let subs = subsFor('XCHAIN/USD', [100, 100, 100]);
            let r1 = oc._aggregate(subs, 'XCHAIN/USD');
            expect(r1).to.equal('2.20000000');
            oc._updateLastFinalizedPrices([{ coinPair: 'XCHAIN/USD', price: r1 }]);
            expect(oc._aggregate(subs, 'XCHAIN/USD')).to.equal('2.42000000');
        });

        it('stays strictly inside the propose-gate band, which keeps the global bound', function () {
            // The load-bearing invariant behind the deliberate asymmetry in
            // _handlePropose: the follower gate is a strict SUPERSET of every per-pair
            // clamp, so a maximally-clamped aggregate always passes it. If a future
            // override were ever set LOOSER than the global bound, a clamped proposal
            // could be rejected by every honest follower and wedge the round.
            const { ORACLE_MAX_CHANGE_PER_ROUND, XCHAIN_PRICE_MAX_CHANGE_PER_ROUND } = require('../../src/constants.js');
            expect(XCHAIN_PRICE_MAX_CHANGE_PER_ROUND).to.be.at.most(ORACLE_MAX_CHANGE_PER_ROUND);
        });
    });

    // -----------------------------------------------------------------
    // _minRoundSources(): source-diversity health signal
    // -----------------------------------------------------------------

    describe('_minRoundSources()', function () {
        it('returns the minimum per-pair source count across all submissions', function () {
            let subs = buildSubmissions([
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100000', sources: 2 }, { coinPair: 'LTC/USD', price: '80', sources: 2 }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '100010', sources: 2 }, { coinPair: 'LTC/USD', price: '82', sources: 2 }] }
            ]);
            expect(oc._minRoundSources(subs)).to.equal(2);
        });

        it('drops to 1 when any submission reached a single upstream for a pair', function () {
            let subs = buildSubmissions([
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100000', sources: 2 }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '100010', sources: 1 }] }
            ]);
            expect(oc._minRoundSources(subs)).to.equal(1);
        });

        it('returns Infinity when no per-pair source count is present (cannot assess)', function () {
            let subs = buildSubmissions([
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ]);
            expect(oc._minRoundSources(subs)).to.equal(Infinity);
        });

        it('tolerates an empty / missing submission set', function () {
            expect(oc._minRoundSources(new Map())).to.equal(Infinity);
            expect(oc._minRoundSources(null)).to.equal(Infinity);
        });

        it('ignores CoinGecko-only-by-design pairs when a capable-pair set is supplied', function () {
            // BTC/MXN is CoinGecko-only (Kraken lists no MXN), so it reports sources=1
            // every healthy round; BTC/USD is multi-source-capable and healthy at 2.
            // Scoped to the capable set, the round reads as 2 (healthy), not 1.
            let subs = buildSubmissions([
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100000', sources: 2 }, { coinPair: 'BTC/MXN', price: '1700000', sources: 1 }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '100010', sources: 2 }, { coinPair: 'BTC/MXN', price: '1700100', sources: 1 }] }
            ]);
            let capable = new Set(['BTC/USD']);
            expect(oc._minRoundSources(subs, capable)).to.equal(2);
            // Without the filter the by-design single-source pair pins the minimum to 1.
            expect(oc._minRoundSources(subs)).to.equal(1);
        });

        it('still flags a genuine degradation on a multi-source-capable pair', function () {
            // BTC/USD is capable of 2 but only reached 1 this round -> real degradation.
            let subs = buildSubmissions([
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100000', sources: 1 }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '100010', sources: 1 }] }
            ]);
            expect(oc._minRoundSources(subs, new Set(['BTC/USD']))).to.equal(1);
        });
    });

    // -----------------------------------------------------------------
    // _aggregateAll()
    // -----------------------------------------------------------------

    describe('_aggregateAll()', function () {
        it('aggregates all unique coin pairs from submissions', function () {
            let entries = [
                { sender: 'v1', prices: [
                    { coinPair: 'BTC/USD', price: '100000' },
                    { coinPair: 'LTC/USD', price: '80' }
                ]},
                { sender: 'v2', prices: [
                    { coinPair: 'BTC/USD', price: '100002' },
                    { coinPair: 'LTC/USD', price: '82' }
                ]}
            ];
            let subs = buildSubmissions(entries);
            let result = oc._aggregateAll(subs);
            expect(result).to.have.lengthOf(2);
            let btc = result.find(r => r.coinPair === 'BTC/USD');
            let ltc = result.find(r => r.coinPair === 'LTC/USD');
            expect(btc.price).to.equal('100001.00000000');
            expect(ltc.price).to.equal('81.00000000');
        });

        it('returns empty array for empty submissions', function () {
            expect(oc._aggregateAll(new Map())).to.deep.equal([]);
        });
    });

    // -----------------------------------------------------------------
    // L4 determinism: trimmed-median aggregation (spec §6 / validator-test-spec)
    //
    // spec §6 "Determinism (L4)" item 3: same oracle round inputs → the same
    // trimmed-median on every finalizing hub. The median VALUE must not depend on
    // submission/iteration order, and two independently-constructed hubs must
    // agree on the per-pair result for the same submission multiset.
    // -----------------------------------------------------------------
    describe('L4 determinism: trimmed-median aggregation', function () {
        // Same multiset of {sender → price} submissions, two insertion orders.
        const fwd = [
            { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100000' }, { coinPair: 'LTC/USD', price: '80' }] },
            { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '100010' }, { coinPair: 'LTC/USD', price: '82' }] },
            { sender: 'v3', prices: [{ coinPair: 'BTC/USD', price: '100005' }, { coinPair: 'LTC/USD', price: '81' }] },
            { sender: 'v4', prices: [{ coinPair: 'BTC/USD', price: '99995'  }, { coinPair: 'LTC/USD', price: '79' }] },
            { sender: 'v5', prices: [{ coinPair: 'BTC/USD', price: '100020' }, { coinPair: 'LTC/USD', price: '83' }] }
        ];
        const rev  = fwd.slice().reverse();
        const norm = (arr) => new Map(arr.map(a => [a.coinPair, a.price]));
        const mkOc = () => new OracleConsensus(createMockHub(), { getSubmissions: sinon.stub().returns(new Map()) });

        it('per-pair median is invariant to submission/insertion order', function () {
            expect(oc._aggregate(buildSubmissions(fwd), 'BTC/USD'))
                .to.equal(oc._aggregate(buildSubmissions(rev), 'BTC/USD'));
            expect(oc._aggregate(buildSubmissions(fwd), 'LTC/USD'))
                .to.equal(oc._aggregate(buildSubmissions(rev), 'LTC/USD'));
        });

        it('two independent hubs derive the identical {pair → median} from the same submissions', function () {
            const ocA = mkOc(), ocB = mkOc();
            expect(norm(ocA._aggregateAll(buildSubmissions(fwd))))
                .to.deep.equal(norm(ocB._aggregateAll(buildSubmissions(rev))));
        });

        it('the {pair → median} mapping is order-insensitive', function () {
            expect(norm(oc._aggregateAll(buildSubmissions(fwd))))
                .to.deep.equal(norm(oc._aggregateAll(buildSubmissions(rev))));
        });

        // -------------------------------------------------------------
        // the FLAG this block used to carry is now FIXED.
        //
        // Was: _aggregateAll emitted results in coinPairs Set insertion order
        // (a function of submission ARRIVAL order) and _digest hashed the array
        // in that order via raw JSON.stringify, so a digest re-derived from a
        // hub's OWN aggregation depended on arrival order. Masked only because
        // followers re-hash the LEADER's propagated array.
        //
        // Now: _aggregateAll emits canonical pair order, and _digest
        // canonicalizes its own preimage independently (sorted by coinPair,
        // projected to String coinPair/price). Both are consensus-breaking and
        // ship ungated with a fleet-wide rebase.
        // -------------------------------------------------------------
        const canonical = (arr) => arr.slice().sort((a, b) => (a.coinPair < b.coinPair ? -1 : a.coinPair > b.coinPair ? 1 : 0));

        it('_aggregateAll emits canonical pair order regardless of submission arrival order', function () {
            let fwdAgg = oc._aggregateAll(buildSubmissions(fwd));
            let revAgg = oc._aggregateAll(buildSubmissions(rev));
            expect(fwdAgg).to.deep.equal(revAgg);
            expect(fwdAgg).to.deep.equal(canonical(fwdAgg));
            expect(fwdAgg.map(a => a.coinPair)).to.deep.equal(['BTC/USD', 'LTC/USD']);
        });

        it('_digest is order-invariant over the RAW local aggregation', function () {
            let fwdAgg = oc._aggregateAll(buildSubmissions(fwd));
            let revAgg = oc._aggregateAll(buildSubmissions(rev));
            expect(oc._digest(1, fwdAgg)).to.equal(oc._digest(1, revAgg));
        });

        // The digest must survive a payload that arrives in a different order
        // than the local aggregation produced: this is the wire case, where the
        // proposer's array is hashed by every follower.
        it('_digest ignores array order of an arbitrarily reordered price array', function () {
            let agg = oc._aggregateAll(buildSubmissions(fwd));
            expect(agg.length).to.be.greaterThan(1);
            expect(oc._digest(1, agg)).to.equal(oc._digest(1, agg.slice().reverse()));
        });

        // Key order and scalar TYPE are wire-serialization artifacts, not price
        // content; mirrors the DEX _canonicalMatch discipline.
        it('_digest is invariant to entry key order and to numeric-vs-string price', function () {
            let base     = [{ coinPair: 'BTC/USD', price: '100005' }, { coinPair: 'LTC/USD', price: '81' }];
            let keySwap  = [{ price: '81', coinPair: 'LTC/USD' }, { price: '100005', coinPair: 'BTC/USD' }];
            let numeric  = [{ coinPair: 'BTC/USD', price: 100005 }, { coinPair: 'LTC/USD', price: 81 }];
            expect(oc._digest(7, base)).to.equal(oc._digest(7, keySwap));
            expect(oc._digest(7, base)).to.equal(oc._digest(7, numeric));
        });

        // Projection to exactly [coinPair, price] means a padded field cannot
        // move the digest. Values themselves are bound by the per-pair semantic
        // validation on PROPOSE and by the separately signed PRICE v0 canonical.
        it('_digest ignores fields outside the canonical projection', function () {
            let base   = [{ coinPair: 'BTC/USD', price: '100005' }];
            let padded = [{ coinPair: 'BTC/USD', price: '100005', junk: 'x'.repeat(64) }];
            expect(oc._digest(3, base)).to.equal(oc._digest(3, padded));
        });

        it('_digest still separates different prices and different rounds', function () {
            let a = [{ coinPair: 'BTC/USD', price: '100005' }];
            let b = [{ coinPair: 'BTC/USD', price: '100006' }];
            expect(oc._digest(1, a)).to.not.equal(oc._digest(1, b));
            expect(oc._digest(1, a)).to.not.equal(oc._digest(2, a));
        });

        it('two independent hubs derive the identical digest from the same submissions in opposite order', function () {
            const ocA = mkOc(), ocB = mkOc();
            expect(ocA._digest(11, ocA._aggregateAll(buildSubmissions(fwd))))
                .to.equal(ocB._digest(11, ocB._aggregateAll(buildSubmissions(rev))));
        });

        // also canonicalizes the oracle's own live validator set, closing the
        // legacy (no-snapshot) half of _getLeader that used to leave it indexing
        // into whatever order the loader supplied.
        it('_getLeader legacy live-set path is order-insensitive', function () {
            const set = VALIDATORS_7;
            const ocA = mkOc(); ocA.setValidatorSet(set.slice());
            const ocB = mkOc(); ocB.setValidatorSet(set.slice().reverse());
            for (let round = 0; round < set.length * 2 + 1; round++) {
                expect(ocA._getLeader(round)).to.deep.equal(ocB._getLeader(round));
            }
        });
    });

    // -----------------------------------------------------------------
    // _getQuorum()
    // -----------------------------------------------------------------

    describe('_getQuorum()', function () {
        it('N=1 → 0 (single node, no consensus needed)', function () {
            oc.setValidatorSet([{ pubkey: 'a', addr: 'a' }]);
            expect(oc._getQuorum()).to.equal(0);
        });

        it('N=3 → 2 (majority floor)', function () {
            oc.setValidatorSet(VALIDATORS_3);
            expect(oc._getQuorum()).to.equal(2);
        });

        it('N=4 → 3', function () {
            oc.setValidatorSet(VALIDATORS_4);
            expect(oc._getQuorum()).to.equal(3);
        });

        it('N=7 → 5', function () {
            oc.setValidatorSet(VALIDATORS_7);
            expect(oc._getQuorum()).to.equal(5);
        });

        it('N=10 → 7', function () {
            oc.setValidatorSet(VALIDATORS_10);
            expect(oc._getQuorum()).to.equal(7);
        });

        it('N=13 → 9', function () {
            oc.setValidatorSet(VALIDATORS_13);
            expect(oc._getQuorum()).to.equal(9);
        });

        it('empty validator set falls back to peer count', function () {
            oc.setValidatorSet([]);
            pm.getPeerStatus.returns([{ state: 'open' }, { state: 'open' }]);
            // N = 2 peers + 1 self = 3 → quorum = 2 (majority floor)
            expect(oc._getQuorum()).to.equal(2);
        });
    });

    // -----------------------------------------------------------------
    // _getLeader()
    // -----------------------------------------------------------------

    describe('_getLeader()', function () {
        it('returns validator at round % N', function () {
            oc.setValidatorSet(VALIDATORS_3);
            expect(oc._getLeader(0)).to.equal(VALIDATORS_3[0]);
            expect(oc._getLeader(1)).to.equal(VALIDATORS_3[1]);
            expect(oc._getLeader(2)).to.equal(VALIDATORS_3[2]);
            expect(oc._getLeader(3)).to.equal(VALIDATORS_3[0]); // wraps
        });

        it('returns null for empty validator set', function () {
            oc.setValidatorSet([]);
            expect(oc._getLeader(0)).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // _isEmptyFederationSnapshot()
    // -----------------------------------------------------------------

    describe('_isEmptyFederationSnapshot()', function () {

        it('false for a null snapshot (indexer-unreachable degradation path)', function () {
            oc.setValidatorSet(VALIDATORS_3);
            expect(oc._isEmptyFederationSnapshot(null)).to.be.false;
        });

        it('true for an empty snapshot when federated (>= 2 registered validators)', function () {
            oc.setValidatorSet(VALIDATORS_3);   // _getQuorum() = 2
            expect(oc._isEmptyFederationSnapshot({ validators: [], count: 0 })).to.be.true;
        });

        it('false for an empty snapshot when single-node (no validators, no peers)', function () {
            oc.setValidatorSet([]);
            pm.getPeerStatus.returns([]);       // _getQuorum() = 0
            expect(oc._isEmptyFederationSnapshot({ validators: [], count: 0 })).to.be.false;
        });

        it('false for a non-empty snapshot even when federated', function () {
            oc.setValidatorSet(VALIDATORS_3);
            expect(oc._isEmptyFederationSnapshot({ validators: [{ pubkey: 'aa' }], count: 1 })).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // _digest()
    // -----------------------------------------------------------------

    describe('_digest()', function () {
        it('returns a hex SHA-256 hash', function () {
            let d = oc._digest(1, [{ coinPair: 'BTC/USD', price: '100000' }]);
            expect(d).to.match(/^[0-9a-f]{64}$/);
        });

        it('same inputs produce same digest', function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            expect(oc._digest(1, prices)).to.equal(oc._digest(1, prices));
        });

        it('different round produces different digest', function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            expect(oc._digest(1, prices)).to.not.equal(oc._digest(2, prices));
        });
    });

    // -----------------------------------------------------------------
    // _quorumMet(): count vs STAKE_WEIGHTED_QUORUM
    // -----------------------------------------------------------------

    describe('_quorumMet()', function () {

        it('count mode: vote-set size vs the round\'s locked quorum', function () {
            let pending = { weighted: false, quorum: 3, signatures: new Map() };
            expect(oc._quorumMet(pending, new Set(['a', 'b']))).to.equal(false);
            expect(oc._quorumMet(pending, new Set(['a', 'b', 'c']))).to.equal(true);
        });

        it('weighted mode: tallies SIGNER STAKE from the signatures map, ignoring the address vote set', function () {
            // One whale (>2/3 of stake) + nine 1-unit Sybils. S = 100009.
            let validators = [{ pubkey: 'a'.repeat(64), source: 'WHALE', weight: '100000' }];
            let sybils = [];
            for (let i = 0; i < 9; i++) {
                let pk = i.toString(16).padStart(2, '0').repeat(32);
                validators.push({ pubkey: pk, source: 'SYB' + i, weight: '1' });
                sybils.push(pk);
            }

            // All nine Sybils signed (a COUNT landslide) but hold minority stake.
            // Even a full address vote set cannot finalize.
            let sybilPending = { weighted: true, validators, quorum: 0,
                signatures: new Map(sybils.map(pk => [pk, 'sig'])) };
            expect(oc._quorumMet(sybilPending, new Set(sybils))).to.equal(false);

            // The whale alone clears it, despite an EMPTY address vote set, proving
            // the tally is over signer stake, not the prepares/commits sets.
            let whalePending = { weighted: true, validators, quorum: 0,
                signatures: new Map([['a'.repeat(64), 'sig']]) };
            expect(oc._quorumMet(whalePending, new Set())).to.equal(true);
        });
    });

    // finalizeRound()
    // -----------------------------------------------------------------

    describe('finalizeRound()', function () {

        it('skips already-finalized rounds', async function () {
            oc.finalized.add(5);
            await oc.finalizeRound(5);
            expect(hub.db.doQuery.callCount).to.equal(0);
        });

        it('stores skipped round when no submissions', async function () {
            oracleRound.getSubmissions.returns(new Map());
            await oc.finalizeRound(5);
            expect(hub.db.doQuery.called).to.be.true;
            let firstCall = hub.db.doQuery.getCall(0);
            expect(firstCall.args[0]).to.include('skipped');
        });

        it('single-node (quorum=0) stores directly and emits event', async function () {
            oc.setValidatorSet([]);
            pm.getPeerStatus.returns([]); // N = 0 + 1 = 1 → quorum 0

            let entries = [
                { sender: pm.validatorAddr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            let emitCount = 0;
            let emitted = null;
            oc.on('round:finalized', (data) => { emitCount++; emitted = data; });

            let storeSpy = sinon.spy(oc, '_storeSnapshot');

            await oc.finalizeRound(1);

            expect(hub.db.doQuery.called).to.be.true;
            expect(emitted).to.not.be.null;
            expect(emitted.round).to.equal(1);
            expect(emitted.prices[0].coinPair).to.equal('BTC/USD');

            // The round must now be marked finalized so a repeat call is a no-op
            // (guards against a duplicate snapshot store / PRICE v0 broadcast).
            await oc.finalizeRound(1);
            expect(storeSpy.callCount).to.equal(1);
            expect(emitCount).to.equal(1);
        });

        it('federation with an empty price snapshot skips instead of self-finalizing', async function () {
            // Federated: 3 registered validators -> _getQuorum() = 2 (> 0).
            oc.setValidatorSet(VALIDATORS_3);
            pm.validatorAddr = VALIDATORS_3[0].addr;   // even as leader, must skip
            // Indexer returned ZERO qualifying price validators at this block.
            let emptySnap = { validators: [], count: 0 };
            hub.capabilitySnapshot = {
                getSnapshot:       sinon.stub().resolves(emptySnap),
                getWeightSnapshot: sinon.stub().resolves(emptySnap),
                getQuorum:         sinon.stub().returns(0)
            };

            let entries = [
                { sender: pm.validatorAddr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            let emitCount = 0;
            oc.on('round:finalized', () => { emitCount++; });
            let storeSpy = sinon.spy(oc, '_storeSnapshot');

            await oc.finalizeRound(1, 900000, 1700000000);

            // Skipped, not finalized: no snapshot store, no round:finalized emit,
            // no PROPOSE broadcast, and a 'skipped' row persisted. The skip is
            // recorded as LOCALLY skipped (#7), never in `finalized` -- so a later
            // legitimate PROPOSE can still process and upgrade the round.
            expect(storeSpy.callCount).to.equal(0);
            expect(emitCount).to.equal(0);
            expect(pm.broadcast.called).to.be.false;
            expect(oc.locallySkipped.has(1)).to.be.true;
            expect(oc.finalized.has(1)).to.be.false;
            let skippedInsert = hub.db.doQuery.getCalls().some(c => /skipped/.test(String(c.args[0])));
            expect(skippedInsert).to.be.true;
        });

        it('single-node with an empty snapshot still self-finalizes (bootstrap preserved)', async function () {
            // Not federated: no registered validators and no peers -> _getQuorum() = 0.
            oc.setValidatorSet([]);
            pm.getPeerStatus.returns([]);
            let emptySnap = { validators: [], count: 0 };
            hub.capabilitySnapshot = {
                getSnapshot:       sinon.stub().resolves(emptySnap),
                getWeightSnapshot: sinon.stub().resolves(emptySnap),
                getQuorum:         sinon.stub().returns(0)
            };

            let entries = [
                { sender: pm.validatorAddr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            let emitCount = 0;
            let emitted = null;
            oc.on('round:finalized', (data) => { emitCount++; emitted = data; });
            let storeSpy = sinon.spy(oc, '_storeSnapshot');

            await oc.finalizeRound(1, 900000, 1700000000);

            expect(storeSpy.callCount).to.equal(1);
            expect(emitCount).to.equal(1);
            expect(emitted.round).to.equal(1);
        });

        it('non-leader does not propose', async function () {
            oc.setValidatorSet(VALIDATORS_3);
            // Round 0 leader is VALIDATORS_3[0], but our addr is different
            pm.validatorAddr = 'ws://not-a-leader:10001';

            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            await oc.finalizeRound(0);
            expect(pm.broadcast.called).to.be.false;
        });

        it('leader proposes and broadcasts ORACLE_PROPOSE', async function () {
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr; // Make us the leader for round 0

            let entries = [
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '100002' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            await oc.finalizeRound(0);

            // First broadcast should be ORACLE_PROPOSE
            expect(pm.broadcast.called).to.be.true;
            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PROPOSE');
            expect(data.round).to.equal(0);
            expect(data.prices).to.be.an('array');
            expect(data.digest).to.be.a('string');

            // Clean up timer
            let pending = oc.pendingRounds.get(0);
            if (pending && pending.timer) clearTimeout(pending.timer);
        });
    });

    // -----------------------------------------------------------------
    // _handlePropose() follower fail-closed guards (#1222, #1225)
    // -----------------------------------------------------------------

    describe('_handlePropose() follower fail-closed guards', function () {

        // Build a well-formed PROPOSE from the deterministic leader that passes the
        // known-sender, digest, leadership, deviation and coverage gates, so the test
        // reaches the pending-round creation block where the guards live.
        function goodEnvelope(round, extra) {
            oc.setValidatorSet(VALIDATORS_3);
            pm.validatorPubkeys = new Set();   // size 0 -> _isKnownSender returns true
            let leader = VALIDATORS_3[round % 3];
            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            // Local submission (from a NON-leader validator) pricing the pair at the
            // proposed value -> deviation 0 -> co-sign gate passes without a DB lookup.
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_3[(round + 1) % 3].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ]));
            return { type: 'ORACLE_PROPOSE', sender: leader.addr, data: Object.assign({
                round, prices, digest: oc._digest(round, prices)
            }, extra || {}) };
        }

        it('#1225: drops a PROPOSE carrying no BTC block height on a federated hub', async function () {
            // No btcBlockHeight in the envelope -> must NOT pin the price snapshot at
            // block_index = round (not a BTC boundary); federated hub drops the round.
            await oc._handlePropose(goodEnvelope(0, { /* btcBlockHeight omitted */ }));
            expect(oc.pendingRounds.has(0)).to.equal(false);
        });

        it('#1225: drops a PROPOSE carrying btcBlockHeight 0 on a federated hub', async function () {
            await oc._handlePropose(goodEnvelope(0, { btcBlockHeight: 0 }));
            expect(oc.pendingRounds.has(0)).to.equal(false);
        });

        it('#1222: drops a PROPOSE when weighted is active but the weight snapshot is empty (federated)', async function () {
            sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(true);
            hub.capabilitySnapshot = {
                getWeightSnapshot: sinon.stub().resolves({ validators: [] }),
                getSnapshot:       sinon.stub().resolves({ validators: [] }),
                getQuorum:         sinon.stub().returns(0)
            };
            // Real BTC height present, so the #1225 height guard passes; the #1222
            // weighted-snapshot guard must then fire and drop rather than degrade to
            // a count quorum this hub's peers are not using.
            await oc._handlePropose(goodEnvelope(0, { btcBlockHeight: 900000 }));
            expect(oc.pendingRounds.has(0)).to.equal(false);
        });
    });

    // -----------------------------------------------------------------
    // PBFT message flow
    // -----------------------------------------------------------------

    describe('PBFT message flow', function () {

        beforeEach(function () {
            // Use VALIDATORS_4 (quorum=3) to prevent auto-completion
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
        });

        afterEach(function () {
            for (let [, pending] of oc.pendingRounds) {
                if (pending.timer) clearTimeout(pending.timer);
            }
        });

        it('PREPARE from peer is recorded', function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(1, prices);

            oc.pendingRounds.set(1, {
                prices, digest, prepares: new Set(), commits: new Set(),
                finalized: false, timer: null
            });

            oc._handlePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { round: 1, digest }
            });

            expect(oc.pendingRounds.get(1).prepares.has(VALIDATORS_4[1].addr)).to.be.true;
        });

        it('PREPARE with wrong digest is rejected', function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(1, prices);

            oc.pendingRounds.set(1, {
                prices, digest, prepares: new Set(), commits: new Set(),
                finalized: false, timer: null
            });

            oc._handlePrepare({
                sender: VALIDATORS_4[1].addr,
                data: { round: 1, digest: 'wrong-digest' }
            });

            expect(oc.pendingRounds.get(1).prepares.size).to.equal(0);
        });

        it('reaching prepare quorum broadcasts COMMIT', function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(1, prices);

            // N=4, quorum=3. Start with 2 prepares.
            oc.pendingRounds.set(1, {
                prices, digest,
                prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                commits: new Set(),
                signatures: new Map(),
                finalized: false, timer: null
            });

            // Third prepare → quorum met
            oc._handlePrepare({
                sender: VALIDATORS_4[2].addr,
                data: { round: 1, digest }
            });

            expect(pm.broadcast.called).to.be.true;
            let [type] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_COMMIT');
        });

        it('reaching commit quorum stores snapshot and emits event', async function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(1, prices);

            oracleRound.getSubmissions.returns(new Map());

            // N=4, quorum=3. Start with 2 commits.
            oc.pendingRounds.set(1, {
                prices, digest,
                prepares: new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr, VALIDATORS_4[2].addr]),
                commits:  new Set([VALIDATORS_4[0].addr, VALIDATORS_4[1].addr]),
                signatures: new Map(),
                finalized: false, timer: null, _commitSent: true
            });

            let emitted = null;
            oc.on('round:finalized', (data) => { emitted = data; });

            // Third commit → quorum met
            oc._handleCommit({
                sender: VALIDATORS_4[2].addr,
                data: { round: 1, digest }
            });

            await waitUntil(() => oc.finalized.has(1), { label: 'the third commit to finalize round 1' });

            expect(hub.db.doQuery.called).to.be.true;
            expect(emitted).to.not.be.null;
            expect(emitted.round).to.equal(1);
            expect(oc.finalized.has(1)).to.be.true;
        });

        it('duplicate votes from same sender are counted once', function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(1, prices);

            oc.pendingRounds.set(1, {
                prices, digest, prepares: new Set(), commits: new Set(),
                finalized: false, timer: null
            });

            oc._handlePrepare({ sender: VALIDATORS_4[1].addr, data: { round: 1, digest } });
            oc._handlePrepare({ sender: VALIDATORS_4[1].addr, data: { round: 1, digest } });

            expect(oc.pendingRounds.get(1).prepares.size).to.equal(1);
        });
    });

    // -----------------------------------------------------------------
    // Fallback proposer election
    //
    // The deterministic leader sometimes has no submission for a round
    // (e.g. its price fetch failed). In that case the lowest-addr submitter
    // takes over as fallback proposer. A receiver decides whether an incoming
    // PROPOSE is a legitimate fallback by electing the lowest-addr submitter
    // from ITS OWN locally-observed submission map, never from the
    // submissionKeys list piggybacked on the PROPOSE, which is
    // attacker-controlled. A Byzantine proposer could otherwise claim a subset
    // whose lowest entry is its own address and elect itself fallback even when
    // the real leader submitted, injecting arbitrary prices into the round.
    //
    // The proposer still attaches its sorted submissionKeys as a diagnostic
    // hint, but receivers ignore it for the legitimacy check. The accepted cost
    // is a liveness edge case: if async gossip leaves a receiver's local view
    // lagging, it may reject a legitimate fallback and stall the round until the
    // finalization timeout re-elects.
    // -----------------------------------------------------------------

    describe('fallback proposer election', function () {

        afterEach(function () {
            for (let [, pending] of oc.pendingRounds) {
                if (pending.timer) clearTimeout(pending.timer);
            }
        });

        it('_proposeRound attaches the sorted submission keys to PROPOSE', function () {
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[3].addr;

            // Submitters arrive out of order in the map; submissionKeys must be sorted.
            let entries = [
                { sender: VALIDATORS_4[3].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
                { sender: VALIDATORS_4[1].addr, prices: [{ coinPair: 'BTC/USD', price: '100002' }] }
            ];
            let subs = buildSubmissions(entries);

            oc._proposeRound(7, subs, true, 100, 1700000000, null, 3);

            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PROPOSE');
            expect(data.submissionKeys).to.deep.equal(
                [VALIDATORS_4[1].addr, VALIDATORS_4[3].addr].sort()
            );
        });

        it('finalizeRound (leader path) includes submissionKeys in PROPOSE', async function () {
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr; // leader for round 0

            let entries = [
                { sender: VALIDATORS_4[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
                { sender: VALIDATORS_4[1].addr, prices: [{ coinPair: 'BTC/USD', price: '100002' }] }
            ];
            oracleRound.getSubmissions.returns(buildSubmissions(entries));

            await oc.finalizeRound(0);

            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PROPOSE');
            expect(data.submissionKeys).to.deep.equal(
                [VALIDATORS_4[0].addr, VALIDATORS_4[1].addr].sort()
            );
        });

        it('accepts a fallback PROPOSE when the sender is the lowest submitter in the local map', async function () {
            // We are validator-2 ("Hub A"), a receiver. Round 4 leader is v1
            // (4 % 4 = 0), which did not submit → the fallback path applies.
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr;

            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(4, prices);

            // Local view {v3, v4}: lowest is v3, so a PROPOSE from v3 is a
            // legitimate fallback by our own observation.
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[2].addr, prices },
                { sender: VALIDATORS_4[3].addr, prices }
            ]));

            await oc._handlePropose({
                sender: VALIDATORS_4[2].addr,
                data: {
                    round:          4,
                    prices,
                    digest,
                    btcBlockHeight: 900000,   // honest PROPOSE always carries the round's BTC height (#1225)
                    submissionKeys: [VALIDATORS_4[2].addr, VALIDATORS_4[3].addr]
                }
            });

            expect(oc.pendingRounds.has(4)).to.be.true;
            expect(pm.broadcast.called).to.be.true;
            let [type] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PREPARE');
        });

        it('SECURITY: rejects a crafted PROPOSE whose submissionKeys claim the sender is the lone (lowest) submitter', async function () {
            // Attack path: a Byzantine validator (v4) sends a PROPOSE claiming
            // submissionKeys=[v4], a single-element set whose lowest entry is
            // itself, to fraudulently elect itself fallback. Our local map
            // actually holds {v2, v4}, whose lowest is v2, so v4 is NOT a
            // legitimate fallback. Trusting the claimed list (the prior bug)
            // would accept the attacker's arbitrary prices; election from the
            // local map rejects it.
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr; // we are v2

            // Round 4 leader is v1 (absent), so the fallback branch is reachable.
            let prices = [{ coinPair: 'BTC/USD', price: '666666.00000000' }]; // attacker's fabricated price
            let digest = oc._digest(4, prices);

            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[1].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] },
                { sender: VALIDATORS_4[3].addr, prices: [{ coinPair: 'BTC/USD', price: '100002' }] }
            ]));

            await oc._handlePropose({
                sender: VALIDATORS_4[3].addr,
                data: {
                    round:          4,
                    prices,
                    digest,
                    submissionKeys: [VALIDATORS_4[3].addr]   // self-serving claim: must be ignored
                }
            });

            expect(oc.pendingRounds.has(4)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });

        it('rejects a PROPOSE when the sender is not the lowest submitter in the local map', async function () {
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr;

            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(4, prices);

            // Local view {v3, v4}: lowest is v3, so v4 is not a legitimate fallback.
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[2].addr, prices },
                { sender: VALIDATORS_4[3].addr, prices }
            ]));

            await oc._handlePropose({
                sender: VALIDATORS_4[3].addr,
                data: {
                    round:          4,
                    prices,
                    digest,
                    submissionKeys: [VALIDATORS_4[2].addr, VALIDATORS_4[3].addr]
                }
            });

            expect(oc.pendingRounds.has(4)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });

        it('elects from the local map regardless of whether submissionKeys is present', async function () {
            // submissionKeys is omitted entirely; the local map {v2, v4} still
            // governs. Lowest is v2, so v4's PROPOSE is rejected.
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr;

            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(4, prices);

            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[1].addr, prices },
                { sender: VALIDATORS_4[3].addr, prices }
            ]));

            await oc._handlePropose({
                sender: VALIDATORS_4[3].addr,
                data: { round: 4, prices, digest }
            });

            expect(oc.pendingRounds.has(4)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // Leader-timeout fallback (post-submission leader crash)
    //
    // A leader can gossip (and have peers record) its submission and then crash
    // before broadcasting ORACLE_PROPOSE. The plain no-submission fallback never
    // fires because every hub sees leaderSubmitted === true, so the round would
    // otherwise stall until the full finalization timeout. After a shorter
    // leader-timeout grace with no PROPOSE, the lowest-addr submitter OTHER THAN
    // the dead leader takes over; receivers accept that fallback only once their
    // own grace (measured from the block-driven round-ready time) has elapsed, so
    // an early/malicious fallback cannot usurp a still-alive leader.
    // -----------------------------------------------------------------

    describe('leader-timeout fallback', function () {

        let clock;

        afterEach(function () {
            if (clock) { clock.restore(); clock = null; }
            for (let [, t] of oc.leaderTimers) clearTimeout(t);
            for (let [, pending] of oc.pendingRounds) {
                if (pending.timer) clearTimeout(pending.timer);
            }
        });

        it('elected fallback proposes after the grace when the leader submitted but never proposed', async function () {
            clock = sinon.useFakeTimers();
            oc.setValidatorSet(VALIDATORS_4);
            // Round 0 leader is VALIDATORS_4[0] (validator-1). We are validator-2,
            // the lowest-addr submitter excluding the leader → the elected fallback.
            pm.validatorAddr = VALIDATORS_4[1].addr;

            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            // Leader submitted (and gossiped), then crashed before proposing.
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices },   // leader
                { sender: VALIDATORS_4[1].addr, prices },   // us (fallback)
                { sender: VALIDATORS_4[2].addr, prices }
            ]));

            await oc.finalizeRound(0);

            // A leader-timeout timer must be armed, and nothing proposed yet.
            expect(oc.leaderTimers.has(0)).to.be.true;
            expect(pm.broadcast.called).to.be.false;

            // Before the grace elapses, still no PROPOSE.
            clock.tick(oc.leaderTimeout - 1);
            expect(pm.broadcast.called).to.be.false;

            // Past the grace (+ skew buffer) the fallback takes over and proposes.
            clock.tick(oc.leaderTimeout + 5000);
            expect(pm.broadcast.called).to.be.true;
            let [type, data] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PROPOSE');
            expect(data.round).to.equal(0);
        });

        it('non-elected follower does not arm a leader-timeout timer', async function () {
            clock = sinon.useFakeTimers();
            oc.setValidatorSet(VALIDATORS_4);
            // We are validator-3; the elected fallback is validator-2, so we wait.
            pm.validatorAddr = VALIDATORS_4[2].addr;

            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices },
                { sender: VALIDATORS_4[1].addr, prices },
                { sender: VALIDATORS_4[2].addr, prices }
            ]));

            await oc.finalizeRound(0);

            expect(oc.leaderTimers.has(0)).to.be.false;
            clock.tick(oc.leaderTimeout + 5000);
            expect(pm.broadcast.called).to.be.false;
        });

        it('aborts the takeover if a PROPOSE arrives during the grace', async function () {
            clock = sinon.useFakeTimers();
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[1].addr; // elected fallback

            // Round 4 leader is VALIDATORS_4[0] (4 % 4 === 0). Round 4 (not 0)
            // because _handlePropose rejects the falsy round 0.
            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices },
                { sender: VALIDATORS_4[1].addr, prices },
                { sender: VALIDATORS_4[2].addr, prices }
            ]));

            await oc.finalizeRound(4);
            expect(oc.leaderTimers.has(4)).to.be.true;

            // The (real) leader's PROPOSE lands mid-grace → pendingRounds populated.
            let digest = oc._digest(4, prices);
            await oc._handlePropose({
                sender: VALIDATORS_4[0].addr,
                data: { round: 4, prices, digest, btcBlockHeight: 900000 }
            });
            expect(oc.pendingRounds.has(4)).to.be.true;
            let proposeCalls = pm.broadcast.getCalls().filter(c => c.args[0] === 'ORACLE_PROPOSE').length;

            // Firing the grace must NOT add a second (fallback) PROPOSE.
            clock.tick(oc.leaderTimeout + 5000);
            let afterCalls = pm.broadcast.getCalls().filter(c => c.args[0] === 'ORACLE_PROPOSE').length;
            expect(afterCalls).to.equal(proposeCalls);
        });

        it('receiver rejects a leader-timeout fallback PROPOSE before the grace, accepts it after', async function () {
            clock = sinon.useFakeTimers({ now: 1700000000000 });
            oc.setValidatorSet(VALIDATORS_4);
            // We are validator-3, a plain receiver. Round 4 leader is validator-1
            // (submitted); the legitimate post-crash fallback is validator-2.
            pm.validatorAddr = VALIDATORS_4[2].addr;

            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(4, prices);
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices },   // leader submitted
                { sender: VALIDATORS_4[1].addr, prices }    // fallback
            ]));

            // Learn the round is ready (sets roundReadyAt for the grace clock).
            await oc.finalizeRound(4);
            expect(pm.broadcast.called).to.be.false;

            // Fallback PROPOSE from validator-2 BEFORE the grace → rejected.
            await oc._handlePropose({
                sender: VALIDATORS_4[1].addr,
                data: { round: 4, prices, digest }
            });
            expect(oc.pendingRounds.has(4)).to.be.false;
            expect(pm.broadcast.called).to.be.false;

            // After the grace, the same fallback PROPOSE is accepted.
            clock.tick(oc.leaderTimeout);
            await oc._handlePropose({
                sender: VALIDATORS_4[1].addr,
                data: { round: 4, prices, digest, btcBlockHeight: 900000 }
            });
            expect(oc.pendingRounds.has(4)).to.be.true;
            let [type] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PREPARE');
        });

        it('SECURITY: after the grace, only the lowest non-leader submitter is accepted as fallback', async function () {
            clock = sinon.useFakeTimers({ now: 1700000000000 });
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[2].addr; // receiver (validator-3)

            let prices = [{ coinPair: 'BTC/USD', price: '666666.00000000' }];
            let digest = oc._digest(4, prices);
            // Round 4 leader (v1) submitted; submitters {v1, v2, v4}. Lowest
            // non-leader is v2, so a PROPOSE from v4 must be rejected even after
            // the grace.
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices },
                { sender: VALIDATORS_4[1].addr, prices },
                { sender: VALIDATORS_4[3].addr, prices }
            ]));

            await oc.finalizeRound(4);
            clock.tick(oc.leaderTimeout);

            await oc._handlePropose({
                sender: VALIDATORS_4[3].addr,   // v4: not the lowest non-leader
                data: { round: 4, prices, digest }
            });
            expect(oc.pendingRounds.has(4)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // start() / stop()
    // -----------------------------------------------------------------

    describe('start() / stop()', function () {
        it('start subscribes; stop unsubscribes and clears all per-round state', async function () {
            await oc.start();
            expect(oc._messageHandler).to.be.a('function');
            expect(pm.listenerCount('message')).to.equal(1);

            oc.pendingRounds.set(1, { timer: setTimeout(() => {}, 60000) });
            oc.leaderTimers.set(1, setTimeout(() => {}, 60000));
            oc.roundReadyAt.set(1, Date.now());

            await oc.stop();
            expect(oc._messageHandler).to.equal(null);
            expect(pm.listenerCount('message')).to.equal(0);
            expect(oc.pendingRounds.size).to.equal(0);
            expect(oc.leaderTimers.size).to.equal(0);
            expect(oc.roundReadyAt.size).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // finalizeRound(): below-minimum + dispatch + empty aggregation
    // -----------------------------------------------------------------

    describe('finalizeRound() / dispatch: additional paths', function () {
        it('skips a round below the minimum submission threshold', async function () {
            oc.minSubmissions = 3;
            oracleRound.getSubmissions.returns(buildSubmissions([
                { sender: VALIDATORS_3[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ]));
            let store = sinon.stub(oc, '_storeSkippedRound').resolves();
            await oc.finalizeRound(5, 800000, 1700000000);
            expect(store.calledOnce).to.be.true;
            expect(store.getCall(0).args[3]).to.include('below minimum');
        });

        it('_handleMessage routes PROPOSE / PREPARE / COMMIT and ignores unknown', function () {
            let prop = sinon.stub(oc, '_handlePropose').resolves();
            let prep = sinon.spy(oc, '_handlePrepare');
            let com  = sinon.spy(oc, '_handleCommit');
            oc._handleMessage({ type: 'ORACLE_PROPOSE', data: { round: 1 } });
            oc._handleMessage({ type: 'ORACLE_PREPARE', data: { round: 1, digest: 'd' } });
            oc._handleMessage({ type: 'ORACLE_COMMIT',  data: { round: 1, digest: 'd' } });
            expect(() => oc._handleMessage({ type: 'X', data: {} })).to.not.throw();
            expect(prop.calledOnce).to.be.true;
            expect(prep.calledOnce).to.be.true;
            expect(com.calledOnce).to.be.true;
        });

        it('_proposeRound stores a skipped round when aggregation yields no prices', function () {
            let store = sinon.stub(oc, '_storeSkippedRound').resolves();
            oc._proposeRound(5, new Map(), false, 800000, 1700000000, null, 1);
            expect(store.calledOnce).to.be.true;
            expect(store.getCall(0).args[3]).to.include('aggregation');
        });

        it('_proposeRound arms a finalization timeout that drops a stalled round', function () {
            let clock = sinon.useFakeTimers();
            oc.finalizationTimeout = 1000;
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            let subs = buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ]);
            oc._proposeRound(7, subs, false, 800000, 1700000000, null, 3); // quorum 3 → stays pending
            expect(oc.pendingRounds.has(7)).to.be.true;
            clock.tick(1001);
            expect(oc.pendingRounds.has(7)).to.be.false;
            clock.restore();
        });

        it('leader-path finalization timeout counts in _roundTimeouts and skips no round (reviews 1468/1469)', function () {
            let clock = sinon.useFakeTimers();
            let store = sinon.stub(oc, '_storeSkippedRound').resolves();
            oc.finalizationTimeout = 1000;
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            let subs = buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ]);
            expect(oc._roundTimeouts).to.equal(0); // constructor-initialized
            oc._proposeRound(8, subs, false, 800000, 1700000000, null, 3);
            clock.tick(1001);
            expect(oc._roundTimeouts).to.equal(1);
            // Symmetric COUNTING only: a leader timeout must not mark the round
            // finalized/skipped, or a late-arriving quorum would be refused.
            expect(store.called).to.be.false;
            expect(oc.finalized.has(8)).to.be.false;
            clock.restore();
        });

        it('leader-path finalization timeout does not count a round that finalized in time', function () {
            let clock = sinon.useFakeTimers();
            oc.finalizationTimeout = 1000;
            oc.setValidatorSet(VALIDATORS_4);
            pm.validatorAddr = VALIDATORS_4[0].addr;
            let subs = buildSubmissions([
                { sender: VALIDATORS_4[0].addr, prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ]);
            oc._proposeRound(9, subs, false, 800000, 1700000000, null, 3);
            oc.pendingRounds.get(9).finalized = true;
            clock.tick(1001);
            expect(oc._roundTimeouts).to.equal(0);
            clock.restore();
        });
    });

    // -----------------------------------------------------------------
    // PRICE v0 signing + verification
    // -----------------------------------------------------------------

    describe('PRICE v0 signature helpers', function () {
        const ValidatorIdentity = require('../../src/ValidatorIdentity');

        it('_buildPriceV0Payload sorts pairs canonically', function () {
            let payload = oc._buildPriceV0Payload(5, 1700000000, [
                { coinPair: 'LTC/USD', price: '80' },
                { coinPair: 'BTC/USD', price: '100000' }
            ]);
            let obj = JSON.parse(payload);
            expect(obj.round).to.equal(5);
            expect(obj.pairs.map(p => p.pair)).to.deep.equal(['BTC/USD', 'LTC/USD']);
        });

        it('_buildPriceV0Payload keeps both entries when pair names are equal', function () {
            let payload = oc._buildPriceV0Payload(1, 1, [
                { coinPair: 'BTC/USD', price: '1' },
                { coinPair: 'BTC/USD', price: '2' }
            ]);
            expect(JSON.parse(payload).pairs).to.have.length(2);
        });

        it('_signPriceV0 returns null when no identity is configured', function () {
            hub.getIdentity.returns(null);
            expect(oc._signPriceV0(5, 1700000000, [{ coinPair: 'BTC/USD', price: '1' }])).to.be.null;
        });

        it('_signPriceV0 returns null (not throw) when signing fails', function () {
            hub.getIdentity.returns({ sign: () => { throw new Error('hsm offline'); }, getPubkeyHex: () => 'aa'.repeat(32) });
            expect(oc._signPriceV0(5, 1700000000, [{ coinPair: 'BTC/USD', price: '1' }])).to.be.null;
        });

        it('_verifyAndStoreSig rejects missing args / duplicate / round-less pending', function () {
            expect(oc._verifyAndStoreSig(null, 'pk', 'sig')).to.be.false;
            expect(oc._verifyAndStoreSig({ round: 1, signatures: new Map() }, null, 'sig')).to.be.false;
            expect(oc._verifyAndStoreSig({ round: 1, signatures: new Map() }, 'pk', null)).to.be.false;
            expect(oc._verifyAndStoreSig({ round: 1, signatures: new Map([['pk', 'x']]) }, 'pk', 'sig')).to.be.false;
            expect(oc._verifyAndStoreSig({ signatures: new Map() }, 'pk', 'sig')).to.be.false; // no round
        });

        it('_verifyAndStoreSig stores a valid signature and rejects an invalid one', function () {
            let id = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            // #4232: the height is part of the signed payload and the verify reconstruction
            // reads it from pending.btcBlockHeight, so both must carry the same value.
            let payload = oc._buildPriceV0Payload(5, 1700000000, prices, 799000);
            let sig = id.sign(payload);

            let pending = { round: 5, btcBlockTime: 1700000000, btcBlockHeight: 799000, prices, signatures: new Map() };
            expect(oc._verifyAndStoreSig(pending, id.getPubkeyHex(), sig)).to.be.true;
            expect(pending.signatures.has(id.getPubkeyHex())).to.be.true;

            let pending2 = { round: 5, btcBlockTime: 1700000000, btcBlockHeight: 799000, prices, signatures: new Map() };
            expect(oc._verifyAndStoreSig(pending2, id.getPubkeyHex(), 'ff'.repeat(64))).to.be.false;
        });

        it('_verifyAndStoreSig keys the map on lowercase hex, so a mixed-case repeat dedupes (item 5334)', function () {
            let id = new ValidatorIdentity(ValidatorIdentity.generate().privkeyHex);
            let prices = [{ coinPair: 'BTC/USD', price: '100000' }];
            let payload = oc._buildPriceV0Payload(5, 1700000000, prices, 799000);
            let sig = id.sign(payload);
            let pending = { round: 5, btcBlockTime: 1700000000, btcBlockHeight: 799000, prices, signatures: new Map() };

            // Uppercase hex verifies (hex decode is case-insensitive) and lands lowercase.
            expect(oc._verifyAndStoreSig(pending, id.getPubkeyHex().toUpperCase(), sig)).to.be.true;
            expect([...pending.signatures.keys()]).to.deep.equal([id.getPubkeyHex()]);

            // The same key in the other casing is a duplicate, not a second sigsArray entry.
            expect(oc._verifyAndStoreSig(pending, id.getPubkeyHex(), sig)).to.be.false;
            expect(pending.signatures.size).to.equal(1);
        });
    });

    // -----------------------------------------------------------------
    // Round-tracking utilities
    // -----------------------------------------------------------------

    describe('round-tracking utilities', function () {
        it('_markRoundReady records a new round and evicts stale entries', function () {
            oc.finalizationTimeout = 1000;
            oc.leaderTimeout = 1000; // ttl = 1000*2 + 1000 = 3000
            oc.roundReadyAt.set(99, Date.now() - 10000); // stale
            oc._markRoundReady(5);
            expect(oc.roundReadyAt.has(99)).to.be.false;
            expect(oc.roundReadyAt.has(5)).to.be.true;
        });

        it('_clearRoundTracking drops the round-ready entry and clears any leader timer', function () {
            oc.roundReadyAt.set(5, Date.now());
            oc.leaderTimers.set(5, setTimeout(() => {}, 60000));
            oc._clearRoundTracking(5);
            expect(oc.roundReadyAt.has(5)).to.be.false;
            expect(oc.leaderTimers.has(5)).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // _markFinalized() bounded FIFO (L1)
    // -----------------------------------------------------------------
    describe('_markFinalized (bounded finalized set)', function () {

        it('caps the finalized set at finalizedMax, evicting oldest rounds first', function () {
            oc.finalizedMax = 4;
            for (let r = 1; r <= 20; r++) oc._markFinalized(r);
            expect(oc.finalized.size).to.equal(4);
            expect(oc.finalized.has(1)).to.be.false;
            expect(oc.finalized.has(16)).to.be.false;
            expect(oc.finalized.has(17)).to.be.true;
            expect(oc.finalized.has(20)).to.be.true;
        });

        it('is idempotent for a repeated round', function () {
            oc.finalizedMax = 3;
            oc._markFinalized(9);
            oc._markFinalized(9);
            expect(oc.finalized.size).to.equal(1);
            expect(oc._finalizedOrder).to.deep.equal([9]);
        });
    });
});
