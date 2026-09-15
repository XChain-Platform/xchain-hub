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
const OracleConsensus  = require('../../../../src/oracle/consensus');
const swq              = require('../../../../src/stake_weighted_quorum.js');
const { createMockHub }       = require('../../../helpers/mockHub');
const { waitUntil }           = require('../../../helpers/waitUntil');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, VALIDATORS_10, VALIDATORS_13,
        buildSubmissions, buildUniformSubmissions, SAMPLE_PRICES } = require('../../../helpers/fixtures');

const { bftQuorumOrSingle } = require('../../../../src/lib/bft_quorum.js');



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

function registerOracleconsensus1Hooks() {

    beforeEach(function () {
        hub = createMockHub();
        // A real federated hub always resolves a BTC tip of its own, and the follower
        // now bounds the leader-supplied btcBlockHeight against it before that height
        // can pick the snapshot, the leader or the quorum mode. Same height the honest
        // PROPOSEs in this file carry, so an in-lockstep round is modelled.
        hub._resolveBtcLatestBlock = sinon.stub().resolves(900000);
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

function registerAggregateTrimmedMedian2Tests1() {

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
}

function registerAggregateTrimmedMedian2Tests8() {

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
}

function registerAggregateTrimmedMedian2Tests17() {

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
}

function registerAggregateTrimmedMedian2Tests21() {

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

}

describe('OracleConsensus', function () {
    registerOracleconsensus1Hooks();



    // -----------------------------------------------------------------
    // _aggregate(): trimmed median
    // -----------------------------------------------------------------
    describe('_aggregate(): trimmed median', function () {
        registerAggregateTrimmedMedian2Tests1();
        registerAggregateTrimmedMedian2Tests8();
        registerAggregateTrimmedMedian2Tests17();
        registerAggregateTrimmedMedian2Tests21();
    });
});
