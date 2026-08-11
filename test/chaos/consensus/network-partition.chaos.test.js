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
const Consensus  = require('../../../src/Consensus');
const { createMockHub }                    = require('../../helpers/mockHub');
const { VALIDATORS_4 }                     = require('../../helpers/fixtures');
const { buildEnvelope }                    = require('../../helpers/testPeerNetwork');
const { runExperiment, waitForCondition }  = require('../helpers/chaosRunner');

function makeDigest(config) {
    return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

// Give a chaos hub the deterministic federation snapshot a real federated hub
// locks every round. #4168 keyed the fail-closed federation guards on the LIVE
// validator set rather than the optional MIN_VALIDATORS, so a multi-member set
// with a NULL snapshot now correctly refuses to propose. These experiments
// inject a PARTITION, not an indexer outage, so they must clear that guard to
// reach the behaviour they measure. Quorum is stubbed to what _getQuorum()
// returns for the set under test, leaving each experiment's arithmetic
// unchanged; the genuinely peerless hub below keeps its empty validator set and
// stays on the single-node path either way.
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

describe('Chaos: Network Partition (NET-3)', function () {
    this.timeout(15000);

    let hub, pm, consensus;

    beforeEach(function () {
        hub = createMockHub({ validatorAddr: VALIDATORS_4[0].addr });
        pm  = hub._peerManager;
        consensus = new Consensus(hub);
        consensus.validatorSet = VALIDATORS_4;
        // seq=3 so nextSeq=4 → leader = validators[(4+0)%4] = validators[0] (this node)
        consensus.seq = 3;

        hub.db.doQuery.resolves([]);

        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });

    afterEach(function () {
        consensus.stop();
        sinon.restore();
    });

    it('isolated node times out and initiates view change', async function () {
        consensus.timeout = 200;
        wireFederationSnapshot(hub, 3); // N=4 -> quorum 3; clears the #4168 federation guard

        await consensus.start();

        // This node is leader for seq 4; propose a config
        let err;
        try {
            await consensus.propose({ key: 'val' });
        } catch (e) {
            err = e;
        }

        expect(err).to.exist;
        expect(err.message).to.include('Consensus timeout');

        // View change should have been initiated
        expect(consensus.view).to.equal(1);
        expect(pm.broadcast.calledWith('PBFT_VIEW_CHANGE')).to.be.true;
    });

    it('majority cluster continues when one node is isolated', async function () {
        // Validator-2 as system under test; validator-1 (leader) sends PRE_PREPARE
        let hub2 = createMockHub({ validatorAddr: VALIDATORS_4[1].addr });
        let consensus2 = new Consensus(hub2);
        consensus2.validatorSet = VALIDATORS_4;
        consensus2.timeout = 500;

        await consensus2.start();

        let config = { coin: 'BTC', param: 'test' };
        let digest = makeDigest(config);

        // Leader (validators[0]) sends PRE_PREPARE for seq 4. At view 0,
        // (4+0)%4 = 0, so validators[0] is the legitimate rotation leader.
        hub2._peerManager.emit('message', buildEnvelope('PBFT_PRE_PREPARE', {
            seq: 4, view: 0, configDigest: digest, config: config
        }, VALIDATORS_4[0].addr));

        // Validator 3 sends PREPARE (quorum = 3 for N=4)
        hub2._peerManager.emit('message', buildEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[2].addr));

        // With prepares from validators 0, 1, 2 = 3, quorum met
        let proposal = consensus2.pendingProposals.get(4);
        expect(proposal).to.exist;
        expect(proposal.prepares.size).to.be.gte(3);

        // COMMITs from validators 0, 2
        hub2._peerManager.emit('message', buildEnvelope('PBFT_COMMIT', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[0].addr));

        hub2._peerManager.emit('message', buildEnvelope('PBFT_COMMIT', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[2].addr));

        await new Promise(r => setTimeout(r, 50));

        expect(hub2.applyConfig.calledOnce).to.be.true;
        expect(hub2.applyConfig.getCall(0).args[0]).to.deep.equal(config);

        consensus2.stop();
    });

    it('single-node fallback activates when all peers lost', async function () {
        let hub1 = createMockHub({ validatorAddr: 'ws://lonely:10001' });
        let con1 = new Consensus(hub1);
        con1.validatorSet = [];
        hub1._peerManager.getPeerStatus.returns([]);

        await con1.start();

        let result = await con1.propose({ key: 'solo-val' });
        expect(result).to.be.true;
        expect(hub1.applyConfig.calledOnce).to.be.true;

        con1.stop();
    });

    it('partition heals: late PREPARE/COMMIT still processed', async function () {
        consensus.timeout = 5000;
        wireFederationSnapshot(hub, 3); // N=4 -> quorum 3; clears the #4168 federation guard
        await consensus.start();

        let config = { key: 'delayed' };
        let digest = makeDigest(config);

        let done = false;
        let promise = consensus.propose(config).then(() => { done = true; });

        // seq is now 4; initially only 1 PREPARE (self), not enough
        await new Promise(r => setTimeout(r, 50));
        expect(done).to.be.false;

        // "Partition heals": delayed PREPAREs arrive
        pm.emit('message', buildEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1].addr));

        pm.emit('message', buildEnvelope('PBFT_PREPARE', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[2].addr));

        // COMMITs arrive
        pm.emit('message', buildEnvelope('PBFT_COMMIT', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[1].addr));

        pm.emit('message', buildEnvelope('PBFT_COMMIT', {
            seq: 4, configDigest: digest
        }, VALIDATORS_4[2].addr));

        await promise;
        expect(done).to.be.true;
        expect(hub.applyConfig.calledOnce).to.be.true;
    });

    it('stale sequence rejected after partition recovery', async function () {
        await consensus.start();
        consensus.lastAppliedSeq = 10;

        let config = { key: 'stale' };
        let digest = makeDigest(config);

        // sender is the legit (seq 5, view 0) leader. The stale-seq guard
        // (not the identity guard) is what rejects it.
        pm.emit('message', buildEnvelope('PBFT_PRE_PREPARE', {
            seq: 5, view: 0, configDigest: digest, config: config
        }, VALIDATORS_4[1].addr));

        // Should be rejected; no proposal created
        expect(consensus.pendingProposals.has(5)).to.be.false;
    });
});
