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

const { expect } = require('chai');
const sinon = require('sinon');
const RewardTracker = require('../../../src/anchor/reward_tracker');
const OracleConsensus = require('../../../src/oracle/consensus');
const validatorQueries = require('../../../src/db/validators');
const { createMockHub } = require('../../helpers/mockHub');

function pubkey(n) {
    return n.toString(16).padStart(64, '0');
}

function trackerHarness() {
    const createValidatorRoundReward = sinon.stub().resolves();
    const broadcaster = {
        broadcastRow: sinon.stub(),
        broadcastDeletion: sinon.stub()
    };
    const hub = {
        db: { createValidatorRoundReward },
        hubDbBroadcaster: broadcaster,
        p2pConfig: { ORACLE_REWARD_PER_ROUND: '10.00000000' }
    };
    return {
        tracker: new RewardTracker(hub),
        createValidatorRoundReward,
        broadcaster
    };
}

function expectAnchorOnlyQuery(call) {
    const sql = call.args[0];
    expect(sql).to.include("WHERE reward_type LIKE 'anchor\\_%'");
    expect(sql).to.not.include('oracle_round');
}

async function finalizedParticipants(prepares) {
    const consensus = new OracleConsensus(createMockHub(), {
        getSubmissions: sinon.stub().returns(new Map())
    });
    const commonVoters = prepares.slice(0, 3);
    const pending = {
        prepares: new Set(prepares),
        commits: new Set(commonVoters),
        signatures: new Map(commonVoters.map(pk => [pk, 'sig-' + pk])),
        prices: [{ coinPair: 'BTC/USD', price: '100000' }],
        btcBlockHeight: 950000,
        btcBlockTime: 1759276800,
        finalized: true
    };
    let event;

    sinon.stub(consensus, 'storeSnapshot').resolves();
    consensus.pendingRounds.set(3141, pending);
    consensus.on('round:finalized', value => { event = value; });

    await consensus.finalizeCommittedRound(3141);

    expect(event).to.be.an('object');
    expect(event.participants).to.deep.equal(prepares);
    return event.participants;
}

describe('oracle round reward advisory', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('records round rewards only through the hub-local reward method', async function () {
        const harness = trackerHarness();
        const participants = [pubkey(1), pubkey(2)];

        await harness.tracker.distributeRewards(77, participants, 950000);

        expect(harness.createValidatorRoundReward.callCount).to.equal(2);
        expect(harness.createValidatorRoundReward.getCall(0).args)
            .to.deep.equal([participants[0], 77, '5.00000000']);
        expect(harness.createValidatorRoundReward.getCall(1).args)
            .to.deep.equal([participants[1], 77, '5.00000000']);
        expect(harness.broadcaster.broadcastRow.called).to.equal(false);
        expect(harness.broadcaster.broadcastDeletion.called).to.equal(false);
    });

    it('keeps oracle round rows out of both anchor archive selectors', async function () {
        const db = { doQuery: sinon.stub().resolves([]) };

        await validatorQueries.findArchivableAnchorRewards.call(db, 25);
        await validatorQueries.findArchivableAnchorRewardsBelowFlagDays.call(
            db, ['anchor_BTC', 'anchor_LTC'], 963000,
            'anchor_archive', 963100, 50);

        expect(db.doQuery.callCount).to.equal(2);
        expectAnchorOnlyQuery(db.doQuery.getCall(0));
        expectAnchorOnlyQuery(db.doQuery.getCall(1));
        expect(db.doQuery.getCall(0).args[1]).to.deep.equal([25]);
        expect(db.doQuery.getCall(1).args[1]).to.deep.equal([
            'anchor_BTC', 'anchor_LTC', 963000, 'anchor_archive', 963100, 50
        ]);
    });

    it('derives each reward split from the consensus commit-time prepare set', async function () {
        const fourMemberTracker = trackerHarness();
        const fiveMemberTracker = trackerHarness();
        const fourPrepares = [1, 2, 3, 4].map(pubkey);
        const fivePrepares = [1, 2, 3, 4, 5].map(pubkey);
        const fourParticipants = await finalizedParticipants(fourPrepares);
        const fiveParticipants = await finalizedParticipants(fivePrepares);

        await fourMemberTracker.tracker.distributeRewards(3141, fourParticipants, 950000);
        await fiveMemberTracker.tracker.distributeRewards(3141, fiveParticipants, 950000);

        expect(fourMemberTracker.createValidatorRoundReward.callCount).to.equal(4);
        expect(fiveMemberTracker.createValidatorRoundReward.callCount).to.equal(5);
        for (const call of fourMemberTracker.createValidatorRoundReward.getCalls()) {
            expect(call.args[1]).to.equal(3141);
            expect(call.args[2]).to.equal('2.50000000');
        }
        for (const call of fiveMemberTracker.createValidatorRoundReward.getCalls()) {
            expect(call.args[1]).to.equal(3141);
            expect(call.args[2]).to.equal('2.00000000');
        }
    });
});
