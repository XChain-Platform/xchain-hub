'use strict';

const sinon          = require('sinon');
const { expect }     = require('chai');
const RewardTracker  = require('../../src/RewardTracker');
const { createMockHub }     = require('../helpers/mockHub');

describe('RewardTracker', function () {

    let hub, rt;

    beforeEach(function () {
        hub = createMockHub({
            p2pConfig: { ORACLE_REWARD_PER_ROUND: '10.00000000' }
        });
        rt = new RewardTracker(hub);
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------

    describe('configuration', function () {
        it('uses configured reward per round', function () {
            expect(rt.rewardPerRound).to.equal('10.00000000');
        });

        it('defaults to 10.00000000', function () {
            let rt2 = new RewardTracker(createMockHub({ p2pConfig: {} }));
            expect(rt2.rewardPerRound).to.equal('10.00000000');
        });
    });

    // -----------------------------------------------------------------
    // distributeRewards()
    // -----------------------------------------------------------------

    describe('distributeRewards()', function () {

        it('equal split — 10 / 5 = 2.00000000 each', async function () {
            let participants = ['pk1', 'pk2', 'pk3', 'pk4', 'pk5'];
            await rt.distributeRewards(1, participants);

            expect(hub.db.doQuery.callCount).to.equal(5);
            for (let i = 0; i < 5; i++) {
                let args = hub.db.doQuery.getCall(i).args;
                expect(args[1][0]).to.equal(participants[i]);
                expect(args[1][1]).to.equal(1); // round
                expect(args[1][2]).to.equal('2.00000000');
            }
        });

        it('single participant gets full reward', async function () {
            await rt.distributeRewards(1, ['pk1']);
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[1][2]).to.equal('10.00000000');
        });

        it('odd division — 10 / 3 = 3.33333333 each', async function () {
            await rt.distributeRewards(1, ['pk1', 'pk2', 'pk3']);
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[1][2]).to.equal('3.33333333');
        });

        it('zero participants — no DB calls', async function () {
            await rt.distributeRewards(1, []);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('null participants — no DB calls', async function () {
            await rt.distributeRewards(1, null);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('continues if one INSERT fails', async function () {
            hub.db.doQuery.onFirstCall().rejects(new Error('dup'));
            hub.db.doQuery.onSecondCall().resolves();

            await rt.distributeRewards(1, ['pk1', 'pk2']);
            expect(hub.db.doQuery.callCount).to.equal(2); // both attempted
        });
    });

    // -----------------------------------------------------------------
    // getUnclaimedRewards()
    // -----------------------------------------------------------------

    describe('getUnclaimedRewards()', function () {
        it('returns total as string', async function () {
            hub.db.doQuery.resolves([{ total: 25.5 }]);
            let result = await rt.getUnclaimedRewards('pk1');
            expect(result).to.equal('25.5');
        });

        it('returns 0 when no rows', async function () {
            hub.db.doQuery.resolves([]);
            let result = await rt.getUnclaimedRewards('pk1');
            expect(result).to.equal('0');
        });
    });

    // -----------------------------------------------------------------
    // getRewardHistory()
    // -----------------------------------------------------------------

    describe('getRewardHistory()', function () {
        it('passes pubkey and limit', async function () {
            hub.db.doQuery.resolves([]);
            await rt.getRewardHistory('pk1', 10);
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[1]).to.deep.equal(['pk1', 10]);
        });

        it('defaults limit to 50', async function () {
            hub.db.doQuery.resolves([]);
            await rt.getRewardHistory('pk1');
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[1][1]).to.equal(50);
        });
    });

    // -----------------------------------------------------------------
    // getTotalDistributed()
    // -----------------------------------------------------------------

    describe('getTotalDistributed()', function () {
        it('returns total as string', async function () {
            hub.db.doQuery.resolves([{ total: 1000 }]);
            let result = await rt.getTotalDistributed();
            expect(result).to.equal('1000');
        });

        it('returns 0 when no rows', async function () {
            hub.db.doQuery.resolves([]);
            let result = await rt.getTotalDistributed();
            expect(result).to.equal('0');
        });
    });
});
