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



        let clock;

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

function registerLeaderTimeoutFallback2Hooks() {

        afterEach(function () {
            if (clock) { clock.restore(); clock = null; }
            for (let [, t] of oc.leaderTimers) clearTimeout(t);
            for (let [, pending] of oc.pendingRounds) {
                if (pending.timer) clearTimeout(pending.timer);
            }
        });
}

function registerLeaderTimeoutFallback2Tests1() {

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
}

function registerLeaderTimeoutFallback2Tests3() {

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
                sig_pubkey: VALIDATORS_4[0].pubkey,
                data: { round: 4, prices, digest, btcBlockHeight: 900000 }
            });
            expect(oc.pendingRounds.has(4)).to.be.true;
            let proposeCalls = pm.broadcast.getCalls().filter(c => c.args[0] === 'ORACLE_PROPOSE').length;

            // Firing the grace must NOT add a second (fallback) PROPOSE.
            clock.tick(oc.leaderTimeout + 5000);
            let afterCalls = pm.broadcast.getCalls().filter(c => c.args[0] === 'ORACLE_PROPOSE').length;
            expect(afterCalls).to.equal(proposeCalls);
        });
}

function registerLeaderTimeoutFallback2Tests4() {

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
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { round: 4, prices, digest }
            });
            expect(oc.pendingRounds.has(4)).to.be.false;
            expect(pm.broadcast.called).to.be.false;

            // After the grace, the same fallback PROPOSE is accepted.
            clock.tick(oc.leaderTimeout);
            await oc._handlePropose({
                sender: VALIDATORS_4[1].addr,
                sig_pubkey: VALIDATORS_4[1].pubkey,
                data: { round: 4, prices, digest, btcBlockHeight: 900000 }
            });
            expect(oc.pendingRounds.has(4)).to.be.true;
            let [type] = pm.broadcast.getCall(0).args;
            expect(type).to.equal('ORACLE_PREPARE');
        });
}

function registerLeaderTimeoutFallback2Tests5() {

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
                sig_pubkey: VALIDATORS_4[3].pubkey,
                data: { round: 4, prices, digest }
            });
            expect(oc.pendingRounds.has(4)).to.be.false;
            expect(pm.broadcast.called).to.be.false;
        });

}

function registerStartStop3Tests6() {
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

}

describe('OracleConsensus', function () {
    registerOracleconsensus1Hooks();



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
        registerLeaderTimeoutFallback2Hooks();
        registerLeaderTimeoutFallback2Tests1();
        registerLeaderTimeoutFallback2Tests3();
        registerLeaderTimeoutFallback2Tests4();
        registerLeaderTimeoutFallback2Tests5();
    });



    // -----------------------------------------------------------------
    // start() / stop()
    // -----------------------------------------------------------------
    describe('start() / stop()', function () {
        registerStartStop3Tests6();
    });
});
