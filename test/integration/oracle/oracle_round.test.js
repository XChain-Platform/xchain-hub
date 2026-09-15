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
const crypto         = require('crypto');
const testDb         = require('../../helpers/testDb');
const mockApi        = require('../../helpers/mockExternalApi');
const { buildEnvelope } = require('../../helpers/testPeerNetwork');
const { waitUntil }     = require('../../helpers/waitUntil');
const { VALIDATORS_1, VALIDATORS_4, SAMPLE_PRICES } = require('../../helpers/fixtures');
const OracleRound    = require('../../../src/oracle/round');
const OracleConsensus = require('../../../src/oracle/consensus');
const RewardTracker  = require('../../../src/anchor/reward_tracker');
const SlashDetector  = require('../../../src/validators/slash_detector');
const { createIntegrationHub: createTestHub, useSingleValidatorOracleEnv } = require('../../helpers/integrationHub');

describe('Integration: Oracle Round Lifecycle (SC-2.x)', function () {

    // Single/small-validator rounds only finalize with the regtest diversity floor.
    useSingleValidatorOracleEnv();

    before(async function () {
        try {
            await testDb.setup();
        } catch (e) {
            console.warn('MariaDB unavailable; skipping oracle round tests');
        }
        mockApi.setup();
    });

    after(async function () {
        mockApi.teardown();
        await testDb.teardown();
    });

    beforeEach(async function () {
        if (!testDb.isAvailable()) return this.skip();
        await testDb.truncateAll();
        mockApi.reset();
    });

    afterEach(function () { sinon.restore(); });

    describe('SC-2.1: Single-validator round', registerSingleValidatorRoundTests);
    describe('SC-2.2: Multi-validator PBFT consensus', registerMultiValidatorRoundTests);
    describe('SC-2.3: Price deviation slash', registerPriceDeviationTests);
    describe('SC-2.4: No price data', registerNoPriceDataTests);
    describe('SC-2.5: Reward distribution', registerRewardDistributionTests);
});

// SC-2.1: Single-validator round
function registerSingleValidatorRoundTests() {
        it('stores snapshot directly without consensus', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db, VALIDATORS_1[0].addr);
            hub._peerManager.validatorPubkeys.set(VALIDATORS_1[0].addr, VALIDATORS_1[0].pubkey);

            mockApi.mockCoinGeckoSuccess();

            let oracleRound = new OracleRound(hub);
            let oracleConsensus = new OracleConsensus(hub, oracleRound);
            oracleConsensus.setValidatorSet(VALIDATORS_1);
            oracleRound.setConsensus(oracleConsensus);

            // Execute round
            await oracleRound._executeRound();

            // The submission write is fire-and-forget: wait for the row, not a duration.
            await waitUntil(async () => {
                let rows = await db.doQuery('SELECT 1 FROM oracle_submissions WHERE round_number = ?',
                    [oracleRound.getCurrentRound()]);
                return rows.length > 0;
            }, { timeoutMs: 5000, label: 'the round submission row to land' });

            // Manually finalize (normally done by timer)
            await oracleConsensus.finalizeRound(oracleRound.getCurrentRound());

            // Verify price_snapshots
            let snapshots = await db.doQuery("SELECT * FROM price_snapshots WHERE status = 'finalized'");
            expect(snapshots.length).to.be.greaterThan(0);
            expect(snapshots[0].validator_count).to.equal(1);
            expect(snapshots[0].price).to.be.a('string');

            // Verify oracle_submissions
            let subs = await db.doQuery("SELECT * FROM oracle_submissions WHERE round_number = ?", [oracleRound.getCurrentRound()]);
            expect(subs.length).to.be.greaterThan(0);
        });
}

// SC-2.2: Multi-validator PBFT consensus
function registerMultiValidatorRoundTests() {
        it('finalizes round after PREPARE and COMMIT quorum', async function () {
            let db = testDb.getDb();
            let { hub, oracleRound, oracleConsensus } = createMultiValidatorRound(db);

            // Track finalization event
            let finalized = null;
            oracleConsensus.on('round:finalized', (event) => { finalized = event; });

            // Start consensus message handler
            await oracleConsensus.start();

            // Execute round (leader is validator at round % 4)
            await executeRoundAndWait(db, oracleRound);

            let round = oracleRound.getCurrentRound();
            rotateValidatorSet(oracleConsensus, round);
            submitValidatorPrices(hub, round);

            // Finalize the round
            await oracleConsensus.finalizeRound(round);
            await completePendingRound(db, hub, oracleConsensus, round);

            // Verify finalization
            let snapshots = await db.doQuery("SELECT * FROM price_snapshots WHERE status = 'finalized' AND round_number = ?", [round]);
            expect(snapshots.length).to.be.greaterThan(0);

            await oracleConsensus.stop();
        });
}

function createMultiValidatorRound(db) {
    let hub = createTestHub(db, VALIDATORS_4[0].addr);
    // Register validator pubkeys
    for (let v of VALIDATORS_4) hub._peerManager.validatorPubkeys.set(v.addr, v.pubkey);
    mockApi.mockCoinGeckoSuccess();
    let oracleRound = new OracleRound(hub);
    let oracleConsensus = new OracleConsensus(hub, oracleRound);
    oracleConsensus.setValidatorSet(VALIDATORS_4);
    oracleRound.setConsensus(oracleConsensus);
    return { hub, oracleRound, oracleConsensus };
}

async function executeRoundAndWait(db, oracleRound) {
    await oracleRound._executeRound();
    await waitUntil(async () => {
        let rows = await db.doQuery('SELECT 1 FROM oracle_submissions WHERE round_number = ?',
            [oracleRound.getCurrentRound()]);
        return rows.length > 0;
    }, { timeoutMs: 5000, label: 'the round submission row to land' });
}

function rotateValidatorSet(oracleConsensus, round) {
    // The oracle leader is set[round % N] and `round` is derived from the wall
    // clock, so which validator leads is effectively random per run: this test
    // only ever proposed (and only ever finalized) when the dice landed on
    // index 0. Rotate the set so THIS node occupies the elected slot for the
    // round we actually got. Membership is unchanged, only the ordering.
    let leaderIdx = round % VALIDATORS_4.length;
    let rotated   = VALIDATORS_4.slice();
    [rotated[0], rotated[leaderIdx]] = [rotated[leaderIdx], rotated[0]];
    oracleConsensus.setValidatorSet(rotated);
}

function submitValidatorPrices(hub, round) {
    // Simulate submissions from other validators
    for (let i = 1; i < VALIDATORS_4.length; i++) {
        hub._peerManager.emit('message', buildEnvelope('ORACLE_PRICE_SUBMIT', {
            round: round,
            prices: SAMPLE_PRICES,
            sources: 2
        }, VALIDATORS_4[i].addr));
    }
}

async function completePendingRound(db, hub, oracleConsensus, round) {
    // Leader should have proposed; get the digest
    let pending = oracleConsensus.pendingRounds.get(round);
    if (!pending) return;
    // Inject PREPARE from other validators
    for (let i = 1; i < 3; i++) {
        hub._peerManager.emit('message', buildEnvelope('ORACLE_PREPARE', {
            round: round, digest: pending.digest
        }, VALIDATORS_4[i].addr));
    }
    await waitUntil(() => pending.prepares.size >= 3, { label: 'the PREPARE quorum to be tallied' });
    // Inject COMMIT from other validators
    for (let i = 1; i < 3; i++) {
        hub._peerManager.emit('message', buildEnvelope('ORACLE_COMMIT', {
            round: round, digest: pending.digest
        }, VALIDATORS_4[i].addr));
    }
    await waitUntil(async () => {
        let rows = await db.doQuery(
            "SELECT 1 FROM price_snapshots WHERE status = 'finalized' AND round_number = ?", [round]);
        return rows.length > 0;
    }, { timeoutMs: 5000, label: 'the commit quorum to persist the finalized snapshot' });
}

// SC-2.3: Price deviation triggers slash proposal
function registerPriceDeviationTests() {
        it('records slash proposal when validator deviates > 5%', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db, VALIDATORS_1[0].addr);
            hub._peerManager.validatorPubkeys.set(VALIDATORS_1[0].addr, VALIDATORS_1[0].pubkey);
            hub._peerManager.validatorPubkeys.set('ws://deviant:10001', 'dd'.repeat(32));

            let slashDetector = new SlashDetector(hub);
            let finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000.00000000' }];

            // Build submissions: one normal, one deviant (10% higher)
            let submissions = new Map();
            submissions.set(VALIDATORS_1[0].addr, {
                prices: [{ coinPair: 'BTC/USD', price: '100000.00000000', sources: 1 }],
                sources: 1, timestamp: Date.now()
            });
            submissions.set('ws://deviant:10001', {
                prices: [{ coinPair: 'BTC/USD', price: '110000.00000000', sources: 1 }],
                sources: 1, timestamp: Date.now()
            });

            await slashDetector.checkRound(1, submissions, finalizedPrices,
                [VALIDATORS_1[0].pubkey], [VALIDATORS_1[0]]);

            await waitUntil(async () => {
                let rows = await db.doQuery("SELECT 1 FROM slash_proposals WHERE offense_type = 'price_deviation'");
                return rows.length > 0;
            }, { timeoutMs: 5000, label: 'the deviation slash proposal to be recorded' });

            let slashes = await db.doQuery("SELECT * FROM slash_proposals WHERE offense_type = 'price_deviation'");
            expect(slashes.length).to.be.greaterThan(0);
            expect(slashes[0].validator_pubkey).to.equal('dd'.repeat(32));
        });
}

// SC-2.4: No price data available
function registerNoPriceDataTests() {
        it('does not broadcast when both APIs fail', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db);

            mockApi.mockCoinGeckoError(500);

            let oracleRound = new OracleRound(hub);
            await oracleRound._executeRound();

            expect(hub._peerManager.broadcast.called).to.be.false;
        });
}

// SC-2.5: Reward distribution
function registerRewardDistributionTests() {
        it('distributes rewards to participants after finalization', async function () {
            let db = testDb.getDb();
            let hub = createTestHub(db, VALIDATORS_1[0].addr);
            hub._peerManager.validatorPubkeys.set(VALIDATORS_1[0].addr, VALIDATORS_1[0].pubkey);

            let rewardTracker = new RewardTracker(hub);

            // Distribute rewards for round 1 to a single validator
            await rewardTracker.distributeRewards(1, [VALIDATORS_1[0].pubkey]);

            let rewards = await db.doQuery("SELECT * FROM validator_rewards WHERE round_number = 1");
            expect(rewards).to.have.lengthOf(1);
            expect(rewards[0].validator_pubkey).to.equal(VALIDATORS_1[0].pubkey);
            expect(rewards[0].amount).to.equal('10.00000000');
            expect(rewards[0].reward_type).to.equal('oracle_round');

            // Verify unclaimed rewards
            let unclaimed = await rewardTracker.getUnclaimedRewards(VALIDATORS_1[0].pubkey);
            expect(parseFloat(unclaimed)).to.equal(10);
        });
}
