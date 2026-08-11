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
const Consensus       = require('../../../src/Consensus');
const OracleConsensus = require('../../../src/OracleConsensus');
const OracleRound     = require('../../../src/OracleRound');
const { createMockHub }    = require('../../helpers/mockHub');
const { VALIDATORS_4, SAMPLE_PRICES } = require('../../helpers/fixtures');
const { buildEnvelope }    = require('../../helpers/testPeerNetwork');

function makeDigest(config) {
    return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

// Give a chaos hub the deterministic federation snapshot a real federated hub
// locks every round. #4168 keyed the fail-closed federation guards on the LIVE
// validator set rather than the optional MIN_VALIDATORS, so a multi-member set
// with a NULL snapshot now correctly refuses to propose. These experiments
// inject QUORUM LOSS, not an indexer outage, so they must clear that guard to
// reach the behaviour they measure. Quorum is stubbed to what _getQuorum()
// returns for the set under test, leaving each experiment's arithmetic
// unchanged.
function wireFederationSnapshot(hub, quorum) {
    let snapshot = { blockIndex: 800000, validators: [{ pubkey: 'aa', amount: '50000' }] };
    hub.capabilitySnapshot = {
        getActiveValidatorSnapshot: sinon.stub().resolves(snapshot),
        getActiveWeightSnapshot:    sinon.stub().resolves(snapshot),
        getQuorum:                  sinon.stub().returns(quorum)
    };
    hub._resolveBtcLatestBlock = sinon.stub().resolves(800000);
    return snapshot;
}

describe('Chaos: Quorum Loss (CON-2)', function () {
    this.timeout(15000);

    beforeEach(function () {
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('PBFT proposal times out when quorum is unreachable', async function () {
        // N=4, quorum=3; only 1 peer responds → insufficient
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        wireFederationSnapshot(hub, 3); // N=4 -> quorum 3; clears the #4168 federation guard
        // seq=3 → nextSeq=4 → leader=validators[0]
        con.seq = 3;
        con.timeout = 200;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { key: 'quorum-test' };
        let digest = makeDigest(config);

        let promise = con.propose(config);

        // Only 1 additional PREPARE (self + 1 = 2, need 3)
        hub._peerManager.emit('message', buildEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1].addr));

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

    it('config not applied when PREPARE quorum met but COMMIT quorum lost', async function () {
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        wireFederationSnapshot(hub, 3); // N=4 -> quorum 3; clears the #4168 federation guard
        con.seq = 3;
        con.timeout = 300;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { key: 'commit-loss' };
        let digest = makeDigest(config);

        let promise = con.propose(config);

        // Enough PREPAREs (self + 2 = 3)
        hub._peerManager.emit('message', buildEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1].addr));

        hub._peerManager.emit('message', buildEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[2].addr));

        // Only 1 additional COMMIT (self + 1 = 2, need 3)
        hub._peerManager.emit('message', buildEnvelope('PBFT_COMMIT', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1].addr));

        let err;
        try {
            await promise;
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(hub.applyConfig.called).to.be.false;

        con.stop();
    });

    it('oracle consensus skips round when quorum unreachable', async function () {
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
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

    it('oracle leader proposes but quorum never reached → timeout', async function () {
        // Round 4: leader = validators[4 % 4] = validators[0] (this node)
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        let oracle = new OracleRound(hub);
        let oracleCon = new OracleConsensus(hub, oracle);
        oracleCon.validatorSet = VALIDATORS_4;
        oracleCon.finalizationTimeout = 200;

        await oracleCon.start();

        oracle.currentRound = 4;
        oracle.submissions.set(4, new Map([
            [VALIDATORS_4[0].addr, { prices: SAMPLE_PRICES, sources: 2, timestamp: Date.now() }]
        ]));

        await oracleCon.finalizeRound(4);

        // Leader proposed
        expect(hub._peerManager.broadcast.called).to.be.true;
        let broadcastType = hub._peerManager.broadcast.getCall(0).args[0];
        expect(broadcastType).to.equal('ORACLE_PROPOSE');

        // Wait for finalization timeout
        await new Promise(r => setTimeout(r, 300));

        // Pending round cleaned up
        expect(oracleCon.pendingRounds.has(4)).to.be.false;

        oracleCon.stop();
    });

    it('view change also fails when quorum is lost', async function () {
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        hub.db.doQuery.resolves([]);

        await con.start();

        con._initiateViewChange(1);

        expect(con.view).to.equal(1);
        expect(con.pendingViewChanges.has(1)).to.be.true;

        // Only 1 additional vote (self + 1 = 2, need 3)
        hub._peerManager.emit('message', buildEnvelope('PBFT_VIEW_CHANGE', {
            view: 1, seq: 1
        }, VALIDATORS_4[1].addr));

        let votes = con.pendingViewChanges.get(1);
        expect(votes.size).to.equal(2);

        con.stop();
    });

    it('quorum restored: proposal succeeds after peers reconnect', async function () {
        let hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        let con = new Consensus(hub);
        con.validatorSet = VALIDATORS_4;
        wireFederationSnapshot(hub, 3); // N=4 -> quorum 3; clears the #4168 federation guard
        con.seq = 3;
        con.timeout = 5000;
        hub.db.doQuery.resolves([]);

        await con.start();

        let config = { key: 'restored' };
        let digest = makeDigest(config);

        let done = false;
        let promise = con.propose(config).then(() => { done = true; });

        // Initially only 1 peer responds (not enough)
        hub._peerManager.emit('message', buildEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1].addr));

        await new Promise(r => setTimeout(r, 50));
        expect(done).to.be.false;

        // Peer "reconnects"
        hub._peerManager.emit('message', buildEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[2].addr));

        // COMMITs
        hub._peerManager.emit('message', buildEnvelope('PBFT_COMMIT', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1].addr));

        hub._peerManager.emit('message', buildEnvelope('PBFT_COMMIT', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[2].addr));

        await promise;
        expect(done).to.be.true;
        expect(hub.applyConfig.calledOnce).to.be.true;

        con.stop();
    });
});
