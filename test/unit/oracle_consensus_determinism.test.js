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
const OracleConsensus  = require('../../src/oracle/consensus');
const swq              = require('../../src/stake_weighted_quorum.js');
const { createMockHub }       = require('../helpers/mockHub');
const { waitUntil }           = require('../helpers/waitUntil');
const { VALIDATORS_3, VALIDATORS_4, VALIDATORS_7, VALIDATORS_10, VALIDATORS_13,
        buildSubmissions, buildUniformSubmissions, SAMPLE_PRICES } = require('../helpers/fixtures');

const { bftQuorumOrSingle } = require('../../src/lib/bft_quorum.js');



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


        // -------------------------------------------------------------
        // the FLAG this block once carried is now FIXED.
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

function registerL4DeterminismTrimmedMedianAggregation2Tests1() {

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
}

function registerL4DeterminismTrimmedMedianAggregation2Tests8() {

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
        // legacy (no-snapshot) half of _getLeader that once left it indexing
        // into whatever order the loader supplied.
        it('_getLeader legacy live-set path is order-insensitive', function () {
            const set = VALIDATORS_7;
            const ocA = mkOc(); ocA.setValidatorSet(set.slice());
            const ocB = mkOc(); ocB.setValidatorSet(set.slice().reverse());
            for (let round = 0; round < set.length * 2 + 1; round++) {
                expect(ocA._getLeader(round)).to.deep.equal(ocB._getLeader(round));
            }
        });

}

describe('OracleConsensus', function () {
    registerOracleconsensus1Hooks();



    // -----------------------------------------------------------------
    // L4 determinism: trimmed-median aggregation (spec §6 / validator-test-spec)
    //
    // spec §6 "Determinism (L4)" item 3: same oracle round inputs → the same
    // trimmed-median on every finalizing hub. The median VALUE must not depend on
    // submission/iteration order, and two independently-constructed hubs must
    // agree on the per-pair result for the same submission multiset.
    // -----------------------------------------------------------------
    describe('L4 determinism: trimmed-median aggregation', function () {
        registerL4DeterminismTrimmedMedianAggregation2Tests1();
        registerL4DeterminismTrimmedMedianAggregation2Tests8();
    });
});
