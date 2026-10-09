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

const sinon      = require('sinon');
const { expect } = require('chai');
const crypto     = require('crypto');
const Consensus       = require('../../../src/consensus/pbft');
const OracleConsensus = require('../../../src/oracle/consensus');
const OracleRound     = require('../../../src/oracle/round');
const { VALIDATORS_4, makeValidator } = require('../../helpers/fixtures');
const { signedEnvelope, createValidatorHub, wireFederationSnapshot, waitForRound } =
    require('../helpers/pbft_chaos');

function makeDigest(config) {
    return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function registerBeforeEachHook() {

    beforeEach(function () {
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });
}

function registerAfterEachHook() {

    afterEach(function () {
        sinon.restore();
    });
}

function registerAddingAValidatorMidRoundDoesTest() {

    it('adding a validator mid-round does not disrupt current consensus', async function () {
        let hub = createValidatorHub(VALIDATORS_4[0]);
        let con = new Consensus(hub);
        con.validatorSet = [...VALIDATORS_4]; // 4 validators, quorum=3
        wireFederationSnapshot(hub, 3); // round quorum locked from the N=4 snapshot
        // seq=3 → nextSeq=4 → leader=validators[(4+0)%4]=validators[0]
        con.seq = 3;
        con.timeout = 5000;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { key: 'during-churn' };
        let digest = makeDigest(config);

        let done = false;
        let promise = con.propose(config).then(() => { done = true; });
        let proposal = await waitForRound(con, 4);

        // Mid-round: add 5th validator. The live quorum moves with the set, the
        // open round keeps the quorum it locked from its snapshot.
        let v5 = makeValidator(5);
        con.validatorSet.push(v5);
        expect(proposal.quorum).to.equal(3);

        // PREPAREs from original validators
        hub._peerManager.emit('message', signedEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1]));

        hub._peerManager.emit('message', signedEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[2]));

        // COMMITs
        hub._peerManager.emit('message', signedEnvelope('PBFT_COMMIT', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1]));

        hub._peerManager.emit('message', signedEnvelope('PBFT_COMMIT', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[2]));

        await promise;
        expect(done).to.be.true;
        expect(hub.applyConfig.calledOnce).to.be.true;

        con.stop();
    });
}

function registerRemovingAValidatorMidRoundMayTest() {

    it('removing a validator mid-round does not reduce the round-locked quorum', async function () {
        let hub = createValidatorHub(VALIDATORS_4[0]);
        let con = new Consensus(hub);
        con.validatorSet = [...VALIDATORS_4]; // N=4, quorum=3
        wireFederationSnapshot(hub, 3); // round quorum locked from the N=4 snapshot
        con.seq = 3;
        con.timeout = 5000;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { key: 'remove-churn' };
        let digest = makeDigest(config);

        let done = false;
        let promise = con.propose(config).then(() => { done = true; });
        let proposal = await waitForRound(con, 4);

        // Mid-round: remove validator 4. The live quorum for N=3 drops to 2, but
        // the round still needs the 3 votes its snapshot locked.
        con.validatorSet.pop();
        expect(con.getQuorum()).to.equal(2);
        expect(proposal.quorum).to.equal(3);

        // Self + 1 PREPARE clears the live quorum but not the locked one
        hub._peerManager.emit('message', signedEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1]));
        expect(hub._peerManager.broadcast.calledWith('PBFT_COMMIT')).to.be.false;

        hub._peerManager.emit('message', signedEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[2]));
        expect(hub._peerManager.broadcast.calledWith('PBFT_COMMIT')).to.be.true;

        for (let i = 1; i <= 2; i++) {
            hub._peerManager.emit('message', signedEnvelope('PBFT_COMMIT', {
                seq: 4, configDigest: digest
            }, VALIDATORS_4[i]));
        }

        await promise;
        expect(done).to.be.true;
        expect(hub.applyConfig.calledOnce).to.be.true;

        con.stop();
    });
}

function registerLeaderRotationReflectsUpdatedValidatorSetTest() {

    it('leader rotation reflects updated validator set', function () {
        let hub = createValidatorHub(VALIDATORS_4[0]);
        let con = new Consensus(hub);
        con.validatorSet = [...VALIDATORS_4];

        // Leader for seq=1, view=0: validators[(1+0) % 4] = validators[1]
        expect(con.getLeader(1).addr).to.equal(VALIDATORS_4[1].addr);

        // Add 5th validator
        let v5 = makeValidator(5);
        con.validatorSet.push(v5);

        // Leader for seq=1, view=0: validators[(1+0) % 5] = validators[1] (same)
        expect(con.getLeader(1).addr).to.equal(VALIDATORS_4[1].addr);

        // seq=4: validators[(4+0) % 5] = validators[4] = v5
        expect(con.getLeader(4).addr).to.equal(v5.addr);
    });
}

function registerQuorumCalculationAdjustsWithValidatorSetTest() {

    it('quorum calculation adjusts with validator set changes', function () {
        let hub = createValidatorHub(VALIDATORS_4[0]);
        let con = new Consensus(hub);

        // N=4: f=1, quorum=3
        con.validatorSet = [...VALIDATORS_4];
        expect(con.getQuorum()).to.equal(3);

        // N=5: f=1, quorum=3
        con.validatorSet.push(makeValidator(5));
        expect(con.getQuorum()).to.equal(3);

        // N=7: f=2, quorum=5
        con.validatorSet.push(makeValidator(6));
        con.validatorSet.push(makeValidator(7));
        expect(con.getQuorum()).to.equal(5);

        // N=1: quorum=0 (single-node)
        con.validatorSet = [VALIDATORS_4[0]];
        expect(con.getQuorum()).to.equal(0);
    });
}

function registerOracleLeaderChangesWhenValidatorSetTest() {

    it('oracle leader changes when validator set changes between rounds', function () {
        let hub = createValidatorHub(VALIDATORS_4[0]);
        let oracle = new OracleRound(hub);
        let oracleCon = new OracleConsensus(hub, oracle);
        oracleCon.validatorSet = [...VALIDATORS_4];

        // Round 4: leader = validators[4 % 4] = validators[0]
        expect(oracleCon.getLeader(4).addr).to.equal(VALIDATORS_4[0].addr);

        // Add 5th validator
        let v5 = makeValidator(5);
        oracleCon.validatorSet.push(v5);

        // Round 4: leader = validators[4 % 5] = validators[4] = v5
        expect(oracleCon.getLeader(4).addr).to.equal(v5.addr);

        // Round 5: leader = validators[5 % 5] = validators[0]
        expect(oracleCon.getLeader(5).addr).to.equal(VALIDATORS_4[0].addr);
    });
}

function registerNewValidatorCanParticipateInSubsequentTest() {

    it('new validator can participate in subsequent round', async function () {
        let v5 = makeValidator(5);
        let hub = createValidatorHub(VALIDATORS_4[0]);
        let con = new Consensus(hub);
        con.validatorSet = [...VALIDATORS_4, v5]; // N=5, quorum=3
        // v5 has joined the on-chain set, so the round snapshot carries it too
        wireFederationSnapshot(hub, 3, con.validatorSet);
        // seq=4 → nextSeq=5 → leader=validators[(5+0)%5]=validators[0]
        con.seq = 4;
        con.timeout = 5000;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { key: 'v5-participates' };
        let digest = makeDigest(config);

        let promise = con.propose(config);
        await waitForRound(con, 5);

        // v5 and validator-2 send PREPARE
        hub._peerManager.emit('message', signedEnvelope('PBFT_PREPARE', {
            seq: 5, configDigest: digest
        }, v5));

        hub._peerManager.emit('message', signedEnvelope('PBFT_PREPARE', {
            seq: 5, configDigest: digest
        }, VALIDATORS_4[1]));

        // COMMITs
        hub._peerManager.emit('message', signedEnvelope('PBFT_COMMIT', {
            seq: 5, configDigest: digest
        }, v5));

        hub._peerManager.emit('message', signedEnvelope('PBFT_COMMIT', {
            seq: 5, configDigest: digest
        }, VALIDATORS_4[1]));

        let result = await promise;
        expect(result).to.be.true;
        expect(hub.applyConfig.calledOnce).to.be.true;

        con.stop();
    });
}

function registerRapidChurnMultipleAddsRemovesDoTest() {

    it('rapid churn: multiple adds/removes do not crash consensus', function () {
        let hub = createValidatorHub(VALIDATORS_4[0]);
        let con = new Consensus(hub);
        con.validatorSet = [...VALIDATORS_4];

        // Rapidly add validators
        for (let i = 5; i <= 15; i++) {
            con.validatorSet.push(makeValidator(i));
        }
        expect(con.getQuorum()).to.be.gt(0);

        // Remove most validators
        con.validatorSet = [VALIDATORS_4[0], VALIDATORS_4[1]];
        // N=2: max(2f+1, majority) = max(1, 2) = 2
        expect(con.getQuorum()).to.equal(2);

        // Single validator
        con.validatorSet = [VALIDATORS_4[0]];
        expect(con.getQuorum()).to.equal(0);

        // Back to normal
        con.validatorSet = [...VALIDATORS_4];
        expect(con.getQuorum()).to.equal(3);
    });
}
describe('Chaos: Validator Churn During Consensus', function () {
    this.timeout(15000);
    registerBeforeEachHook();
    registerAfterEachHook();
    registerAddingAValidatorMidRoundDoesTest();
    registerRemovingAValidatorMidRoundMayTest();
    registerLeaderRotationReflectsUpdatedValidatorSetTest();
    registerQuorumCalculationAdjustsWithValidatorSetTest();
    registerOracleLeaderChangesWhenValidatorSetTest();
    registerNewValidatorCanParticipateInSubsequentTest();
    registerRapidChurnMultipleAddsRemovesDoTest();
});
