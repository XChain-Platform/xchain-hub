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
const Consensus  = require('../../../src/consensus/pbft');
const { VALIDATORS_4 } = require('../../helpers/fixtures');
const { waitUntil }    = require('../../helpers/waitUntil');
const { SNAPSHOT_BLOCK, signedEnvelope, createValidatorHub, wireFederationSnapshot, waitForRound } =
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

function registerFollowerDetectsLeaderTimeoutAndInitiatesTest() {

    it('follower detects leader timeout and initiates view change', async function () {
        // Validator-2 is a follower; leader (validator-1) will crash
        let hub = createValidatorHub(VALIDATORS_4[1]);
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        wireFederationSnapshot(hub, 3); // N=4 -> quorum 3
        con.timeout = 200;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { coin: 'BTC', action: 'test' };
        let digest = makeDigest(config);

        // Leader sends PRE_PREPARE then "crashes". seq 4, view 0 → (4+0)%4 = 0,
        // so validators[0] is the legitimate leader and this node (validators[1])
        // is a follower.
        hub._peerManager.emit('message', signedEnvelope('PBFT_PRE_PREPARE', {
            seq: 4, view: 0, configDigest: digest, config: config, btcBlockHeight: SNAPSHOT_BLOCK
        }, VALIDATORS_4[0]));

        let proposal = await waitForRound(con, 4);
        expect(proposal.prepares.has(VALIDATORS_4[1].addr)).to.be.true;
        expect(hub._peerManager.broadcast.calledWith('PBFT_PREPARE')).to.be.true;

        // Wait for the follower timeout (2x the leader timeout) to clear the proposal.
        await waitUntil(() => !con.pendingProposals.has(4), { timeoutMs: 5000, label: 'the follower timeout to drop the crashed leader proposal' });

        // Proposal should have been cleaned up by timeout
        expect(con.pendingProposals.has(4)).to.be.false;

        con.stop();
    });
}

function registerViewChangeProducesNewLeaderTest() {

    it('view change produces new leader', async function () {
        // Validator-1 proposes and times out; view change rotates leader
        let hub = createValidatorHub(VALIDATORS_4[0]);
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        wireFederationSnapshot(hub, 3); // N=4 -> quorum 3
        // seq=3 → nextSeq=4 → leader=validators[(4+0)%4]=validators[0] (this node)
        con.seq = 3;
        con.timeout = 100;
        hub.db.doQuery.resolves([]);

        await con.start();

        let err;
        try {
            await con.propose({ key: 'will-timeout' });
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(con.view).to.equal(1);

        // With view=1, leader for seq 4 = validators[(4+1) % 4] = validators[1]
        let newLeader = con.getLeader(4);
        expect(newLeader.addr).to.equal(VALIDATORS_4[1].addr);

        con.stop();
    });
}

function registerViewChangeQuorumAchievedNewLeaderTest() {

    it('view change quorum achieved → new leader broadcasts NEW_VIEW', async function () {
        // Validator-3 (index 2) becomes new leader after view change
        let hub = createValidatorHub(VALIDATORS_4[2]);
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        hub.db.doQuery.resolves([]);

        await con.start();

        // This hub holds round context for seq 1 (quorum 3, live-set rotation); a
        // federated hub without one declines to tally and catches up by NEW_VIEW.
        con.viewChangeQuorums.set(1, { quorum: 3, weighted: false, validators: [], memberPubkeys: null });

        // Receive VIEW_CHANGE votes for view=1, seq=1
        hub._peerManager.emit('message', signedEnvelope('PBFT_VIEW_CHANGE', {
            view: 1, seq: 1
        }, VALIDATORS_4[0]));

        hub._peerManager.emit('message', signedEnvelope('PBFT_VIEW_CHANGE', {
            view: 1, seq: 1
        }, VALIDATORS_4[1]));

        hub._peerManager.emit('message', signedEnvelope('PBFT_VIEW_CHANGE', {
            view: 1, seq: 1
        }, VALIDATORS_4[3]));

        // Quorum = 3 for N=4; 3 votes → view change succeeds
        expect(con.view).to.equal(1);

        // Leader for seq=1, view=1: validators[(1+1) % 4] = validators[2] → this node
        expect(con.isLeader(1)).to.be.true;

        // NEW_VIEW should have been broadcast
        expect(hub._peerManager.broadcast.calledWith('PBFT_NEW_VIEW')).to.be.true;

        con.stop();
    });
}

function registerNEWVIEWUpdatesFollowersViewNumberTest() {

    it('NEW_VIEW updates followers view number', async function () {
        let hub = createValidatorHub(VALIDATORS_4[3]);
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        hub.db.doQuery.resolves([]);

        await con.start();

        expect(con.view).to.equal(0);

        hub._peerManager.emit('message', signedEnvelope('PBFT_NEW_VIEW', {
            view: 1, seq: 1
        }, VALIDATORS_4[2]));

        expect(con.view).to.equal(1);

        con.stop();
    });
}

function registerConfigWriteCompletesUnderNewLeaderTest() {

    it('config write completes under new leader after view change', async function () {
        // New leader (validator-3, index 2) proposes after view change
        let hub = createValidatorHub(VALIDATORS_4[2]);
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        wireFederationSnapshot(hub, 3); // N=4 -> quorum 3
        con.view = 1;
        // seq=0 → nextSeq=1 → leader=validators[(1+1)%4]=validators[2] (this node)
        con.timeout = 5000;
        hub.db.doQuery.resolves([]);

        await con.start();

        expect(con.isLeader(1)).to.be.true;

        let config = { coin: 'BTC', param: 'recovered' };
        let digest = makeDigest(config);

        let done = false;
        let promise = con.propose(config).then(() => { done = true; });
        await waitForRound(con, 1);

        // Other validators send PREPARE
        hub._peerManager.emit('message', signedEnvelope('PBFT_PREPARE', {
            seq: 1, configDigest: digest
        }, VALIDATORS_4[0]));

        hub._peerManager.emit('message', signedEnvelope('PBFT_PREPARE', {
            seq: 1, configDigest: digest
        }, VALIDATORS_4[1]));

        // COMMITs
        hub._peerManager.emit('message', signedEnvelope('PBFT_COMMIT', {
            seq: 1, configDigest: digest
        }, VALIDATORS_4[0]));

        hub._peerManager.emit('message', signedEnvelope('PBFT_COMMIT', {
            seq: 1, configDigest: digest
        }, VALIDATORS_4[1]));

        await promise;
        expect(done).to.be.true;
        expect(hub.applyConfig.calledOnce).to.be.true;
        expect(hub.applyConfig.getCall(0).args[0]).to.deep.equal(config);

        con.stop();
    });
}

function registerNoDoubleApplyWhenLateCOMMITsTest() {

    it('no double-apply when late COMMITs arrive after finalization', async function () {
        let hub = createValidatorHub(VALIDATORS_4[0]);
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        wireFederationSnapshot(hub, 3); // N=4 -> quorum 3
        // seq=3 → nextSeq=4 → leader=validators[0]
        con.seq = 3;
        con.timeout = 5000;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { key: 'no-double' };
        let digest = makeDigest(config);

        let promise = con.propose(config);
        await waitForRound(con, 4);

        // PREPAREs (quorum=3: self + 2)
        for (let i = 1; i <= 2; i++) {
            hub._peerManager.emit('message', signedEnvelope('PBFT_PREPARE', {
                seq: 4, configDigest: digest
            }, VALIDATORS_4[i]));
        }

        // COMMITs (quorum=3: self + 2)
        for (let i = 1; i <= 2; i++) {
            hub._peerManager.emit('message', signedEnvelope('PBFT_COMMIT', {
                seq: 4, configDigest: digest
            }, VALIDATORS_4[i]));
        }

        await promise;
        expect(hub.applyConfig.callCount).to.equal(1);

        // Late COMMIT from validator-4
        hub._peerManager.emit('message', signedEnvelope('PBFT_COMMIT', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[3]));

        // The round is already applied, and the late-COMMIT dedup is decided inside the
        // synchronous handler above, so there is nothing left to settle for.

        // Still only applied once
        expect(hub.applyConfig.callCount).to.equal(1);

        con.stop();
    });
}
describe('Chaos: PBFT Leader Crash (CON-1)', function () {
    this.timeout(15000);
    registerBeforeEachHook();
    registerAfterEachHook();
    registerFollowerDetectsLeaderTimeoutAndInitiatesTest();
    registerViewChangeProducesNewLeaderTest();
    registerViewChangeQuorumAchievedNewLeaderTest();
    registerNEWVIEWUpdatesFollowersViewNumberTest();
    registerConfigWriteCompletesUnderNewLeaderTest();
    registerNoDoubleApplyWhenLateCOMMITsTest();
});
