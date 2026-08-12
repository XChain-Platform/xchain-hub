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

const sinon          = require('sinon');
const { expect }     = require('chai');
const RewardTracker  = require('../../src/RewardTracker');
const SlashDetector  = require('../../src/SlashDetector');
const { createMockHub }     = require('../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions } = require('../helpers/fixtures');

// Helper: generate valid 64-hex-char pubkeys
function hexPk(n) { return n.toString(16).padStart(64, '0'); }

describe('Regression: Incentives & Slashing', function () {

    // =================================================================
    // RewardTracker
    // =================================================================

    describe('RewardTracker', function () {

        let hub, rt;

        beforeEach(function () {
            hub = createMockHub({ p2pConfig: { ORACLE_REWARD_PER_ROUND: '10.00000000' } });
            rt = new RewardTracker(hub);
        });

        afterEach(function () { sinon.restore(); });

        // REG-INC-001
        describe('REG-INC-001: Equal split among participants', function () {
            it('10 / 5 = 2.00000000 each @regression-p1', async function () {
                let participants = [hexPk(1), hexPk(2), hexPk(3), hexPk(4), hexPk(5)];
                await rt.distributeRewards(1, participants);

                expect(hub.db.doQuery.callCount).to.equal(5);
                for (let i = 0; i < 5; i++) {
                    let args = hub.db.doQuery.getCall(i).args;
                    expect(args[1][2]).to.equal('2.00000000');
                }
            });

            it('single participant gets full reward @regression-p1', async function () {
                await rt.distributeRewards(1, [hexPk(1)]);
                let args = hub.db.doQuery.getCall(0).args;
                expect(args[1][2]).to.equal('10.00000000');
            });

            it('odd division: 10 / 3 = 3.33333333 @regression-p1', async function () {
                await rt.distributeRewards(1, [hexPk(1), hexPk(2), hexPk(3)]);
                let args = hub.db.doQuery.getCall(0).args;
                expect(args[1][2]).to.equal('3.33333333');
            });

            it('zero participants: no DB calls @regression-p1', async function () {
                await rt.distributeRewards(1, []);
                expect(hub.db.doQuery.called).to.be.false;
            });

            it('null participants: no DB calls @regression-p1', async function () {
                await rt.distributeRewards(1, null);
                expect(hub.db.doQuery.called).to.be.false;
            });
        });

        // REG-INC-002
        describe('REG-INC-002: Rewards stored with claim tracking', function () {
            it('getUnclaimedRewards returns total as string @regression-p2', async function () {
                hub.db.doQuery.resolves([{ total: 25.5 }]);
                let result = await rt.getUnclaimedRewards('pk1');
                expect(result).to.equal('25.5');
            });

            it('returns 0 when no rewards @regression-p2', async function () {
                hub.db.doQuery.resolves([]);
                let result = await rt.getUnclaimedRewards('pk1');
                expect(result).to.equal('0');
            });

            it('getTotalDistributed returns total @regression-p2', async function () {
                hub.db.doQuery.resolves([{ total: 1000 }]);
                let result = await rt.getTotalDistributed();
                expect(result).to.equal('1000');
            });
        });

        // Configuration
        describe('Configuration defaults', function () {
            it('uses configured reward per round @regression-p2', function () {
                expect(rt.rewardPerRound).to.equal('10.00000000');
            });

            it('defaults to 10.00000000 @regression-p2', function () {
                let rt2 = new RewardTracker(createMockHub({ p2pConfig: {} }));
                expect(rt2.rewardPerRound).to.equal('10.00000000');
            });
        });

        // Resilience
        describe('Resilience', function () {
            it('continues if one INSERT fails @regression-p2', async function () {
                hub.db.doQuery.onFirstCall().rejects(new Error('dup'));
                hub.db.doQuery.onSecondCall().resolves();

                await rt.distributeRewards(1, [hexPk(1), hexPk(2)]);
                expect(hub.db.doQuery.callCount).to.equal(2);
            });
        });
    });

    // =================================================================
    // SlashDetector
    // =================================================================

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
            pm.validatorPubkeys = new Map([
                [VALIDATORS_3[0].addr, VALIDATORS_3[0].pubkey],
                [VALIDATORS_3[1].addr, VALIDATORS_3[1].pubkey],
                [VALIDATORS_3[2].addr, VALIDATORS_3[2].pubkey]
            ]);
            sd = new SlashDetector(hub);
        });

        afterEach(function () { sinon.restore(); });

        // REG-INC-003
        describe('REG-INC-003: Price deviation >5% triggers slash', function () {
            it('4% deviation does NOT trigger @regression-p1', async function () {
                let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
                let subs = buildSubmissions([{
                    sender: VALIDATORS_3[0].addr,
                    prices: [{ coinPair: 'BTC/USD', price: '104000' }]
                }]);

                await sd._checkDeviations(1, subs, finalizedPrices);
                expect(hub.db.doQuery.called).to.be.false;
            });

            it('6% deviation DOES trigger @regression-p1', async function () {
                let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
                let subs = buildSubmissions([{
                    sender: VALIDATORS_3[0].addr,
                    prices: [{ coinPair: 'BTC/USD', price: '106000' }]
                }]);

                await sd._checkDeviations(1, subs, finalizedPrices);
                expect(hub.db.doQuery.called).to.be.true;
                let args = hub.db.doQuery.getCall(0).args;
                expect(args[1][1]).to.equal('price_deviation');
            });

            it('exactly 5% does NOT trigger (strictly greater) @regression-p1', async function () {
                let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
                let subs = buildSubmissions([{
                    sender: VALIDATORS_3[0].addr,
                    prices: [{ coinPair: 'BTC/USD', price: '105000' }]
                }]);

                await sd._checkDeviations(1, subs, finalizedPrices);
                expect(hub.db.doQuery.called).to.be.false;
            });

            it('negative deviation (-7%) detected @regression-p1', async function () {
                let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
                let subs = buildSubmissions([{
                    sender: VALIDATORS_3[0].addr,
                    prices: [{ coinPair: 'BTC/USD', price: '93000' }]
                }]);

                await sd._checkDeviations(1, subs, finalizedPrices);
                expect(hub.db.doQuery.called).to.be.true;
            });
        });

        // REG-INC-004
        describe('REG-INC-004: 3+ deviations in 24h triggers repeated_deviation', function () {
            it('3 deviations triggers proposal @regression-p1', function () {
                sd.recentDeviations.set(VALIDATORS_3[0].pubkey, [
                    { round: 1, timestamp: Date.now() - 1000 },
                    { round: 2, timestamp: Date.now() - 500 }
                ]);

                sd._trackDeviation(VALIDATORS_3[0].pubkey, 3);

                expect(hub.db.doQuery.called).to.be.true;
                let args = hub.db.doQuery.getCall(0).args;
                expect(args[1][1]).to.equal('repeated_deviation');
            });

            it('2 deviations does NOT trigger @regression-p1', function () {
                sd.recentDeviations.set(VALIDATORS_3[0].pubkey, [
                    { round: 1, timestamp: Date.now() - 1000 }
                ]);

                sd._trackDeviation(VALIDATORS_3[0].pubkey, 2);
                expect(hub.db.doQuery.called).to.be.false;
            });

            it('old deviations (>24h) pruned before check @regression-p1', function () {
                let over24h = Date.now() - (25 * 60 * 60 * 1000);
                sd.recentDeviations.set(VALIDATORS_3[0].pubkey, [
                    { round: 1, timestamp: over24h },
                    { round: 2, timestamp: over24h }
                ]);

                sd._trackDeviation(VALIDATORS_3[0].pubkey, 3);
                expect(sd.recentDeviations.get(VALIDATORS_3[0].pubkey).length).to.equal(1);
                expect(hub.db.doQuery.called).to.be.false;
            });
        });

        // REG-INC-005: windowed rate, not a consecutive counter
        describe('REG-INC-005: 30+ missed rounds in the sliding window triggers non_participation', function () {

            // Seed the sliding window with `misses` missed rounds (newest last).
            function seedMisses(pubkey, misses) {
                sd.participation.set(pubkey, {
                    history: new Array(misses).fill(true),
                    missed:  misses
                });
            }

            it('29 misses does NOT trigger @regression-p1', async function () {
                seedMisses(VALIDATORS_3[0].pubkey, 28);

                await sd._checkParticipation(29, [], VALIDATORS_3);
                expect(sd.participation.get(VALIDATORS_3[0].pubkey).missed).to.equal(29);
                expect(hub.db.doQuery.called).to.be.false;
            });

            it('30 misses triggers non_participation slash @regression-p1', async function () {
                seedMisses(VALIDATORS_3[0].pubkey, 29);

                await sd._checkParticipation(30, [], VALIDATORS_3);
                expect(hub.db.doQuery.called).to.be.true;
                let args = hub.db.doQuery.getCall(0).args;
                expect(args[1][1]).to.equal('non_participation');
            });

            it('a single participation does NOT reset the window (S-F4) @regression-p1', async function () {
                // 29 misses + 1 participation + 1 more miss = 30 misses in the
                // window → fires. The old consecutive counter reset to 0 here.
                seedMisses(VALIDATORS_3[0].pubkey, 29);

                await sd._checkParticipation(30, [VALIDATORS_3[0].pubkey], VALIDATORS_3);
                expect(hub.db.doQuery.called).to.be.false;
                await sd._checkParticipation(31, [], VALIDATORS_3);
                expect(hub.db.doQuery.called).to.be.true;
                expect(hub.db.doQuery.getCall(0).args[1][1]).to.equal('non_participation');
            });

            it('31st miss does NOT trigger again while the latch is set @regression-p1', async function () {
                // The trigger is `>=` threshold plus a per-validator latch (set
                // once the 30th-miss proposal row persists), not an exact-count
                // match: an exact `===` could never retry a DB write that
                // failed at the threshold. One proposal per offense still holds.
                seedMisses(VALIDATORS_3[0].pubkey, 30);
                sd.nonParticipationFired.set(VALIDATORS_3[0].pubkey, true);
                hub.db.doQuery.resetHistory();

                await sd._checkParticipation(31, [], VALIDATORS_3);
                expect(hub.db.doQuery.called).to.be.false;
            });

            it('a failed proposal write at the threshold re-arms and retries next round @regression-p1', async function () {
                seedMisses(VALIDATORS_3[0].pubkey, 29);
                hub.db.doQuery.rejects(new Error('db down'));

                await sd._checkParticipation(30, [], VALIDATORS_3);
                expect(sd.nonParticipationFired.get(VALIDATORS_3[0].pubkey),
                    'latch re-armed after failed write').to.be.false;

                hub.db.doQuery.resetBehavior();
                hub.db.doQuery.resolves([]);
                hub.db.doQuery.resetHistory();
                await sd._checkParticipation(31, [], VALIDATORS_3);
                expect(hub.db.doQuery.called, 'retried past the threshold').to.be.true;
            });
        });

        // Null safety
        describe('Null safety', function () {
            it('handles null submissions gracefully @regression-p2', async function () {
                await sd._checkDeviations(1, null, [{ coinPair: 'BTC/USD', price: '100000' }]);
                expect(hub.db.doQuery.called).to.be.false;
            });

            it('handles empty validators gracefully @regression-p2', async function () {
                await sd._checkParticipation(1, [], []);
                expect(hub.db.doQuery.called).to.be.false;
            });

            it('skips validators without resolved pubkey @regression-p2', async function () {
                pm.validatorPubkeys = new Map();
                let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
                let subs = buildSubmissions([{
                    sender: 'unknown-addr',
                    prices: [{ coinPair: 'BTC/USD', price: '200000' }]
                }]);

                await sd._checkDeviations(1, subs, finalizedPrices);
                expect(hub.db.doQuery.called).to.be.false;
            });
        });

        // Configuration
        describe('Configuration defaults', function () {
            it('parses thresholds from config @regression-p2', function () {
                expect(sd.deviationThreshold).to.equal(0.05);
                expect(sd.missedRoundsThreshold).to.equal(30);
            });

            it('uses defaults when config is empty @regression-p2', function () {
                let sd2 = new SlashDetector(createMockHub({ p2pConfig: {} }));
                expect(sd2.deviationThreshold).to.equal(0.05);
                expect(sd2.missedRoundsThreshold).to.equal(30);
            });
        });

        // Resolver
        describe('_resolveValidatorPubkey', function () {
            it('resolves known addr @regression-p2', function () {
                expect(sd._resolveValidatorPubkey(VALIDATORS_3[0].addr)).to.equal(VALIDATORS_3[0].pubkey);
            });

            it('returns null for unknown addr @regression-p2', function () {
                expect(sd._resolveValidatorPubkey('ws://unknown:10001')).to.be.null;
            });
        });
    });
});
