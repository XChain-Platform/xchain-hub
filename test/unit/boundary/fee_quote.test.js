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

const sinon        = require('sinon');
const { expect }   = require('chai');
const proxyquire   = require('proxyquire');
const { DB_METHODS } = require('../../helpers/mockHub.js');

// Stub all dependencies to isolate XChainHub
let mockDb;
const XChainHub = proxyquire('../../../src/XChainHub', {
    './db':                 function () { return mockDb; },
    './peers/manager.js':     function () { return null; },
    './consensus/pbft.js':       function () {},
    './validators/identity.js': function () {},
    './oracle/consensus.js': function () {},
    './oracle/round.js':     function () {},
    './anchor/reward_tracker.js':   function () {},
    './validators/slash_detector.js':   function () {},
    './cross_chain/engine.js': function () {},
    './anchor/reorg_handler.js':    function () {},
    './cross_chain/swap_tracker.js':     function () {},
    './validators/governance.js':      function () {}
});

let hub;

describe('Boundary: Fee Quote Calculation', registerBoundaryFeeQuoteCalculation);

function registerBoundaryFeeQuoteCalculation() {
    beforeEach(function () {
        mockDb = {
            // The named query methods, so getPriceStatus's named read reaches the
            // doQuery stub below in the same call order the fixtures rely on.
            ...DB_METHODS,
            doQuery:        sinon.stub(),
            getConfig:      sinon.stub().resolves({}),
            setParam:       sinon.stub().resolves(),
            createDatabase: sinon.stub().resolves(),
            verifyTables:   sinon.stub().resolves(),
            close:          sinon.stub().resolves()
        };
        // Default: XCHAIN/USD = $1.00 (first doQuery call), no coin/USD (second call onward)
        mockDb.doQuery
            .onFirstCall().resolves([{ price: '1.00', status: 'finalized' }])
            .resolves([]);
        hub = new XChainHub('host', 3306, 'test_db', 'user', 'pass');
        hub.db = mockDb;
    });
    afterEach(function () {
        sinon.restore();
    });
    // Gas schedule boundaries
    describe('action lookup', registerActionLookup);
    // Gas price calculation precision
    describe('gas price calculation', registerGasPriceCalculation);
    // Oracle price integration
    describe('oracle price boundaries', registerOraclePriceBoundaries);
    // A quote is a promise about what the indexer will CHARGE. The indexer meters
    // every fee from its pinned per-chain bundle and deliberately keeps GAS_PRICE
    // and GAS_SCHEDULE out of its hub overlay (XChainIndexer._mergeHubParams: both
    // lists are empty on every network, because these values feed block-hashed
    // state and a live-polled consensus param forks the federation). A hub that
    // honoured a chain-row override would quote a fee no indexer accepts, and a
    // wallet trusting the quote would broadcast an underpaid action whose
    // native-coin fee output is not refundable.
    describe('config-row overrides do not move the quote off the pinned bundle', registerConfigRowOverridesDoNotMoveTheQuoteOffThePinnedBundle);
}

function registerActionLookup() {
    it('known action ISSUE returns gas cost 100000', testKnownActionISSUEReturnsGasCost100000);
    it('known action ISSUE_SUBTOKEN returns gas cost 50000', testKnownActionISSUESUBTOKENReturnsGasCost50000);
    it('unknown action returns error', testUnknownActionReturnsError);
    it('empty string action returns error', testEmptyStringActionReturnsError);
}
async function testKnownActionISSUEReturnsGasCost100000() {
    let result = await hub.getFeeQuote('ISSUE', 'BTC');
    expect(result.gasCost).to.equal(100000);
}
async function testKnownActionISSUESUBTOKENReturnsGasCost50000() {
    let result = await hub.getFeeQuote('ISSUE_SUBTOKEN', 'BTC');
    expect(result.gasCost).to.equal(50000);
}
async function testUnknownActionReturnsError() {
    let result = await hub.getFeeQuote('NONEXISTENT', 'BTC');
    expect(result.error).to.include('unknown action');
}
async function testEmptyStringActionReturnsError() {
    let result = await hub.getFeeQuote('', 'BTC');
    expect(result.error).to.include('unknown action');
}

function registerGasPriceCalculation() {
    it('ISSUE: 100000 * 0.00001 = 1.00000000 (exact)', testISSUE100000000001100000000Exact);
    it('ISSUE_SUBTOKEN: 50000 * 0.00001 = 0.50000000', testISSUESUBTOKEN50000000001050000000);
    it('EXPIRATION_PER_DAY: 550 * 0.00001 = 0.00550000', testEXPIRATIONPERDAY550000001000550000);
    it('gasPrice is formatted to 8 decimal places', testGasPriceIsFormattedTo8DecimalPlaces);
}
async function testISSUE100000000001100000000Exact() {
    let result = await hub.getFeeQuote('ISSUE', 'BTC');
    expect(result.xchainAmount).to.equal('1.00000000');
}
async function testISSUESUBTOKEN50000000001050000000() {
    let result = await hub.getFeeQuote('ISSUE_SUBTOKEN', 'BTC');
    expect(result.xchainAmount).to.equal('0.50000000');
}
async function testEXPIRATIONPERDAY550000001000550000() {
    let result = await hub.getFeeQuote('EXPIRATION_PER_DAY', 'BTC');
    expect(result.xchainAmount).to.equal('0.00550000');
}
async function testGasPriceIsFormattedTo8DecimalPlaces() {
    let result = await hub.getFeeQuote('ISSUE', 'BTC');
    expect(result.gasPrice).to.equal('0.00001000');
}

function registerOraclePriceBoundaries() {
    it('XCHAIN/USD unavailable → throws with descriptive error', testXCHAINUSDUnavailableThrowsWithDescriptiveError);
    it('XCHAIN/USD = 0 → throws (zero price guard)', testXCHAINUSD0ThrowsZeroPriceGuard);
    it('XCHAIN/USD available, no coin/USD → result includes xchainUsd but no nativeCoinAmount', testXCHAINUSDAvailableNoCoinUSDResultIncludesXchainUsdButNoNativeCoinAmount);
    it('coin price = 0 → nativeCoinAmount fields omitted (division guard)', testCoinPrice0NativeCoinAmountFieldsOmittedDivisionGuard);
    it('valid coin price → nativeCoinAmount computed', testValidCoinPriceNativeCoinAmountComputed);
    it('XCHAIN/USD = 1.00, coin price = 100000 → nativeCoinAmount = 0.00001000', testXCHAINUSD100CoinPrice100000NativeCoinAmount000001000);
    it('very small coin price → large nativeCoinAmount', testVerySmallCoinPriceLargeNativeCoinAmount);
    it('very large coin price → very small nativeCoinAmount', testVeryLargeCoinPriceVerySmallNativeCoinAmount);
}
async function testXCHAINUSDUnavailableThrowsWithDescriptiveError() {
    mockDb.doQuery.resetBehavior();
    mockDb.doQuery.resolves([]);
    let threw = false;
    try {
        await hub.getFeeQuote('ISSUE', 'BTC');
    } catch (e) {
        threw = true;
        expect(e.message).to.match(/XCHAIN\/USD oracle price unavailable/);
    }
    expect(threw, 'expected getFeeQuote to throw').to.equal(true);
}
async function testXCHAINUSD0ThrowsZeroPriceGuard() {
    mockDb.doQuery.resetBehavior();
    mockDb.doQuery
        .onFirstCall().resolves([{ price: '0', status: 'finalized' }])
        .resolves([]);
    let threw = false;
    try {
        await hub.getFeeQuote('ISSUE', 'BTC');
    } catch (e) {
        threw = true;
        expect(e.message).to.match(/zero or negative/);
    }
    expect(threw, 'expected getFeeQuote to throw').to.equal(true);
}
async function testXCHAINUSDAvailableNoCoinUSDResultIncludesXchainUsdButNoNativeCoinAmount() {
    // Default beforeEach: XCHAIN/USD = 1.00, coin/USD = null
    let result = await hub.getFeeQuote('ISSUE', 'BTC');
    expect(result.xchainUsd).to.equal('1.00000000');
    expect(result.nativeCoinAmount).to.be.undefined;
    expect(result.feeUsd).to.be.undefined;
}
async function testCoinPrice0NativeCoinAmountFieldsOmittedDivisionGuard() {
    mockDb.doQuery.resetBehavior();
    mockDb.doQuery
        .onFirstCall().resolves([{ price: '1.00', status: 'finalized' }])
        .onSecondCall().resolves([{ price: '0', status: 'finalized' }]);
    let result = await hub.getFeeQuote('ISSUE', 'BTC');
    expect(result.xchainUsd).to.equal('1.00000000');
    expect(result.nativeCoinAmount).to.be.undefined;
}
async function testValidCoinPriceNativeCoinAmountComputed() {
    // XCHAIN/USD = 2.00, BTC/USD = 100000
    // xchainAmount = 1.0, feeUsd = 2.0, nativeCoinAmount = 2.0 / 100000 = 0.00002
    mockDb.doQuery.resetBehavior();
    mockDb.doQuery
        .onFirstCall().resolves([{ price: '2.00', status: 'finalized' }])
        .onSecondCall().resolves([{ price: '100000', status: 'finalized' }]);
    let result = await hub.getFeeQuote('ISSUE', 'BTC');
    expect(result.nativeCoinAmount).to.equal('0.00002000');
    expect(result.xchainUsd).to.equal('2.00000000');
    expect(result.feeUsd).to.equal('2.00000000');
    expect(result.coinUsd).to.equal('100000.00000000');
}
async function testXCHAINUSD100CoinPrice100000NativeCoinAmount000001000() {
    // Regression: verifies the $1 oracle result matches the former hardcoded placeholder
    mockDb.doQuery.resetBehavior();
    mockDb.doQuery
        .onFirstCall().resolves([{ price: '1.00', status: 'finalized' }])
        .onSecondCall().resolves([{ price: '100000', status: 'finalized' }]);
    let result = await hub.getFeeQuote('ISSUE', 'BTC');
    expect(result.nativeCoinAmount).to.equal('0.00001000');
    expect(result.coinUsd).to.equal('100000.00000000');
}
async function testVerySmallCoinPriceLargeNativeCoinAmount() {
    mockDb.doQuery.resetBehavior();
    mockDb.doQuery
        .onFirstCall().resolves([{ price: '1.00', status: 'finalized' }])
        .onSecondCall().resolves([{ price: '0.00000001', status: 'finalized' }]);
    let result = await hub.getFeeQuote('ISSUE', 'BTC');
    // nativeCoinAmount = 1.0 / 0.00000001 = 100000000
    expect(result.nativeCoinAmount).to.equal('100000000.00000000');
}
async function testVeryLargeCoinPriceVerySmallNativeCoinAmount() {
    mockDb.doQuery.resetBehavior();
    mockDb.doQuery
        .onFirstCall().resolves([{ price: '1.00', status: 'finalized' }])
        .onSecondCall().resolves([{ price: '1000000', status: 'finalized' }]);
    let result = await hub.getFeeQuote('ISSUE', 'BTC');
    // nativeCoinAmount = 1.0 / 1000000 = 0.000001
    expect(result.nativeCoinAmount).to.equal('0.00000100');
}

function registerConfigRowOverridesDoNotMoveTheQuoteOffThePinnedBundle() {
    it('ignores a GAS_PRICE row and quotes the pinned price', testIgnoresAGASPRICERowAndQuotesThePinnedPrice);
    it('ignores a GAS_SCHEDULE row and quotes the pinned gas cost', testIgnoresAGASSCHEDULERowAndQuotesThePinnedGasCost);
    it('does not invent an action the pinned schedule does not define', testDoesNotInventAnActionThePinnedScheduleDoesNotDefine);
    it('warns once per diverging parameter rather than on every quote', testWarnsOncePerDivergingParameterRatherThanOnEveryQuote);
    it('stays silent when the row agrees with the pinned bundle', testStaysSilentWhenTheRowAgreesWithThePinnedBundle);
}
async function testIgnoresAGASPRICERowAndQuotesThePinnedPrice() {
    // Pinned GAS_PRICE is 0.00001 and ISSUE costs 100000 gas, so the pinned
    // quote is 1.00000000; honouring this row would have quoted 0.10000000.
    mockDb.getConfig.resolves({ GAS_PRICE: '0.000001' });
    let result = await hub.getFeeQuote('ISSUE', 'BTC');
    expect(result.gasPrice).to.equal('0.00001000');
    expect(result.xchainAmount).to.equal('1.00000000');
}
async function testIgnoresAGASSCHEDULERowAndQuotesThePinnedGasCost() {
    mockDb.getConfig.resolves({ GAS_SCHEDULE: JSON.stringify({ ISSUE: 7 }) });
    let result = await hub.getFeeQuote('ISSUE', 'BTC');
    expect(result.gasCost).to.equal(100000);
}
async function testDoesNotInventAnActionThePinnedScheduleDoesNotDefine() {
    mockDb.getConfig.resolves({ GAS_SCHEDULE: JSON.stringify({ MADE_UP: 7 }) });
    let result = await hub.getFeeQuote('MADE_UP', 'BTC');
    expect(result.error).to.include('unknown action');
}
async function testWarnsOncePerDivergingParameterRatherThanOnEveryQuote() {
    let warn = sinon.stub(console, 'warn');
    // Both quotes must complete, so every price read answers, not just the first.
    mockDb.doQuery.resetBehavior();
    mockDb.doQuery.resolves([{ price: '1.00', status: 'finalized' }]);
    mockDb.getConfig.resolves({ GAS_PRICE: '0.000001' });
    await hub.getFeeQuote('ISSUE', 'BTC');
    await hub.getFeeQuote('ISSUE', 'BTC');
    expect(warn.callCount).to.equal(1);
    expect(warn.firstCall.args[0]).to.contain('GAS_PRICE');
}
async function testStaysSilentWhenTheRowAgreesWithThePinnedBundle() {
    let warn = sinon.stub(console, 'warn');
    mockDb.getConfig.resolves({ GAS_PRICE: '0.00001' });
    let result = await hub.getFeeQuote('ISSUE', 'BTC');
    expect(result.gasPrice).to.equal('0.00001000');
    expect(warn.called).to.be.false;
}
