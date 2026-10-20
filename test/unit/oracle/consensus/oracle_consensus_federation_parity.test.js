'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Leader and follower must refuse exactly the same oracle rounds. A hub whose loaded
// validatorSet has ONE entry reads getQuorum() === 0 even with verified open peers, so
// every gate that tested `getQuorum() > 0` treated it as single-node. Once
// FEDERATED_HUB_ACTIVATION is active every snapshot gate uses the widened test at the
// round's anchor, and the PROPOSE height bound anchors that test on this hub's own tip,
// since the proposer chooses the wire height.

const sinon            = require('sinon');
const { expect }       = require('chai');
const OracleConsensus  = require('../../../../src/oracle/consensus');
const swq              = require('../../../../src/consensus/stake_weighted_quorum.js');
const registry         = require('../../../../src/consensus/gate_registry.js');
const { roundIsFederated } = require('../../../../src/consensus/federation.js');
const logger           = require('../../../../src/observability').getLogger();
const { createMockHub } = require('../../../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions } = require('../../../helpers/fixtures');

const KEY    = 'consensus/federation.FEDERATED_HUB_ACTIVATION';
const HEIGHT = 900000;
const PRICES = [{ coinPair: 'BTC/USD', price: '100000' }];
const LEADER = VALIDATORS_3[0];
const ME     = VALIDATORS_3[1];

function nullSnapshotSource() {
    return {
        getSnapshot: sinon.stub().resolves(null),
        getWeightSnapshot: sinon.stub().resolves(null),
        getQuorum: sinon.stub().returns(0)
    };
}

// A follower with a one-entry validatorSet (itself) and one verified open peer (the leader).
function oneEntryHub(network, tip) {
    let hub = createMockHub({ network });
    hub.resolveBtcLatestBlock = sinon.stub().resolves(tip);
    hub.capabilitySnapshot = nullSnapshotSource();
    let pm = hub._peerManager;
    pm.validatorPubkeys = new Set();
    pm.validatorAddr = ME.addr;
    pm.getPeerStatus.returns([{ state: 'open', addr: LEADER.addr, validatorAddr: LEADER.addr, identityVerified: true }]);
    let oracleRound = { getSubmissions: sinon.stub().returns(buildSubmissions(VALIDATORS_3.map(v => ({ sender: v.addr, prices: PRICES })))) };
    let oc = new OracleConsensus(hub, oracleRound);
    oc.minSubmissions = 1;
    oc.setValidatorSet([ME]);
    return { hub, pm, oc };
}

function proposeEnvelope(oc, round, btcBlockHeight) {
    return { type: 'ORACLE_PROPOSE', sender: LEADER.addr, sig_pubkey: LEADER.pubkey,
             data: { round, prices: PRICES, digest: oc.digest(round, PRICES), btcBlockHeight } };
}

function warned(warn, text) {
    return warn.args.some(args => String(args[0]).includes(text));
}

describe('OracleConsensus: leader and follower share one federation test', function () {
    let warn;
    beforeEach(function () { warn = sinon.stub(logger, 'warn'); });
    afterEach(function () { sinon.restore(); });

    it('reads a one-entry validatorSet with an open peer as federated once the gate is active', function () {
        let { oc } = oneEntryHub('regtest', HEIGHT);
        expect(oc.getQuorum(), 'the premise: the bare quorum test reads single-node').to.equal(0);
        expect(roundIsFederated(oc, HEIGHT)).to.equal(true);
        expect(roundIsFederated(oneEntryHub('mainnet', HEIGHT).oc, HEIGHT), 'mainnet is unarmed').to.equal(false);
    });

    it('skips an empty federation snapshot at the round anchor, and keeps the legacy answer without one', function () {
        let { oc } = oneEntryHub('regtest', HEIGHT);
        expect(oc.isEmptyFederationSnapshot({ validators: [] }, HEIGHT)).to.equal(true);
        expect(oc.isEmptyFederationSnapshot({ validators: [] })).to.equal(false);
        expect(oneEntryHub('mainnet', HEIGHT).oc.isEmptyFederationSnapshot({ validators: [] }, HEIGHT)).to.equal(false);
    });

    it('drops a PROPOSE with no deterministic snapshot where the leader skips the same round', async function () {
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        let { oc, pm } = oneEntryHub('regtest', HEIGHT);
        await oc.handlePropose(proposeEnvelope(oc, 0, HEIGHT));
        expect(oc.pendingRounds.has(0)).to.equal(false);
        expect(pm.broadcast.called).to.equal(false);
        expect(warned(warn, 'no deterministic price capability snapshot')).to.equal(true);

        let leaderSide = oneEntryHub('regtest', HEIGHT);
        let skip = sinon.stub(leaderSide.oc, 'storeSkippedRound').resolves();
        await leaderSide.oc.finalizeRound(0, HEIGHT, 1700000000);
        expect(skip.calledOnce).to.equal(true);
        expect(skip.firstCall.args[3]).to.equal('no deterministic capability snapshot');
    });

    it('drops a weighted PROPOSE with no weight snapshot where the leader skips it too', async function () {
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(true);
        let { oc } = oneEntryHub('regtest', HEIGHT);
        await oc.handlePropose(proposeEnvelope(oc, 0, HEIGHT));
        expect(oc.pendingRounds.has(0)).to.equal(false);
        expect(warned(warn, 'weighted mode active but weight snapshot unavailable while federated')).to.equal(true);

        let leaderSide = oneEntryHub('regtest', HEIGHT);
        let skip = sinon.stub(leaderSide.oc, 'storeSkippedRound').resolves();
        await leaderSide.oc.finalizeRound(0, HEIGHT, 1700000000);
        expect(skip.firstCall.args[3]).to.equal('weighted quorum active but weight snapshot unavailable');
    });
});

describe('OracleConsensus: the PROPOSE height bound on a widened federated hub', function () {
    let warn;
    beforeEach(function () { warn = sinon.stub(logger, 'warn'); });
    afterEach(function () { sinon.restore(); });

    it('drops an absent height and a stale height, and keeps a fresh one', async function () {
        let { oc } = oneEntryHub('regtest', HEIGHT);
        expect(await oc.boundedProposeHeight(5, undefined)).to.equal(null);
        expect(await oc.boundedProposeHeight(5, HEIGHT - 1000)).to.equal(null);
        expect(await oc.boundedProposeHeight(5, HEIGHT)).to.equal(HEIGHT);
    });

    it('anchors activation on its own tip, so a stale pre-activation wire height cannot escape the bound', async function () {
        let activation = registry.get(KEY).testnet;
        let { oc } = oneEntryHub('testnet', activation + 100);
        expect(await oc.boundedProposeHeight(5, 100)).to.equal(null);
        expect(warned(warn, 'deviates from our own BTC tip')).to.equal(true);
        expect(await oc.boundedProposeHeight(5, undefined)).to.equal(null);
        expect(await oc.boundedProposeHeight(5, activation + 100)).to.equal(activation + 100);
    });

    it('fails closed on an armed network when its own tip cannot be resolved', async function () {
        let activation = registry.get(KEY).testnet;
        let { oc } = oneEntryHub('testnet', null);
        expect(await oc.boundedProposeHeight(5, activation + 100)).to.equal(null);
        expect(warned(warn, 'cannot resolve our own BTC tip')).to.equal(true);
    });

    it('keeps the legacy round-as-anchor path before activation and on unarmed mainnet', async function () {
        let activation = registry.get(KEY).testnet;
        expect(await oneEntryHub('testnet', activation - 100).oc.boundedProposeHeight(5, undefined)).to.equal(5);
        let mainnet = oneEntryHub('mainnet', HEIGHT).oc;
        expect(await mainnet.boundedProposeHeight(5, undefined)).to.equal(5);
        expect(await mainnet.boundedProposeHeight(5, 100)).to.equal(100);
    });
});
