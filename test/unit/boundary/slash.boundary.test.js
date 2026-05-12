'use strict';

const sinon          = require('sinon');
const { expect }     = require('chai');
const SlashDetector  = require('../../../src/SlashDetector');
const { createMockHub }              = require('../../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions } = require('../../helpers/fixtures');

describe('Boundary: SlashDetector', function () {

    let hub, pm, sd;

    beforeEach(function () {
        hub = createMockHub({ p2pConfig: { SLASH_DEVIATION_THRESHOLD: '0.05', SLASH_MISSED_ROUNDS_THRESHOLD: '30' } });
        pm  = hub._peerManager;
        pm.validatorPubkeys = new Map([
            [VALIDATORS_3[0].addr, VALIDATORS_3[0].pubkey],
            [VALIDATORS_3[1].addr, VALIDATORS_3[1].pubkey],
            [VALIDATORS_3[2].addr, VALIDATORS_3[2].pubkey]
        ]);
        sd = new SlashDetector(hub);
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // Deviation threshold — boundary is STRICT greater-than 0.05
    // -----------------------------------------------------------------

    describe('_checkDeviations() — deviation threshold boundary', function () {

        let finalizedPrices;

        beforeEach(function () {
            finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
        });

        it('exactly 5% deviation (100000 → 105000) → NO slash', async function () {
            let submissions = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '105000' }]
            }]);

            await sd._checkDeviations(1, submissions, finalizedPrices);

            let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
            expect(calls).to.have.length(0);
        });

        it('5.01% deviation (100000 → 105010) → YES slash', async function () {
            let submissions = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '105010' }]
            }]);

            await sd._checkDeviations(1, submissions, finalizedPrices);

            let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
            expect(calls).to.have.length(1);
            expect(calls[0].args[1][1]).to.equal('price_deviation');
        });

        it('4.99% deviation (100000 → 104990) → NO slash', async function () {
            let submissions = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '104990' }]
            }]);

            await sd._checkDeviations(1, submissions, finalizedPrices);

            let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
            expect(calls).to.have.length(0);
        });

        it('exactly 5% negative deviation (100000 → 95000) → NO slash (Math.abs makes it 0.05)', async function () {
            let submissions = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '95000' }]
            }]);

            await sd._checkDeviations(1, submissions, finalizedPrices);

            let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
            expect(calls).to.have.length(0);
        });

        it('5.01% negative deviation (100000 → 94990) → YES slash', async function () {
            let submissions = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '94990' }]
            }]);

            await sd._checkDeviations(1, submissions, finalizedPrices);

            let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
            expect(calls).to.have.length(1);
            expect(calls[0].args[1][1]).to.equal('price_deviation');
        });

        it('submitted price = 0 → skipped, NO slash', async function () {
            let submissions = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '0' }]
            }]);

            await sd._checkDeviations(1, submissions, finalizedPrices);

            let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
            expect(calls).to.have.length(0);
        });

        it('finalized price = 0 → skipped, NO slash', async function () {
            let submissions = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '105010' }]
            }]);

            await sd._checkDeviations(1, submissions, [{ coinPair: 'BTC/USD', price: '0' }]);

            let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
            expect(calls).to.have.length(0);
        });

        it('100% deviation (100000 → 200000) → YES slash (deviation = 1.0 > 0.05)', async function () {
            let submissions = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '200000' }]
            }]);

            await sd._checkDeviations(1, submissions, finalizedPrices);

            let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
            expect(calls).to.have.length(1);
            expect(calls[0].args[1][1]).to.equal('price_deviation');
        });
    });

    // -----------------------------------------------------------------
    // Missed rounds — fires exactly once at count === 30 (EXACT equality)
    // -----------------------------------------------------------------

    describe('_checkParticipation() — missed rounds threshold boundary', function () {

        function slashCalls() {
            return hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
        }

        async function simulateMisses(count) {
            for (let i = 1; i <= count; i++) {
                await sd._checkParticipation(i, [], [VALIDATORS_3[0]]);
            }
        }

        it('29 consecutive misses → NO slash', async function () {
            await simulateMisses(29);
            expect(slashCalls()).to.have.length(0);
        });

        it('exactly 30 misses → YES slash (fires once)', async function () {
            await simulateMisses(30);
            let calls = slashCalls();
            expect(calls).to.have.length(1);
            expect(calls[0].args[1][1]).to.equal('non_participation');
        });

        it('31st miss (counter already at 30) → NO additional slash (31 !== 30)', async function () {
            await simulateMisses(31);
            // Still only 1 slash from the 30th miss; 31st does not fire
            expect(slashCalls()).to.have.length(1);
        });

        it('reset after participation then re-accumulate to 30 → YES slash again', async function () {
            await simulateMisses(30);
            expect(slashCalls()).to.have.length(1);

            // Validator participates — resets counter to 0
            await sd._checkParticipation(31, [VALIDATORS_3[0].pubkey], [VALIDATORS_3[0]]);
            expect(slashCalls()).to.have.length(1); // no new slash

            // Miss another 30 rounds
            for (let i = 32; i <= 61; i++) {
                await sd._checkParticipation(i, [], [VALIDATORS_3[0]]);
            }

            expect(slashCalls()).to.have.length(2); // fired again at the 30th consecutive miss
        });

        it('multiple validators: one participates, one misses — per-validator tracking', async function () {
            let v0 = VALIDATORS_3[0];
            let v1 = VALIDATORS_3[1];
            let allValidators = [v0, v1];

            // v0 participates every round, v1 misses all 30
            for (let i = 1; i <= 30; i++) {
                await sd._checkParticipation(i, [v0.pubkey], allValidators);
            }

            let calls = slashCalls();
            expect(calls).to.have.length(1);
            expect(calls[0].args[1][0]).to.equal(v1.pubkey); // v1 slashed, not v0
        });
    });

    // -----------------------------------------------------------------
    // Repeated deviation — 24h window, fires at length >= 3
    // -----------------------------------------------------------------

    describe('_trackDeviation() — repeated deviation 24h window boundary', function () {

        function repeatedCalls() {
            return hub.db.doQuery.getCalls().filter(
                c => c.args[0].includes('slash_proposals') && c.args[1] && c.args[1][1] === 'repeated_deviation'
            );
        }

        it('2 deviations in 24h → NO repeated_deviation', function () {
            let pubkey = VALIDATORS_3[0].pubkey;
            sd._trackDeviation(pubkey, 1);
            sd._trackDeviation(pubkey, 2);
            expect(repeatedCalls()).to.have.length(0);
        });

        it('2 deviations in 24h + 3rd arrives → YES repeated_deviation', function () {
            let pubkey = VALIDATORS_3[0].pubkey;
            sd._trackDeviation(pubkey, 1);
            sd._trackDeviation(pubkey, 2);
            sd._trackDeviation(pubkey, 3);
            expect(repeatedCalls()).to.have.length(1);
        });

        it('3 deviations but 1st is older than 24h → pruned, only 2 remain → NO repeated_deviation', function () {
            let pubkey = VALIDATORS_3[0].pubkey;
            let now    = Date.now();

            // Manually insert 2 entries that are 25 hours old
            let old = now - (25 * 60 * 60 * 1000);
            sd.recentDeviations.set(pubkey, [
                { round: 1, timestamp: old },
                { round: 2, timestamp: old }
            ]);

            // 3rd deviation fires now — the two old entries are pruned, leaving only 1
            sd._trackDeviation(pubkey, 3);

            expect(repeatedCalls()).to.have.length(0);
            expect(sd.recentDeviations.get(pubkey)).to.have.length(1);
        });

        it('3rd deviation at exactly 24h boundary from 1st → 1st is pruned (filter uses > cutoff), 2 remain → NO repeated_deviation', function () {
            let pubkey = VALIDATORS_3[0].pubkey;
            let now    = Date.now();

            // 1st entry is exactly 24h old (timestamp === cutoff → NOT > cutoff → pruned)
            let exactlyAt = now - (24 * 60 * 60 * 1000);
            // 2nd entry is inside the window
            let recent = now - (60 * 1000);

            sd.recentDeviations.set(pubkey, [
                { round: 1, timestamp: exactlyAt },
                { round: 2, timestamp: recent }
            ]);

            // Stub Date.now to return `now` so the cutoff calculation is stable
            sinon.stub(Date, 'now').returns(now);

            sd._trackDeviation(pubkey, 3);

            // 1st entry (timestamp === cutoff) is NOT > cutoff, so it is pruned
            // Remaining: entry 2 + entry 3 = 2 → no repeated_deviation
            expect(repeatedCalls()).to.have.length(0);
            expect(sd.recentDeviations.get(pubkey)).to.have.length(2);
        });
    });
});
