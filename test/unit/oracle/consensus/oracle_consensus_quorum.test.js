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

function registerGetquorum2Tests1() {
        it('N=1 → 0 (single node, no consensus needed)', function () {
            oc.setValidatorSet([{ pubkey: 'a', addr: 'a' }]);
            expect(oc.getQuorum()).to.equal(0);
        });

        it('N=3 → 2 (majority floor)', function () {
            oc.setValidatorSet(VALIDATORS_3);
            expect(oc.getQuorum()).to.equal(2);
        });

        it('N=4 → 3', function () {
            oc.setValidatorSet(VALIDATORS_4);
            expect(oc.getQuorum()).to.equal(3);
        });

        it('N=7 → 5', function () {
            oc.setValidatorSet(VALIDATORS_7);
            expect(oc.getQuorum()).to.equal(5);
        });

        it('N=10 → 7', function () {
            oc.setValidatorSet(VALIDATORS_10);
            expect(oc.getQuorum()).to.equal(7);
        });

        it('N=13 → 9', function () {
            oc.setValidatorSet(VALIDATORS_13);
            expect(oc.getQuorum()).to.equal(9);
        });

        it('empty validator set falls back to peer count', function () {
            oc.setValidatorSet([]);
            pm.getPeerStatus.returns([{ state: 'open' }, { state: 'open' }]);
            // N = 2 peers + 1 self = 3 → quorum = 2 (majority floor)
            expect(oc.getQuorum()).to.equal(2);
        });

}

function registerGetleader3Tests8() {
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

}

function registerIsemptyfederationsnapshot4Tests10() {

        it('false for a null snapshot (indexer-unreachable degradation path)', function () {
            oc.setValidatorSet(VALIDATORS_3);
            expect(oc.isEmptyFederationSnapshot(null)).to.be.false;
        });

        it('true for an empty snapshot when federated (>= 2 registered validators)', function () {
            oc.setValidatorSet(VALIDATORS_3);   // getQuorum() = 2
            expect(oc.isEmptyFederationSnapshot({ validators: [], count: 0 })).to.be.true;
        });

        it('false for an empty snapshot when single-node (no validators, no peers)', function () {
            oc.setValidatorSet([]);
            pm.getPeerStatus.returns([]);       // getQuorum() = 0
            expect(oc.isEmptyFederationSnapshot({ validators: [], count: 0 })).to.be.false;
        });

        it('false for a non-empty snapshot even when federated', function () {
            oc.setValidatorSet(VALIDATORS_3);
            expect(oc.isEmptyFederationSnapshot({ validators: [{ pubkey: 'aa' }], count: 1 })).to.be.false;
        });

}

function registerDigest5Tests14() {
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

}

function registerQuorummet6Tests17() {

        it('count mode: vote-set size vs the round\'s locked quorum', function () {
            let pending = { weighted: false, quorum: 3, signatures: new Map() };
            expect(oc.quorumMet(pending, new Set(['a', 'b']))).to.equal(false);
            expect(oc.quorumMet(pending, new Set(['a', 'b', 'c']))).to.equal(true);
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
            expect(oc.quorumMet(sybilPending, new Set(sybils))).to.equal(false);

            // The whale alone clears it, despite an EMPTY address vote set, proving
            // the tally is over signer stake, not the prepares/commits sets.
            let whalePending = { weighted: true, validators, quorum: 0,
                signatures: new Map([['a'.repeat(64), 'sig']]) };
            expect(oc.quorumMet(whalePending, new Set())).to.equal(true);
        });

}

describe('OracleConsensus', function () {
    registerOracleconsensus1Hooks();



    // -----------------------------------------------------------------
    // getQuorum()
    // -----------------------------------------------------------------
    describe('getQuorum()', function () {
        registerGetquorum2Tests1();
    });



    // -----------------------------------------------------------------
    // _getLeader()
    // -----------------------------------------------------------------
    describe('_getLeader()', function () {
        registerGetleader3Tests8();
    });



    // -----------------------------------------------------------------
    // isEmptyFederationSnapshot()
    // -----------------------------------------------------------------
    describe('isEmptyFederationSnapshot()', function () {
        registerIsemptyfederationsnapshot4Tests10();
    });



    // -----------------------------------------------------------------
    // _digest()
    // -----------------------------------------------------------------
    describe('_digest()', function () {
        registerDigest5Tests14();
    });



    // -----------------------------------------------------------------
    // quorumMet(): count vs STAKE_WEIGHTED_QUORUM
    // -----------------------------------------------------------------
    describe('quorumMet()', function () {
        registerQuorummet6Tests17();
    });
});
