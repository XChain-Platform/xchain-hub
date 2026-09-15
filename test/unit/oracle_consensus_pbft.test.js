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

function registerPbftMessageFlow2Hooks() {

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
}

function registerPbftMessageFlow2Tests1() {

        it('PREPARE from peer is recorded', function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(1, prices);

            oc.pendingRounds.set(1, {
                prices, digest, prepares: new Set(), commits: new Set(),
                finalized: false, timer: null
            });

            oc.handlePrepare({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { round: 1, digest }
            });

            expect(oc.pendingRounds.get(1).prepares.has(VALIDATORS_4[1].pubkey)).to.be.true;
        });

        it('PREPARE with wrong digest is rejected', function () {
            let prices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];
            let digest = oc._digest(1, prices);

            oc.pendingRounds.set(1, {
                prices, digest, prepares: new Set(), commits: new Set(),
                finalized: false, timer: null
            });

            oc.handlePrepare({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { round: 1, digest: 'wrong-digest' }
            });

            expect(oc.pendingRounds.get(1).prepares.size).to.equal(0);
        });
}

function registerPbftMessageFlow2Tests3() {

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
            oc.handlePrepare({
                sender: VALIDATORS_4[2].addr,
                sig_pubkey: VALIDATORS_4[2].pubkey,
                data: { round: 1, digest }
            });

            expect(pm.broadcast.called).to.be.true;
            let [type] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_COMMIT');
        });
}

function registerPbftMessageFlow2Tests4() {

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
                sig_pubkey: VALIDATORS_4[2].pubkey,
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

            oc.handlePrepare({ sender: VALIDATORS_4[1].addr, sig_pubkey: VALIDATORS_4[1].pubkey, data: { round: 1, digest } });
            oc.handlePrepare({ sender: VALIDATORS_4[1].addr, sig_pubkey: VALIDATORS_4[1].pubkey, data: { round: 1, digest } });

            expect(oc.pendingRounds.get(1).prepares.size).to.equal(1);
        });

}

describe('OracleConsensus', function () {
    registerOracleconsensus1Hooks();



    // -----------------------------------------------------------------
    // PBFT message flow
    // -----------------------------------------------------------------
    describe('PBFT message flow', function () {
        registerPbftMessageFlow2Hooks();
        registerPbftMessageFlow2Tests1();
        registerPbftMessageFlow2Tests3();
        registerPbftMessageFlow2Tests4();
    });
});
