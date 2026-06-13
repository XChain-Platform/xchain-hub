'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

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

        it('skips submissions with no prices array, unknown coin pairs, and non-numeric prices', async function () {
            let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
            let subs = new Map([
                [VALIDATORS_3[0].addr, { prices: null }],                                  // no prices array
                [VALIDATORS_3[1].addr, { prices: [{ coinPair: 'ETH/USD', price: '5000' }] }], // coin pair not finalized
                [VALIDATORS_3[2].addr, { prices: [{ coinPair: 'BTC/USD', price: 'abc' }] }]   // non-numeric price
            ]);
            await sd._checkDeviations(1, subs, finalizedPrices);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('aggregates multiple deviating pairs into ONE proposal per validator per round (F12)', async function () {
            let finalizedPrices = [
                { coinPair: 'BTC/USD',    price: '100000' },
                { coinPair: 'LTC/USD',    price: '100' },
                { coinPair: 'DOGE/USD',   price: '0.2' }
            ];
            let subs = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [
                    { coinPair: 'BTC/USD',  price: '110000' }, // 10%
                    { coinPair: 'LTC/USD',  price: '110' },    // 10%
                    { coinPair: 'DOGE/USD', price: '0.22' }    // 10%
                ]
            }]);

            await sd._checkDeviations(7, subs, finalizedPrices);

            // Exactly one slash_proposals INSERT for the round
            expect(hub.db.doQuery.callCount).to.equal(1);
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[1][1]).to.equal('price_deviation');
            expect(args[1][2]).to.equal(7);
            let evidence = JSON.parse(args[1][3]);
            expect(evidence.pairCount).to.equal(3);
            expect(evidence.pairs.map(p => p.coinPair)).to.deep.equal(['BTC/USD', 'LTC/USD', 'DOGE/USD']);
        });

        it('tracks ONE deviation entry per round regardless of deviating pair count (F12)', async function () {
            let finalizedPrices = [
                { coinPair: 'BTC/USD', price: '100000' },
                { coinPair: 'LTC/USD', price: '100' }
            ];
            let subs = buildSubmissions([{
                sender: VALIDATORS_3[0].addr,
                prices: [
                    { coinPair: 'BTC/USD', price: '110000' },
                    { coinPair: 'LTC/USD', price: '110' }
                ]
            }]);

            await sd._checkDeviations(7, subs, finalizedPrices);
            expect(sd.recentDeviations.get(VALIDATORS_3[0].pubkey).length).to.equal(1);
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

        it('does NOT re-fire while the 24h window stays saturated (F12 latch)', function () {
            sd.recentDeviations.set(VALIDATORS_3[0].pubkey, [
                { round: 1, timestamp: Date.now() - 1000 },
                { round: 2, timestamp: Date.now() - 500 }
            ]);

            sd._trackDeviation(VALIDATORS_3[0].pubkey, 3); // crossing → fires
            expect(hub.db.doQuery.callCount).to.equal(1);

            sd._trackDeviation(VALIDATORS_3[0].pubkey, 4); // still ≥3 → latched, no re-fire
            sd._trackDeviation(VALIDATORS_3[0].pubkey, 5);
            expect(hub.db.doQuery.callCount).to.equal(1);
        });

        it('re-arms after pruning drops the window below 3 (F12 latch)', function () {
            sd.recentDeviations.set(VALIDATORS_3[0].pubkey, [
                { round: 1, timestamp: Date.now() - 1000 },
                { round: 2, timestamp: Date.now() - 500 }
            ]);
            sd._trackDeviation(VALIDATORS_3[0].pubkey, 3); // fires, latch set
            expect(hub.db.doQuery.callCount).to.equal(1);

            // Window ages out — replace with stale entries, next track prunes to 1
            let over24h = Date.now() - (25 * 60 * 60 * 1000);
            sd.recentDeviations.set(VALIDATORS_3[0].pubkey, [
                { round: 3, timestamp: over24h },
                { round: 4, timestamp: over24h }
            ]);
            sd._trackDeviation(VALIDATORS_3[0].pubkey, 10); // count 1 → latch re-arms
            expect(hub.db.doQuery.callCount).to.equal(1);

            sd.recentDeviations.get(VALIDATORS_3[0].pubkey).push(
                { round: 11, timestamp: Date.now() }
            );
            sd._trackDeviation(VALIDATORS_3[0].pubkey, 12); // count 3 again → fires again
            expect(hub.db.doQuery.callCount).to.equal(2);
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

        it('returns null when there is no peer manager', function () {
            hub.getPeerManager.returns(null);
            expect(sd._resolveValidatorPubkey('x')).to.be.null;
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

    // -----------------------------------------------------------------
    // checkRound() orchestration
    // -----------------------------------------------------------------

    describe('checkRound()', function () {
        it('runs both the deviation and participation checks', async function () {
            let dev  = sinon.stub(sd, '_checkDeviations').resolves();
            let part = sinon.stub(sd, '_checkParticipation').resolves();
            await sd.checkRound(5, new Map(), [], [], VALIDATORS_3);
            expect(dev.calledOnce).to.be.true;
            expect(part.calledOnce).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // Deviation memory bound
    // -----------------------------------------------------------------

    describe('deviation memory bound', function () {
        it('caps tracked deviations at the per-validator maximum', function () {
            let now = Date.now();
            let arr = [];
            for (let i = 0; i < 1000; i++) arr.push({ round: i, timestamp: now - 1 });
            sd.recentDeviations.set(VALIDATORS_3[0].pubkey, arr);
            // One more pushes to 1001 → sliced back to the 1000 most recent.
            sd._trackDeviation(VALIDATORS_3[0].pubkey, 1001);
            expect(sd.recentDeviations.get(VALIDATORS_3[0].pubkey).length).to.equal(1000);
        });
    });

    // -----------------------------------------------------------------
    // _recordSlashProposal() pubkey validation
    // -----------------------------------------------------------------

    describe('_recordSlashProposal()', function () {
        it('skips a slash proposal when the pubkey is malformed', async function () {
            await sd._recordSlashProposal('not-a-valid-pubkey', 'price_deviation', 1, '{}');
            expect(hub.db.doQuery.called).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // recordAttestationDivergence()
    // -----------------------------------------------------------------

    describe('recordAttestationDivergence()', function () {
        it('returns without recording when validatorPubkey or requestId is missing', async function () {
            await sd.recordAttestationDivergence(null, 'req');
            await sd.recordAttestationDivergence('pk', null);
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('skips an invalidly-formatted pubkey', async function () {
            await sd.recordAttestationDivergence('xyz', 'deadbeef', 'http_get', 'h1', 'h2');
            expect(hub.db.doQuery.called).to.be.false;
        });

        it('records an attestation_divergence proposal with evidence + pseudo-round', async function () {
            let pk = VALIDATORS_3[0].pubkey;
            await sd.recordAttestationDivergence(pk.toUpperCase(), 'deadbeefcafe', 'http_get', 'hashA', 'hashB');

            expect(hub.db.doQuery.calledOnce).to.be.true;
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[0]).to.include('slash_proposals');
            expect(args[1][0]).to.equal(pk.toLowerCase());            // pubkey lowercased
            expect(args[1][1]).to.equal('attestation_divergence');
            expect(args[1][2]).to.equal(parseInt('deadbeef', 16));    // pseudo-round from first 8 hex
            let ev = JSON.parse(args[1][3]);
            expect(ev.requestId).to.equal('deadbeefcafe');
            expect(ev.providerId).to.equal('http_get');
            expect(ev.proposedBodyHash).to.equal('hashA');
            expect(ev.winnerBodyHash).to.equal('hashB');
        });

        it('defaults optional evidence fields and a non-hex requestId pseudo-round', async function () {
            let pk = VALIDATORS_3[0].pubkey;
            await sd.recordAttestationDivergence(pk, 'zzzzzzzz'); // providerId + hashes omitted
            let args = hub.db.doQuery.getCall(0).args;
            expect(args[1][2]).to.equal(0); // parseInt('zzzzzzzz', 16) → NaN → 0
            let ev = JSON.parse(args[1][3]);
            expect(ev.providerId).to.equal('');
            expect(ev.proposedBodyHash).to.equal('');
            expect(ev.winnerBodyHash).to.equal('');
        });
    });
});
