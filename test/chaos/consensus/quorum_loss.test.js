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
const { VALIDATORS_4, SAMPLE_PRICES, makeCapabilitySnapshotStub } = require('../../helpers/fixtures');
const { waitUntil }        = require('../../helpers/waitUntil');
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

function registerPBFTProposalTimesOutWhenQuorumTest() {

    it('PBFT proposal times out when quorum is unreachable', async function () {
        // N=4, quorum=3; only 1 peer responds → insufficient
        let hub = createValidatorHub(VALIDATORS_4[0]);
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        wireFederationSnapshot(hub, 3); // N=4 -> quorum 3
        // seq=3 → nextSeq=4 → leader=validators[0]
        con.seq = 3;
        con.timeout = 200;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { key: 'quorum-test' };
        let digest = makeDigest(config);

        let promise = con.propose(config);
        await waitForRound(con, 4);

        // Only 1 additional PREPARE (self + 1 = 2, need 3)
        hub._peerManager.emit('message', signedEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1]));

        let err;
        try {
            await promise;
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(err.message).to.include('Consensus timeout');
        expect(err.message).to.include('2 prepares');
        expect(err.message).to.include('need 3');

        con.stop();
    });
}

function registerConfigNotAppliedWhenPREPAREQuorumTest() {

    it('config not applied when PREPARE quorum met but COMMIT quorum lost', async function () {
        let hub = createValidatorHub(VALIDATORS_4[0]);
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        wireFederationSnapshot(hub, 3); // N=4 -> quorum 3
        con.seq = 3;
        con.timeout = 300;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { key: 'commit-loss' };
        let digest = makeDigest(config);

        let promise = con.propose(config);
        await waitForRound(con, 4);

        // Enough PREPAREs (self + 2 = 3)
        hub._peerManager.emit('message', signedEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1]));

        hub._peerManager.emit('message', signedEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[2]));
        expect(hub._peerManager.broadcast.calledWith('PBFT_COMMIT')).to.be.true;

        // Only 1 additional COMMIT (self + 1 = 2, need 3)
        hub._peerManager.emit('message', signedEnvelope('PBFT_COMMIT', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1]));

        let err;
        try {
            await promise;
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(err.message).to.include('2 commits');
        expect(hub.applyConfig.called).to.be.false;

        con.stop();
    });
}

function registerOracleConsensusSkipsRoundWhenQuorumTest() {

    it('oracle consensus skips round when quorum unreachable', async function () {
        let hub = createValidatorHub(VALIDATORS_4[0]);
        let oracle = new OracleRound(hub);
        let oracleCon = new OracleConsensus(hub, oracle);
        oracleCon.validatorSet = VALIDATORS_4;
        oracleCon.finalizationTimeout = 200;

        await oracleCon.start();

        // Round 5 with 1 submission
        oracle.currentRound = 5;
        oracle.submissions.set(5, new Map([
            [VALIDATORS_4[0].addr, { prices: SAMPLE_PRICES, sources: 2, timestamp: Date.now() }]
        ]));

        // Leader for round 5: validators[5 % 4] = validators[1]
        // This node is validators[0] → NOT the leader → just waits
        await oracleCon.finalizeRound(5);

        // Not the leader, so nothing happens
        expect(oracleCon.pendingRounds.has(5)).to.be.false;

        oracleCon.stop();
    });
}

function registerOracleLeaderProposesButQuorumNeverTest() {

    it('oracle leader proposes but quorum never reached → timeout', async function () {
        // Round 4: leader = validators[4 % 4] = validators[0] (this node)
        let hub = createValidatorHub(VALIDATORS_4[0]);
        let oracle = new OracleRound(hub);
        let oracleCon = new OracleConsensus(hub, oracle);
        oracleCon.validatorSet = VALIDATORS_4;
        oracleCon.finalizationTimeout = 200;
        // Block-locked price snapshot over the same four members (quorum 3): a
        // federated oracle skips a round it cannot anchor, before any PROPOSE.
        hub.capabilitySnapshot = makeCapabilitySnapshotStub(VALIDATORS_4);

        await oracleCon.start();

        // Two member submissions clear the default ORACLE_MIN_SUBMISSIONS floor;
        // each is keyed to snapshot membership by its proven signing key.
        oracle.currentRound = 4;
        oracle.submissions.set(4, new Map(VALIDATORS_4.slice(0, 2).map(v =>
            [v.addr, { prices: SAMPLE_PRICES, sources: 2, timestamp: Date.now(), pubkey: v.pubkey }])));

        await oracleCon.finalizeRound(4);

        // Leader proposed
        await waitUntil(() => hub._peerManager.broadcast.called, { label: 'the oracle leader PROPOSE' });
        let broadcastType = hub._peerManager.broadcast.getCall(0).args[0];
        expect(broadcastType).to.equal('ORACLE_PROPOSE');
        expect(oracleCon.pendingRounds.has(4)).to.be.true;

        // Wait for finalization timeout
        // Wait for the finalization timeout to clean the round up.
        await waitUntil(() => !oracleCon.pendingRounds.has(4), { timeoutMs: 5000, label: 'the finalization timeout to clear round 4' });

        // Pending round cleaned up
        expect(oracleCon.pendingRounds.has(4)).to.be.false;

        oracleCon.stop();
    });
}

function registerViewChangeAlsoFailsWhenQuorumTest() {

    it('view change also fails when quorum is lost', async function () {
        let hub = createValidatorHub(VALIDATORS_4[0]);
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        hub.db.doQuery.resolves([]);

        await con.start();

        con.initiateViewChange(1);

        expect(con.view).to.equal(1);
        expect(con.pendingViewChanges.has(1)).to.be.true;

        // Only 1 additional vote (self + 1 = 2, need 3)
        hub._peerManager.emit('message', signedEnvelope('PBFT_VIEW_CHANGE', {
            view: 1, seq: 1
        }, VALIDATORS_4[1]));

        let votes = con.pendingViewChanges.get(1);
        expect(votes.size).to.equal(2);
        expect(hub._peerManager.broadcast.calledWith('PBFT_NEW_VIEW')).to.be.false;

        con.stop();
    });
}

function registerQuorumRestoredProposalSucceedsAfterPeersTest() {

    it('quorum restored: proposal succeeds after peers reconnect', async function () {
        let hub = createValidatorHub(VALIDATORS_4[0]);
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        wireFederationSnapshot(hub, 3); // N=4 -> quorum 3
        con.seq = 3;
        con.timeout = 5000;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { key: 'restored' };
        let digest = makeDigest(config);

        let done = false;
        let promise = con.propose(config).then(() => { done = true; });
        let proposal = await waitForRound(con, 4);

        // Initially only 1 peer responds (not enough)
        hub._peerManager.emit('message', signedEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1]));

        // The round is open (self PREPARE recorded) and one peer has been heard from;
        // that is the state the "not done yet" assertion is about.
        expect(proposal.prepares.size).to.equal(2);
        expect(hub._peerManager.broadcast.calledWith('PBFT_COMMIT')).to.be.false;
        expect(done).to.be.false;

        // Peer "reconnects"
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
describe('Chaos: Quorum Loss (CON-2)', function () {
    this.timeout(15000);
    registerBeforeEachHook();
    registerAfterEachHook();
    registerPBFTProposalTimesOutWhenQuorumTest();
    registerConfigNotAppliedWhenPREPAREQuorumTest();
    registerOracleConsensusSkipsRoundWhenQuorumTest();
    registerOracleLeaderProposesButQuorumNeverTest();
    registerViewChangeAlsoFailsWhenQuorumTest();
    registerQuorumRestoredProposalSucceedsAfterPeersTest();
});
