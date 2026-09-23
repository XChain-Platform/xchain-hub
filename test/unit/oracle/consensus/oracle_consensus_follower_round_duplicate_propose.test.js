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

const sinon             = require('sinon');
const { expect }        = require('chai');
const OracleConsensus   = require('../../../../src/oracle/consensus');
const { createMockHub } = require('../../../helpers/mockHub');
const { VALIDATORS_3, makeCapabilitySnapshotStub } = require('../../../helpers/fixtures');

const ROUND        = 300;
const BLOCK_HEIGHT = 1000;
const PRICES       = [{ coinPair: 'BTC/USD', price: '100.00000000' }];

function createHarness() {
    let leader = VALIDATORS_3[0];
    let follower = VALIDATORS_3[1];
    let thirdParty = VALIDATORS_3[2];
    let clock = sinon.useFakeTimers();
    let hub = createMockHub({ validatorAddr: follower.addr });
    hub.resolveBtcLatestBlock = sinon.stub().resolves(BLOCK_HEIGHT);
    hub.capabilitySnapshot = makeCapabilitySnapshotStub(VALIDATORS_3);
    let oracleRound = { getSubmissions: sinon.stub().returns(new Map()) };
    let oc = new OracleConsensus(hub, oracleRound);
    oc.setValidatorSet(VALIDATORS_3);
    oc._lastFinalizedPrices = new Map([['BTC/USD', '100.00000000']]);
    let digest = oc.digest(ROUND, PRICES);
    return { clock, digest, leader, thirdParty, oc, pm: hub._peerManager };
}

function proposeEnvelope(harness) {
    return {
        sender: harness.leader.addr,
        sig_pubkey: harness.leader.pubkey,
        data: {
            round: ROUND,
            prices: PRICES,
            digest: harness.digest,
            btcBlockHeight: BLOCK_HEIGHT,
            btcBlockTime: 1700000000
        }
    };
}

function prepareEnvelope(harness) {
    return {
        type: 'ORACLE_PREPARE',
        sender: harness.thirdParty.addr,
        sig_pubkey: harness.thirdParty.pubkey,
        data: { round: ROUND, digest: harness.digest }
    };
}

describe('OracleConsensus: duplicate follower PROPOSE', function () {
    let harness;

    beforeEach(function () {
        harness = createHarness();
    });

    afterEach(function () {
        harness.oc.stop();
        harness.clock.restore();
        sinon.restore();
    });

    it('keeps the first round, its votes, and its timers', async function () {
        let { oc, pm, clock, thirdParty } = harness;
        await oc.handlePropose(proposeEnvelope(harness));
        let firstPending = oc.pendingRounds.get(ROUND);
        expect(firstPending, 'first follower round must exist').to.exist;

        oc.handlePrepare(prepareEnvelope(harness));
        await clock.tickAsync(0);
        expect(firstPending.prepares.has(thirdParty.pubkey)).to.be.true;
        let broadcastsBeforeDuplicate = pm.broadcast.callCount;
        let timersBeforeDuplicate = clock.countTimers();

        await oc.handlePropose(proposeEnvelope(harness));
        await clock.tickAsync(0);

        expect(oc.pendingRounds.size).to.equal(1);
        expect(oc.pendingRounds.get(ROUND)).to.equal(firstPending);
        expect(firstPending.prepares.has(thirdParty.pubkey)).to.be.true;
        expect(pm.broadcast.callCount).to.equal(broadcastsBeforeDuplicate);
        expect(clock.countTimers()).to.equal(timersBeforeDuplicate);
    });

    it('does not replace the first round for a conflicting proposal', async function () {
        let { oc, clock, digest } = harness;
        await oc.handlePropose(proposeEnvelope(harness));
        let firstPending = oc.pendingRounds.get(ROUND);
        let timersBeforeConflict = clock.countTimers();
        let conflicting = proposeEnvelope(harness);
        conflicting.data.prices = [{ coinPair: 'BTC/USD', price: '999.00000000' }];
        conflicting.data.digest = oc.digest(ROUND, conflicting.data.prices);

        await oc.handlePropose(conflicting);

        expect(oc.pendingRounds.size).to.equal(1);
        expect(oc.pendingRounds.get(ROUND)).to.equal(firstPending);
        expect(firstPending.digest).to.equal(digest);
        expect(clock.countTimers()).to.equal(timersBeforeConflict);
    });
});
