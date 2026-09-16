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
const SlashDetector  = require('../../../src/validators/slash_detector');
const { createMockHub }              = require('../../helpers/mockHub');
const { VALIDATORS_3, buildSubmissions } = require('../../helpers/fixtures');

let hub, pm, sd;
let finalizedPrices;
function slashCalls() {
    return hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
}
async function simulateMisses(count) {
    for (let i = 1; i <= count; i++) {
        await sd.checkParticipation(i, [], [VALIDATORS_3[0]]);
    }
}
function repeatedCalls() {
    return hub.db.doQuery.getCalls().filter(
        c => c.args[0].includes('slash_proposals') && c.args[1] && c.args[1][1] === 'repeated_deviation'
    );
}

describe('Boundary: SlashDetector', registerBoundarySlashDetector);

function registerBoundarySlashDetector() {
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
    // Deviation threshold: boundary is STRICT greater-than 0.05
    describe('checkDeviations(): deviation threshold boundary', registerCheckDeviationsDeviationThresholdBoundary);
    // Missed rounds: fires exactly once at count === 30 (EXACT equality)
    describe('checkParticipation(): missed rounds threshold boundary', registerCheckParticipationMissedRoundsThresholdBoundary);
    // Repeated deviation: 24h window, fires at length >= 3
    describe('trackDeviation(): repeated deviation 24h window boundary', registerTrackDeviationRepeatedDeviation24hWindowBoundary);
}

function registerCheckDeviationsDeviationThresholdBoundary() {
    beforeEach(function () {
        finalizedPrices = [{ coinPair: 'BTC/USD', price: '100000' }];
    });
    it('exactly 5% deviation (100000 → 105000) → NO slash', testExactly5Deviation100000105000NOSlash);
    it('5.01% deviation (100000 → 105010) → YES slash', test501Deviation100000105010YESSlash);
    it('4.99% deviation (100000 → 104990) → NO slash', test499Deviation100000104990NOSlash);
    it('exactly 5% negative deviation (100000 → 95000) → NO slash (Math.abs makes it 0.05)', testExactly5NegativeDeviation10000095000NOSlashMathAbsMakesIt);
    it('5.01% negative deviation (100000 → 94990) → YES slash', test501NegativeDeviation10000094990YESSlash);
    it('submitted price = 0 → skipped, NO slash', testSubmittedPrice0SkippedNOSlash);
    it('finalized price = 0 → skipped, NO slash', testFinalizedPrice0SkippedNOSlash);
    it('100% deviation (100000 → 200000) → YES slash (deviation = 1.0 > 0.05)', test100Deviation100000200000YESSlashDeviation10005);
}
async function testExactly5Deviation100000105000NOSlash() {
    let submissions = buildSubmissions([{
        sender: VALIDATORS_3[0].addr,
        prices: [{ coinPair: 'BTC/USD', price: '105000' }]
    }]);

    await sd.checkDeviations(1, submissions, finalizedPrices);

    let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
    expect(calls).to.have.length(0);
}
async function test501Deviation100000105010YESSlash() {
    let submissions = buildSubmissions([{
        sender: VALIDATORS_3[0].addr,
        prices: [{ coinPair: 'BTC/USD', price: '105010' }]
    }]);

    await sd.checkDeviations(1, submissions, finalizedPrices);

    let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
    expect(calls).to.have.length(1);
    expect(calls[0].args[1][1]).to.equal('price_deviation');
}
async function test499Deviation100000104990NOSlash() {
    let submissions = buildSubmissions([{
        sender: VALIDATORS_3[0].addr,
        prices: [{ coinPair: 'BTC/USD', price: '104990' }]
    }]);

    await sd.checkDeviations(1, submissions, finalizedPrices);

    let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
    expect(calls).to.have.length(0);
}
async function testExactly5NegativeDeviation10000095000NOSlashMathAbsMakesIt() {
    let submissions = buildSubmissions([{
        sender: VALIDATORS_3[0].addr,
        prices: [{ coinPair: 'BTC/USD', price: '95000' }]
    }]);

    await sd.checkDeviations(1, submissions, finalizedPrices);

    let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
    expect(calls).to.have.length(0);
}
async function test501NegativeDeviation10000094990YESSlash() {
    let submissions = buildSubmissions([{
        sender: VALIDATORS_3[0].addr,
        prices: [{ coinPair: 'BTC/USD', price: '94990' }]
    }]);

    await sd.checkDeviations(1, submissions, finalizedPrices);

    let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
    expect(calls).to.have.length(1);
    expect(calls[0].args[1][1]).to.equal('price_deviation');
}
async function testSubmittedPrice0SkippedNOSlash() {
    let submissions = buildSubmissions([{
        sender: VALIDATORS_3[0].addr,
        prices: [{ coinPair: 'BTC/USD', price: '0' }]
    }]);

    await sd.checkDeviations(1, submissions, finalizedPrices);

    let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
    expect(calls).to.have.length(0);
}
async function testFinalizedPrice0SkippedNOSlash() {
    let submissions = buildSubmissions([{
        sender: VALIDATORS_3[0].addr,
        prices: [{ coinPair: 'BTC/USD', price: '105010' }]
    }]);

    await sd.checkDeviations(1, submissions, [{ coinPair: 'BTC/USD', price: '0' }]);

    let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
    expect(calls).to.have.length(0);
}
async function test100Deviation100000200000YESSlashDeviation10005() {
    let submissions = buildSubmissions([{
        sender: VALIDATORS_3[0].addr,
        prices: [{ coinPair: 'BTC/USD', price: '200000' }]
    }]);

    await sd.checkDeviations(1, submissions, finalizedPrices);

    let calls = hub.db.doQuery.getCalls().filter(c => c.args[0].includes('slash_proposals'));
    expect(calls).to.have.length(1);
    expect(calls[0].args[1][1]).to.equal('price_deviation');
}

function registerCheckParticipationMissedRoundsThresholdBoundary() {
    it('29 consecutive misses → NO slash', test29ConsecutiveMissesNOSlash);
    it('exactly 30 misses → YES slash (fires once)', testExactly30MissesYESSlashFiresOnce);
    it('31st miss (counter already at 30) → NO additional slash (31 !== 30)', test31stMissCounterAlreadyAt30NOAdditionalSlash3130);
    it('recovery below the windowed threshold then re-accumulate to 30 → YES slash again', testRecoveryBelowTheWindowedThresholdThenReAccumulateTo30YESSlash);
    it('multiple validators: one participates, one misses (per-validator tracking)', testMultipleValidatorsOneParticipatesOneMissesPerValidatorTracking);
}
async function test29ConsecutiveMissesNOSlash() {
    await simulateMisses(29);
    expect(slashCalls()).to.have.length(0);
}
async function testExactly30MissesYESSlashFiresOnce() {
    await simulateMisses(30);
    let calls = slashCalls();
    expect(calls).to.have.length(1);
    expect(calls[0].args[1][1]).to.equal('non_participation');
}
async function test31stMissCounterAlreadyAt30NOAdditionalSlash3130() {
    await simulateMisses(31);
    // Still only 1 slash from the 30th miss; 31st does not fire
    expect(slashCalls()).to.have.length(1);
}
async function testRecoveryBelowTheWindowedThresholdThenReAccumulateTo30YESSlash() {
    await simulateMisses(30);
    expect(slashCalls()).to.have.length(1);

    // A single participation does NOT re-arm: the window is still
    // saturated with misses (the old consecutive counter reset here,
    // which let 1-in-30 participation evade forever, S-F4).
    await sd.checkParticipation(31, [VALIDATORS_3[0].pubkey], [VALIDATORS_3[0]]);
    await sd.checkParticipation(32, [], [VALIDATORS_3[0]]);
    expect(slashCalls()).to.have.length(1); // latched, no new slash

    // Sustained participation until the old misses age out of the
    // window (window = 60 rounds) re-arms the latch.
    for (let i = 33; i <= 92; i++) {
        await sd.checkParticipation(i, [VALIDATORS_3[0].pubkey], [VALIDATORS_3[0]]);
    }
    expect(sd.nonParticipationFired.get(VALIDATORS_3[0].pubkey)).to.equal(false);

    // A fresh 30-miss accumulation fires again.
    for (let i = 93; i <= 122; i++) {
        await sd.checkParticipation(i, [], [VALIDATORS_3[0]]);
    }
    expect(slashCalls()).to.have.length(2);
}
async function testMultipleValidatorsOneParticipatesOneMissesPerValidatorTracking() {
    let v0 = VALIDATORS_3[0];
    let v1 = VALIDATORS_3[1];
    let allValidators = [v0, v1];

    // v0 participates every round, v1 misses all 30
    for (let i = 1; i <= 30; i++) {
        await sd.checkParticipation(i, [v0.pubkey], allValidators);
    }

    let calls = slashCalls();
    expect(calls).to.have.length(1);
    expect(calls[0].args[1][0]).to.equal(v1.pubkey); // v1 slashed, not v0
}

function registerTrackDeviationRepeatedDeviation24hWindowBoundary() {
    it('2 deviations in 24h → NO repeated_deviation', test2DeviationsIn24hNORepeatedDeviation);
    it('2 deviations in 24h + 3rd arrives → YES repeated_deviation', test2DeviationsIn24h3rdArrivesYESRepeatedDeviation);
    it('3 deviations but 1st is older than 24h → pruned, only 2 remain → NO repeated_deviation', test3DeviationsBut1stIsOlderThan24hPrunedOnly2Remain);
    it('3rd deviation at exactly 24h boundary from 1st → 1st is pruned (filter uses > cutoff), 2 remain → NO repeated_deviation', test3rdDeviationAtExactly24hBoundaryFrom1st1stIsPrunedFilter);
}
function test2DeviationsIn24hNORepeatedDeviation() {
    let pubkey = VALIDATORS_3[0].pubkey;
    sd.trackDeviation(pubkey, 1);
    sd.trackDeviation(pubkey, 2);
    expect(repeatedCalls()).to.have.length(0);
}
function test2DeviationsIn24h3rdArrivesYESRepeatedDeviation() {
    let pubkey = VALIDATORS_3[0].pubkey;
    sd.trackDeviation(pubkey, 1);
    sd.trackDeviation(pubkey, 2);
    sd.trackDeviation(pubkey, 3);
    expect(repeatedCalls()).to.have.length(1);
}
function test3DeviationsBut1stIsOlderThan24hPrunedOnly2Remain() {
    let pubkey = VALIDATORS_3[0].pubkey;
    let now    = Date.now();

    // Manually insert 2 entries that are 25 hours old
    let old = now - (25 * 60 * 60 * 1000);
    sd.recentDeviations.set(pubkey, [
        { round: 1, timestamp: old },
        { round: 2, timestamp: old }
    ]);

    // 3rd deviation fires now; the two old entries are pruned, leaving only 1
    sd.trackDeviation(pubkey, 3);

    expect(repeatedCalls()).to.have.length(0);
    expect(sd.recentDeviations.get(pubkey)).to.have.length(1);
}
function test3rdDeviationAtExactly24hBoundaryFrom1st1stIsPrunedFilter() {
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

    sd.trackDeviation(pubkey, 3);

    // 1st entry (timestamp === cutoff) is NOT > cutoff, so it is pruned
    // Remaining: entry 2 + entry 3 = 2 → no repeated_deviation
    expect(repeatedCalls()).to.have.length(0);
    expect(sd.recentDeviations.get(pubkey)).to.have.length(2);
}
