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
const OracleConsensus  = require('../../../../../src/oracle/consensus');
const swq              = require('../../../../../src/stake_weighted_quorum.js');
const { createMockHub }       = require('../../../../helpers/mockHub');
const { waitUntil }           = require('../../../../helpers/waitUntil');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, VALIDATORS_10, VALIDATORS_13,
        buildSubmissions, buildUniformSubmissions, SAMPLE_PRICES } = require('../../../../helpers/fixtures');

const { bftQuorumOrSingle } = require('../../../../../src/lib/bft_quorum.js');



    let hub, pm, oc, oracleRound;


    // The price capability snapshot a healthy indexer would return for this hub's own
    // validator set. Read at call time, not at wiring time, so a case that installs its
    // set inside the test body still gets a snapshot that matches it.
    function liveSnapshot(capability, blockIndex) {
        let vals = (oc && Array.isArray(oc.validatorSet)) ? oc.validatorSet : [];
        return {
            capability: capability,
            blockIndex: Number(blockIndex),
            count:      vals.length,
            validators: vals.map(v => ({ pubkey: v.pubkey, amount: '50000' }))
        };
    }



        function submissionsForPair(prices) {
            let entries = prices.map((p, i) => ({
                sender: 'validator-' + i,
                prices: [{ coinPair: 'BTC/USD', price: String(p) }]
            }));
            return buildSubmissions(entries);
        }



        function subsFor(pair, prices) {
            return buildSubmissions(prices.map((p, i) => ({
                sender: 'validator-' + i,
                prices: [{ coinPair: pair, price: String(p) }]
            })));
        }

function registerOracleconsensus1Hooks() {

    beforeEach(function () {
        hub = createMockHub();
        // A real federated hub always resolves a BTC tip of its own, and the follower
        // now bounds the leader-supplied btcBlockHeight against it before that height
        // can pick the snapshot, the leader or the quorum mode. Same height the honest
        // PROPOSEs in this file carry, so an in-lockstep round is modelled.
        hub.resolveBtcLatestBlock = sinon.stub().resolves(900000);
        pm  = hub._peerManager;
        oracleRound = {
            getSubmissions: sinon.stub().returns(new Map())
        };
        oc = new OracleConsensus(hub, oracleRound);
        // A federated hub refuses a round with no deterministic capability snapshot (it would
        // otherwise size quorum from its own live set), so the harness models one. It resolves
        // LATE, against whatever validator set the case under test installed, which is the
        // healthy federation: the snapshot IS the qualifying set, and it yields the quorum
        // the live-set fallback would yield. Cases about the snapshot itself override this
        // with their own stub.
        hub.capabilitySnapshot = {
            getSnapshot:       async (capability, blockIndex) => liveSnapshot(capability, blockIndex),
            getWeightSnapshot: async (capability, blockIndex) => liveSnapshot(capability, blockIndex),
            getQuorum:         (snapshot) => bftQuorumOrSingle(
                snapshot && Array.isArray(snapshot.validators) ? snapshot.validators.length : 0, 0)
        };
        // These cases exercise finalize/propose logic with small fixed submission sets and model a
        // configured single/small deployment, so use the regtest override (ORACLE_MIN_SUBMISSIONS=1).
        // The 2-hub default diversity floor is covered in OracleConsensus.propose-validation.test.js.
        oc.minSubmissions = 1;
    });

    afterEach(function () {
        sinon.restore();
    });
}

function registerAggregateBoundedChangeClampVs2Tests1() {

        it('no finalized history: aggregate passes through unclamped', function () {
            let subs = submissionsForPair([100000, 100000, 100000]);
            expect(oc.aggregate(subs, 'BTC/USD')).to.equal('100000.00000000');
        });

        it('within the +/-25% band: aggregate passes through unchanged', function () {
            oc.updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100000.00000000' }]);
            let subs = submissionsForPair([110000, 110000, 110000]);
            expect(oc.aggregate(subs, 'BTC/USD')).to.equal('110000.00000000');
        });

        it('exactly on the +25% boundary: not clamped', function () {
            oc.updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100000.00000000' }]);
            let subs = submissionsForPair([125000, 125000, 125000]);
            expect(oc.aggregate(subs, 'BTC/USD')).to.equal('125000.00000000');
        });

        it('upward fat-tail spike: clamped to last * 1.25', function () {
            oc.updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100000.00000000' }]);
            // Every source agrees on the spike (survives trim and median), so only
            // the clamp bounds it.
            let subs = submissionsForPair([500000, 500000, 500000]);
            expect(oc.aggregate(subs, 'BTC/USD')).to.equal('125000.00000000');
        });

        it('downward fat-tail crash: clamped to last * 0.75', function () {
            oc.updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100000.00000000' }]);
            let subs = submissionsForPair([10000, 10000, 10000]);
            expect(oc.aggregate(subs, 'BTC/USD')).to.equal('75000.00000000');
        });

        it('sustained genuine move walks to the new level over successive rounds', function () {
            oc.updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100000.00000000' }]);
            let subs = submissionsForPair([200000, 200000, 200000]);
            let r1 = oc.aggregate(subs, 'BTC/USD');
            expect(r1).to.equal('125000.00000000');
            // Round 1 finalizes at the clamped value; round 2 clamps from there.
            oc.updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: r1 }]);
            let r2 = oc.aggregate(subs, 'BTC/USD');
            expect(r2).to.equal('156250.00000000');
            oc.updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: r2 }]);
            let r3 = oc.aggregate(subs, 'BTC/USD');
            expect(r3).to.equal('195312.50000000');
            oc.updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: r3 }]);
            // Fourth round reaches the true level (200000 < 195312.5 * 1.25).
            expect(oc.aggregate(subs, 'BTC/USD')).to.equal('200000.00000000');
        });

        it('clamp is per-pair: an unrelated pair with history does not clamp BTC/USD', function () {
            oc.updateLastFinalizedPrices([{ coinPair: 'LTC/USD', price: '100.00000000' }]);
            let subs = submissionsForPair([500000, 500000, 500000]);
            expect(oc.aggregate(subs, 'BTC/USD')).to.equal('500000.00000000');
        });
}

function registerAggregateBoundedChangeClampVs2Tests8() {

        it('a clamped aggregate stays within the propose-gate historical band (5x deviation)', function () {
            // Coherence check: ORACLE_MAX_CHANGE_PER_ROUND (0.25) must never exceed
            // 5 * ORACLE_DEVIATION_THRESHOLD, or a leader's clamped proposal would be
            // rejected by followers with no live submission for the pair.
            const { ORACLE_MAX_CHANGE_PER_ROUND, ORACLE_DEVIATION_THRESHOLD } = require('../../../../../src/constants.js');
            expect(ORACLE_MAX_CHANGE_PER_ROUND).to.be.at.most(5 * ORACLE_DEVIATION_THRESHOLD);
        });

}

function registerAggregateTighterPerPairClamp3Tests9() {

        it('bounds XCHAIN/USD at 10%/round, not the global 25%', function () {
            // XCHAIN trades in a market thin by construction pre-launch, so the generic
            // clamp is the wrong size for it: 25%/round compounds to roughly 10x in 80
            // minutes at the default cadence.
            oc.updateLastFinalizedPrices([{ coinPair: 'XCHAIN/USD', price: '2.00000000' }]);
            expect(oc.aggregate(subsFor('XCHAIN/USD', [10, 10, 10]), 'XCHAIN/USD')).to.equal('2.20000000');
        });

        it('bounds the DOWN direction identically: fee-cheapening is the other attack', function () {
            // §5 is explicit that the incentive is bidirectional - a lower XCHAIN/USD
            // makes native-coin fees cheaper for whoever pushed it there.
            oc.updateLastFinalizedPrices([{ coinPair: 'XCHAIN/USD', price: '2.00000000' }]);
            expect(oc.aggregate(subsFor('XCHAIN/USD', [0.01, 0.01, 0.01]), 'XCHAIN/USD')).to.equal('1.80000000');
        });

        it('leaves every other pair on the global bound', function () {
            // The override must not leak: BTC/USD tracks a deep external market and a
            // 10% cap would suppress genuine moves it should follow.
            oc.updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100000.00000000' }]);
            expect(oc.aggregate(subsFor('BTC/USD', [500000, 500000, 500000]), 'BTC/USD')).to.equal('125000.00000000');
        });

        it('walks the bootstrap to a market level over rounds, never in one print', function () {
            // §7: an attacker who wash-trades exactly the volume threshold still cannot
            // set the first market print - it walks from the bootstrap at the clamp rate
            // like any other move, which is what buys the operator time to notice.
            oc.updateLastFinalizedPrices([{ coinPair: 'XCHAIN/USD', price: '2.00000000' }]);
            let subs = subsFor('XCHAIN/USD', [100, 100, 100]);
            let r1 = oc.aggregate(subs, 'XCHAIN/USD');
            expect(r1).to.equal('2.20000000');
            oc.updateLastFinalizedPrices([{ coinPair: 'XCHAIN/USD', price: r1 }]);
            expect(oc.aggregate(subs, 'XCHAIN/USD')).to.equal('2.42000000');
        });

        it('stays strictly inside the propose-gate band, which keeps the global bound', function () {
            // The load-bearing invariant behind the deliberate asymmetry in
            // handlePropose: the follower gate is a strict SUPERSET of every per-pair
            // clamp, so a maximally-clamped aggregate always passes it. If a future
            // override were ever set LOOSER than the global bound, a clamped proposal
            // could be rejected by every honest follower and wedge the round.
            const { ORACLE_MAX_CHANGE_PER_ROUND, XCHAIN_PRICE_MAX_CHANGE_PER_ROUND } = require('../../../../../src/constants.js');
            expect(XCHAIN_PRICE_MAX_CHANGE_PER_ROUND).to.be.at.most(ORACLE_MAX_CHANGE_PER_ROUND);
        });

}

function registerMinroundsources4Tests14() {
        it('returns the minimum per-pair source count across all submissions', function () {
            let subs = buildSubmissions([
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100000', sources: 2 }, { coinPair: 'LTC/USD', price: '80', sources: 2 }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '100010', sources: 2 }, { coinPair: 'LTC/USD', price: '82', sources: 2 }] }
            ]);
            expect(oc.computeMinRoundSources(subs)).to.equal(2);
        });

        it('drops to 1 when any submission reached a single upstream for a pair', function () {
            let subs = buildSubmissions([
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100000', sources: 2 }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '100010', sources: 1 }] }
            ]);
            expect(oc.computeMinRoundSources(subs)).to.equal(1);
        });

        it('returns Infinity when no per-pair source count is present (cannot assess)', function () {
            let subs = buildSubmissions([
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100000' }] }
            ]);
            expect(oc.computeMinRoundSources(subs)).to.equal(Infinity);
        });

        it('tolerates an empty / missing submission set', function () {
            expect(oc.computeMinRoundSources(new Map())).to.equal(Infinity);
            expect(oc.computeMinRoundSources(null)).to.equal(Infinity);
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
            expect(oc.computeMinRoundSources(subs, capable)).to.equal(2);
            // Without the filter the by-design single-source pair pins the minimum to 1.
            expect(oc.computeMinRoundSources(subs)).to.equal(1);
        });

        it('still flags a genuine degradation on a multi-source-capable pair', function () {
            // BTC/USD is capable of 2 but only reached 1 this round -> real degradation.
            let subs = buildSubmissions([
                { sender: 'v1', prices: [{ coinPair: 'BTC/USD', price: '100000', sources: 1 }] },
                { sender: 'v2', prices: [{ coinPair: 'BTC/USD', price: '100010', sources: 1 }] }
            ]);
            expect(oc.computeMinRoundSources(subs, new Set(['BTC/USD']))).to.equal(1);
        });

}

function registerAggregateall5Tests20() {
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
            let result = oc.aggregateAll(subs);
            expect(result).to.have.lengthOf(2);
            let btc = result.find(r => r.coinPair === 'BTC/USD');
            let ltc = result.find(r => r.coinPair === 'LTC/USD');
            expect(btc.price).to.equal('100001.00000000');
            expect(ltc.price).to.equal('81.00000000');
        });

        it('returns empty array for empty submissions', function () {
            expect(oc.aggregateAll(new Map())).to.deep.equal([]);
        });

}

describe('OracleConsensus', function () {
    registerOracleconsensus1Hooks();



    // -----------------------------------------------------------------
    // clampToLastFinalized(): per-pair bounded-change clamp
    // -----------------------------------------------------------------
    describe('aggregate(): bounded-change clamp vs last finalized', function () {
        registerAggregateBoundedChangeClampVs2Tests1();
        registerAggregateBoundedChangeClampVs2Tests8();
    });



    // -----------------------------------------------------------------
    // Per-pair clamp override for the derived pair
    // -----------------------------------------------------------------
    describe('aggregate(): tighter per-pair clamp for XCHAIN/USD', function () {
        registerAggregateTighterPerPairClamp3Tests9();
    });



    // -----------------------------------------------------------------
    // computeMinRoundSources(): source-diversity health signal
    // -----------------------------------------------------------------
    describe('computeMinRoundSources()', function () {
        registerMinroundsources4Tests14();
    });



    // -----------------------------------------------------------------
    // aggregateAll()
    // -----------------------------------------------------------------
    describe('aggregateAll()', function () {
        registerAggregateall5Tests20();
    });
});
