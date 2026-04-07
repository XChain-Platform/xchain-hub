'use strict';

const sinon         = require('sinon');
const { expect }    = require('chai');
const RewardTracker = require('../../../src/RewardTracker');
const { createMockHub } = require('../../helpers/mockHub');

describe('Boundary: RewardTracker', function () {

    let hub, rt;

    beforeEach(function () {
        hub = createMockHub({ p2pConfig: { ORACLE_REWARD_PER_ROUND: '10.00000000' } });
        rt  = new RewardTracker(hub);
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // Division precision — equal-split with toFixed(8)
    // -----------------------------------------------------------------

    describe('distributeRewards() — per-validator precision', function () {

        function insertAmounts() {
            return hub.db.doQuery.getCalls()
                .filter(c => c.args[0].includes('validator_rewards'))
                .map(c => c.args[1][2]);
        }

        it('10 / 1 = 10.00000000 (exact, no rounding loss)', async function () {
            await rt.distributeRewards(1, ['pubkey-A']);

            let amounts = insertAmounts();
            expect(amounts).to.have.length(1);
            expect(amounts[0]).to.equal('10.00000000');
        });

        it('10 / 3 = 3.33333333 (truncated — total 9.99999999, 1 satoshi lost)', async function () {
            await rt.distributeRewards(1, ['pub-A', 'pub-B', 'pub-C']);

            let amounts = insertAmounts();
            expect(amounts).to.have.length(3);
            amounts.forEach(a => expect(a).to.equal('3.33333333'));

            // Verify total loss: 3 × 3.33333333 = 9.99999999, not 10
            let total = amounts.reduce((sum, a) => sum + parseFloat(a), 0);
            expect(total).to.be.closeTo(9.99999999, 1e-9);
        });

        it('10 / 7 → toFixed(8) output equals (10/7).toFixed(8)', async function () {
            let participants = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
            await rt.distributeRewards(1, participants);

            let expected = (10 / 7).toFixed(8);
            let amounts  = insertAmounts();
            expect(amounts).to.have.length(7);
            amounts.forEach(a => expect(a).to.equal(expected));
        });

        it('10 / 100 = 0.10000000 (exact)', async function () {
            let participants = Array.from({ length: 100 }, (_, i) => 'pub-' + i);
            await rt.distributeRewards(1, participants);

            let amounts = insertAmounts();
            expect(amounts).to.have.length(100);
            amounts.forEach(a => expect(a).to.equal('0.10000000'));
        });

        it('10 / 1000 = 0.01000000', async function () {
            let participants = Array.from({ length: 1000 }, (_, i) => 'pub-' + i);
            await rt.distributeRewards(1, participants);

            let amounts = insertAmounts();
            expect(amounts).to.have.length(1000);
            amounts.forEach(a => expect(a).to.equal('0.01000000'));
        });
    });

    // -----------------------------------------------------------------
    // Zero participants — early-return guard
    // -----------------------------------------------------------------

    describe('distributeRewards() — zero participants', function () {

        it('empty array → returns early, zero DB calls', async function () {
            await rt.distributeRewards(1, []);

            expect(hub.db.doQuery.callCount).to.equal(0);
        });

        it('null participants → returns early, zero DB calls', async function () {
            await rt.distributeRewards(1, null);

            expect(hub.db.doQuery.callCount).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Minimum satoshi reward amounts
    // -----------------------------------------------------------------

    describe('distributeRewards() — minimum rewardPerRound precision', function () {

        it('rewardPerRound = 0.00000001 / 1 → 0.00000001 (1 satoshi, exact)', async function () {
            hub = createMockHub({ p2pConfig: { ORACLE_REWARD_PER_ROUND: '0.00000001' } });
            rt  = new RewardTracker(hub);

            await rt.distributeRewards(1, ['pub-A']);

            let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('validator_rewards'));
            expect(calls).to.have.length(1);
            expect(calls[0].args[1][2]).to.equal('0.00000001');
        });

        it('rewardPerRound = 0.00000001 / 3 → toFixed(8) rounds to 0.00000000 (sub-satoshi lost)', async function () {
            hub = createMockHub({ p2pConfig: { ORACLE_REWARD_PER_ROUND: '0.00000001' } });
            rt  = new RewardTracker(hub);

            await rt.distributeRewards(1, ['pub-A', 'pub-B', 'pub-C']);

            let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('validator_rewards'));
            expect(calls).to.have.length(3);
            calls.forEach(c => expect(c.args[1][2]).to.equal('0.00000000'));
        });

        it('rewardPerRound = 0 → perValidator = 0.00000000 for every participant', async function () {
            hub = createMockHub({ p2pConfig: { ORACLE_REWARD_PER_ROUND: '0' } });
            rt  = new RewardTracker(hub);

            await rt.distributeRewards(1, ['pub-A', 'pub-B']);

            let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('validator_rewards'));
            expect(calls).to.have.length(2);
            calls.forEach(c => expect(c.args[1][2]).to.equal('0.00000000'));
        });
    });
});
