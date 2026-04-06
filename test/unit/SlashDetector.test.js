'use strict';

const sinon          = require('sinon');
const { expect }     = require('chai');
const SlashDetector  = require('../../src/SlashDetector');
const { createMockHub }     = require('../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions } = require('../helpers/fixtures');

describe('SlashDetector', function () {

    let hub, pm, sd;

    beforeEach(function () {
        hub = createMockHub({
            p2pConfig: {
                SLASH_DEVIATION_THRESHOLD:    '0.05',
                SLASH_MISSED_ROUNDS_THRESHOLD: '30'
            }
        });
        pm = hub._peerManager;
        // Map addrs → pubkeys so _resolveValidatorPubkey works
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
    // Configuration
    // -----------------------------------------------------------------

    describe('configuration', function () {
        it('parses deviation threshold from config', function () {
            expect(sd.deviationThreshold).to.equal(0.05);
        });

        it('parses missed rounds threshold from config', function () {
            expect(sd.missedRoundsThreshold).to.equal(30);
        });

        it('uses defaults when config is empty', function () {
            let sd2 = new SlashDetector(createMockHub({ p2pConfig: {} }));
            expect(sd2.deviationThreshold).to.equal(0.05);
            expect(sd2.missedRoundsThreshold).to.equal(30);
        });
    });

    // -----------------------------------------------------------------
    // Price deviation detection
    // -----------------------------------------------------------------

    describe('price deviation', function () {

        it('4% deviation does NOT trigger slash', async function () {
            let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
            let subs = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '104000' }] // 4% deviation
            }]);

            await sd._checkDeviations(1, subs, finalizedPrices);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('6% deviation DOES trigger slash', async function () {
            let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
            let subs = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '106000' }] // 6% deviation
            }]);

            await sd._checkDeviations(1, subs, finalizedPrices);
            expect(hub.db.doQuery.called).to.be.true;
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[0]).to.include('slash_proposals');
            expect(args[1][1]).to.equal('price_deviation');
        });

        it('exactly 5% deviation does NOT trigger slash (threshold is strictly greater)', async function () {
            let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
            let subs = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '105000' }] // exactly 5%
            }]);

            await sd._checkDeviations(1, subs, finalizedPrices);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('negative deviation (lower price) is detected', async function () {
            let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
            let subs = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [{ coinPair: 'BTC/USD', price: '93000' }] // -7% deviation
            }]);

            await sd._checkDeviations(1, subs, finalizedPrices);
            expect(hub.db.doQuery.called).to.be.true;
        });

        it('skips validators without resolved pubkey', async function () {
            pm.validatorPubkeys = new Map(); // Empty — no pubkeys can resolve
            let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
            let subs = buildSubmissions([{
                sender: 'unknown-addr',
                prices: [{ coinPair: 'BTC/USD', price: '200000' }]
            }]);

            await sd._checkDeviations(1, subs, finalizedPrices);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('handles null/empty submissions gracefully', async function () {
            await sd._checkDeviations(1, null, [{ coinPair: 'BTC/USD', price: '100000' }]);
            await sd._checkDeviations(1, new Map(), null);
            expect(hub.db.doQuery.called).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // Repeated deviation (3+ in 24h)
    // -----------------------------------------------------------------

    describe('repeated deviation', function () {

        it('3 deviations in 24h triggers repeated_deviation proposal', async function () {
            // Manually track 2 previous deviations
            sd.recentDeviations.set(VALIDATORS_3[0].pubkey, [
                { round: 1, timestamp: Date.now() - 1000 },
                { round: 2, timestamp: Date.now() - 500 }
            ]);

            // Third deviation via _trackDeviation
            sd._trackDeviation(VALIDATORS_3[0].pubkey, 3);

            // Should have recorded a repeated_deviation proposal
            expect(hub.db.doQuery.called).to.be.true;
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[1][1]).to.equal('repeated_deviation');
        });

        it('2 deviations in 24h does NOT trigger repeated_deviation', function () {
            sd.recentDeviations.set(VALIDATORS_3[0].pubkey, [
                { round: 1, timestamp: Date.now() - 1000 }
            ]);

            sd._trackDeviation(VALIDATORS_3[0].pubkey, 2);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('old deviations (>24h) are pruned before check', function () {
            let over24h = Date.now() - (25 * 60 * 60 * 1000);
            sd.recentDeviations.set(VALIDATORS_3[0].pubkey, [
                { round: 1, timestamp: over24h },
                { round: 2, timestamp: over24h }
            ]);

            sd._trackDeviation(VALIDATORS_3[0].pubkey, 3);
            // After pruning, only 1 deviation (the new one) → no proposal
            expect(sd.recentDeviations.get(VALIDATORS_3[0].pubkey).length).to.equal(1);
            expect(hub.db.doQuery.called).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // Non-participation detection
    // -----------------------------------------------------------------

    describe('non-participation', function () {

        it('29 consecutive misses does NOT trigger slash', async function () {
            sd.missedRounds.set(VALIDATORS_3[0].pubkey, 28);

            await sd._checkParticipation(29, [], VALIDATORS_3);
            expect(sd.missedRounds.get(VALIDATORS_3[0].pubkey)).to.equal(29);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('30 consecutive misses triggers non_participation slash', async function () {
            sd.missedRounds.set(VALIDATORS_3[0].pubkey, 29);

            await sd._checkParticipation(30, [], VALIDATORS_3);
            expect(sd.missedRounds.get(VALIDATORS_3[0].pubkey)).to.equal(30);
            expect(hub.db.doQuery.called).to.be.true;
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[1][1]).to.equal('non_participation');
        });

        it('participation resets the missed counter to 0', async function () {
            sd.missedRounds.set(VALIDATORS_3[0].pubkey, 25);

            // Validator 0 participates
            await sd._checkParticipation(26, [VALIDATORS_3[0].pubkey], VALIDATORS_3);
            expect(sd.missedRounds.get(VALIDATORS_3[0].pubkey)).to.equal(0);
        });

        it('31st miss does NOT trigger again (only on exact threshold)', async function () {
            sd.missedRounds.set(VALIDATORS_3[0].pubkey, 30);
            hub.db.doQuery.resetHistory();

            await sd._checkParticipation(31, [], VALIDATORS_3);
            expect(sd.missedRounds.get(VALIDATORS_3[0].pubkey)).to.equal(31);
            // 31 !== 30, so no new proposal
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('handles empty allValidators gracefully', async function () {
            await sd._checkParticipation(1, [], []);
            expect(hub.db.doQuery.called).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // _resolveValidatorPubkey()
    // -----------------------------------------------------------------

    describe('_resolveValidatorPubkey()', function () {
        it('resolves a known addr to its pubkey', function () {
            expect(sd._resolveValidatorPubkey(VALIDATORS_3[0].addr)).to.equal(VALIDATORS_3[0].pubkey);
        });

        it('returns null for unknown addr', function () {
            expect(sd._resolveValidatorPubkey('ws://unknown:10001')).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // DB query methods
    // -----------------------------------------------------------------

    describe('getPendingProposals()', function () {
        it('queries slash_proposals with pending status', async function () {
            hub.db.doQuery.resolves([{ id: 1 }]);
            let result = await sd.getPendingProposals();
            expect(hub.db.doQuery.calledOnce).to.be.true;
            expect(hub.db.doQuery.getCall(0).args[0]).to.include("status = 'pending'");
        });
    });

    describe('getProposalsForValidator()', function () {
        it('queries by validator pubkey', async function () {
            await sd.getProposalsForValidator('abc123');
            expect(hub.db.doQuery.getCall(0).args[1]).to.deep.equal(['abc123']);
        });
    });
});
