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

let axiosStub;
let PriceFetcher;
function makeFetcher(overrides) {
    return new PriceFetcher(Object.assign({ PRICE_FETCH_TIMEOUT: 5000, PRICE_FETCH_JITTER_MS: 0 }, overrides || {}));
}
function cgBody(bitcoin, litecoin, dogecoin) {
    let body = {};
    if (bitcoin   !== undefined) body.bitcoin  = { usd: bitcoin };
    if (litecoin  !== undefined) body.litecoin  = { usd: litecoin };
    if (dogecoin  !== undefined) body.dogecoin  = { usd: dogecoin };
    return { data: body };
}
function hostIs(url, host) {
    try { return new URL(url).hostname === host; } catch (e) { return false; }
}
let fetcher;

describe('Boundary: PriceFetcher', registerBoundaryPriceFetcher);

function registerBoundaryPriceFetcher() {
    beforeEach(function () {
        axiosStub    = { get: sinon.stub() };
        PriceFetcher = proxyquire('../../../src/oracle/price_fetcher', { axios: axiosStub });
    });
    afterEach(function () {
        sinon.restore();
    });
    // Helper: build a minimal PriceFetcher with no CMC key (so only CoinGecko is called)
    // Helper: build a standard CoinGecko response body
    // Helper: match a stubbed request by parsed hostname rather than a raw substring,
    // so a lookalike host (e.g. api.coingecko.com.evil.example) cannot pass the check.
    // CoinGecko response edge-cases
    describe('CoinGecko price value edge cases', registerCoinGeckoPriceValueEdgeCases);
    // CoinGecko response structure edge cases
    describe('CoinGecko response structure edge cases', registerCoinGeckoResponseStructureEdgeCases);
    // Source failure scenarios
    describe('source failure scenarios', registerSourceFailureScenarios);
    // Two-source median: prices combined across CoinGecko + CMC
    describe('two-source median calculation', registerTwoSourceMedianCalculation);
    // _median() direct boundary tests
    describe('_median() edge cases', registerMedianEdgeCases);
}

function registerCoinGeckoPriceValueEdgeCases() {
    it('price=0 is filtered out by price bounds (must be > 0)', testPrice0IsFilteredOutByPriceBoundsMustBe0);
    it('negative price is filtered out by price bounds', testNegativePriceIsFilteredOutByPriceBounds);
    it('NaN string is filtered out by isFinite check', testNaNStringIsFilteredOutByIsFiniteCheck);
    it('very large price (1e18) is filtered out by upper bound', testVeryLargePrice1e18IsFilteredOutByUpperBound);
    it('string price "100000" → parseFloat coerces to number correctly', testStringPrice100000ParseFloatCoercesToNumberCorrectly);
    it('Infinity price is filtered out by isFinite check', testInfinityPriceIsFilteredOutByIsFiniteCheck);
}
async function testPrice0IsFilteredOutByPriceBoundsMustBe0() {
    axiosStub.get.resolves(cgBody(0, 80, 0.08));
    let fetcher = makeFetcher();
    let prices = await fetcher.fetchPrices();

    let btc = prices.find(p => p.coinPair === 'BTC/USD');
    expect(btc).to.be.undefined;
    // LTC and DOGE still present with valid prices
    expect(prices.find(p => p.coinPair === 'LTC/USD')).to.not.be.undefined;
}
async function testNegativePriceIsFilteredOutByPriceBounds() {
    axiosStub.get.resolves(cgBody(-100, 80, 0.08));
    let fetcher = makeFetcher();
    let prices = await fetcher.fetchPrices();

    let btc = prices.find(p => p.coinPair === 'BTC/USD');
    expect(btc).to.be.undefined;
}
async function testNaNStringIsFilteredOutByIsFiniteCheck() {
    axiosStub.get.resolves(cgBody('not-a-number', 80, 0.08));
    let fetcher = makeFetcher();
    let prices = await fetcher.fetchPrices();

    let btc = prices.find(p => p.coinPair === 'BTC/USD');
    expect(btc).to.be.undefined;
    // LTC still present
    expect(prices.find(p => p.coinPair === 'LTC/USD')).to.not.be.undefined;
}
async function testVeryLargePrice1e18IsFilteredOutByUpperBound() {
    axiosStub.get.resolves(cgBody(1e18, 80, 0.08));
    let fetcher = makeFetcher();
    let prices = await fetcher.fetchPrices();

    let btc = prices.find(p => p.coinPair === 'BTC/USD');
    expect(btc).to.be.undefined;
}
async function testStringPrice100000ParseFloatCoercesToNumberCorrectly() {
    axiosStub.get.resolves(cgBody('100000', 80, 0.08));
    let fetcher = makeFetcher();
    let prices = await fetcher.fetchPrices();

    let btc = prices.find(p => p.coinPair === 'BTC/USD');
    expect(btc).to.not.be.undefined;
    expect(btc.price).to.equal('100000.00000000');
}
async function testInfinityPriceIsFilteredOutByIsFiniteCheck() {
    axiosStub.get.resolves(cgBody(Infinity, 80, 0.08));
    let fetcher = makeFetcher();
    let prices = await fetcher.fetchPrices();

    let btc = prices.find(p => p.coinPair === 'BTC/USD');
    expect(btc).to.be.undefined;
}

function registerCoinGeckoResponseStructureEdgeCases() {
    it('usd key missing for one coin → that coin is skipped, others included', testUsdKeyMissingForOneCoinThatCoinIsSkippedOthersIncluded);
    it('entire coin key missing from response → that coin is skipped', testEntireCoinKeyMissingFromResponseThatCoinIsSkipped);
    it('CoinGecko returns empty object {} → no prices collected, fetchPrices returns []', testCoinGeckoReturnsEmptyObjectNoPricesCollectedFetchPricesReturns);
}
async function testUsdKeyMissingForOneCoinThatCoinIsSkippedOthersIncluded() {
    // bitcoin entry exists but has no usd key
    axiosStub.get.resolves({ data: {
        bitcoin:  {},          // no .usd
        litecoin: { usd: 80 },
        dogecoin: { usd: 0.08 }
    }});
    let fetcher = makeFetcher();
    let prices = await fetcher.fetchPrices();

    let btc = prices.find(p => p.coinPair === 'BTC/USD');
    let ltc = prices.find(p => p.coinPair === 'LTC/USD');
    expect(btc).to.be.undefined;
    expect(ltc).to.not.be.undefined;
}
async function testEntireCoinKeyMissingFromResponseThatCoinIsSkipped() {
    // dogecoin not returned at all
    axiosStub.get.resolves({ data: {
        bitcoin:  { usd: 100000 },
        litecoin: { usd: 80 }
        // dogecoin absent
    }});
    let fetcher = makeFetcher();
    let prices = await fetcher.fetchPrices();

    let doge = prices.find(p => p.coinPair === 'DOGE/USD');
    expect(doge).to.be.undefined;

    let btc = prices.find(p => p.coinPair === 'BTC/USD');
    expect(btc).to.not.be.undefined;
}
async function testCoinGeckoReturnsEmptyObjectNoPricesCollectedFetchPricesReturns() {
    axiosStub.get.resolves({ data: {} });
    let fetcher = makeFetcher();
    let prices = await fetcher.fetchPrices();
    expect(prices).to.deep.equal([]);
}

function registerSourceFailureScenarios() {
    it('both sources fail (reject) → fetchPrices returns []', testBothSourcesFailRejectFetchPricesReturns);
    it('CoinGecko fails, CMC succeeds → results come from CMC only', testCoinGeckoFailsCMCSucceedsResultsComeFromCMCOnly);
    it('one source returns null values for all pairs → only valid prices from the other source used', testOneSourceReturnsNullValuesForAllPairsOnlyValidPricesFrom);
    it('CoinGecko returns null (fetch returns null, not rejected) → treated as no contribution', testCoinGeckoReturnsNullFetchReturnsNullNotRejectedTreatedAsNoContribution);
}
async function testBothSourcesFailRejectFetchPricesReturns() {
    axiosStub.get.rejects(new Error('network error'));
    // Enable CMC so there are two sources that both reject
    let fetcher = makeFetcher({ COINMARKETCAP_API_KEY: 'fake-key' });
    let prices = await fetcher.fetchPrices();
    expect(prices).to.deep.equal([]);
}
async function testCoinGeckoFailsCMCSucceedsResultsComeFromCMCOnly() {
    let fetcher = makeFetcher({ COINMARKETCAP_API_KEY: 'fake-key' });

    // Stub by URL so order doesn't matter (CoinGecko has a random jitter delay)
    axiosStub.get.callsFake(function (url) {
        if (hostIs(url, 'api.coingecko.com')) {
            return Promise.reject(new Error('CoinGecko down'));
        }
        if (hostIs(url, 'pro-api.coinmarketcap.com')) {
            return Promise.resolve({ data: { data: {
                BTC:  { quote: { USD: { price: 99000 } } },
                LTC:  { quote: { USD: { price: 77 } } },
                DOGE: { quote: { USD: { price: 0.07 } } }
            }}});
        }
        return Promise.reject(new Error('unexpected URL: ' + url));
    });

    let prices = await fetcher.fetchPrices();
    let btc = prices.find(p => p.coinPair === 'BTC/USD');
    expect(btc).to.not.be.undefined;
    expect(btc.price).to.equal('99000.00000000');
    expect(btc.sources).to.equal(1);
}
async function testOneSourceReturnsNullValuesForAllPairsOnlyValidPricesFrom() {
    // CoinGecko returns valid prices; CMC returns a response where all quote paths are absent
    let fetcher = makeFetcher({ COINMARKETCAP_API_KEY: 'fake-key' });

    // Stub by URL so order doesn't matter (CoinGecko has a random jitter delay)
    axiosStub.get.callsFake(function (url) {
        if (hostIs(url, 'api.coingecko.com')) {
            return Promise.resolve(cgBody(100000, 80, 0.08));
        }
        if (hostIs(url, 'pro-api.coinmarketcap.com')) {
            return Promise.resolve({ data: { data: {
                // each symbol exists but has no quote.USD
                BTC:  { quote: {} },
                LTC:  { quote: {} },
                DOGE: { quote: {} }
            }}});
        }
        return Promise.reject(new Error('unexpected URL: ' + url));
    });

    let prices = await fetcher.fetchPrices();
    let btc = prices.find(p => p.coinPair === 'BTC/USD');
    expect(btc).to.not.be.undefined;
    // Only 1 source contributed (CoinGecko)
    expect(btc.sources).to.equal(1);
    expect(btc.price).to.equal('100000.00000000');
}
async function testCoinGeckoReturnsNullFetchReturnsNullNotRejectedTreatedAsNoContribution() {
    // axios.get resolves but with a shape that triggers the catch; simulate by
    // making response.data null so property access throws
    axiosStub.get.resolves({ data: null });
    let fetcher = makeFetcher();
    // Should not throw; catch block returns null, so fetchPrices returns []
    let prices = await fetcher.fetchPrices();
    expect(prices).to.deep.equal([]);
}

function registerTwoSourceMedianCalculation() {
    it('two sources agree → median equals that price, sources=2', testTwoSourcesAgreeMedianEqualsThatPriceSources2);
    it('two sources differ → median is the average of the two values', testTwoSourcesDifferMedianIsTheAverageOfTheTwoValues);
}
async function testTwoSourcesAgreeMedianEqualsThatPriceSources2() {
    let fetcher = makeFetcher({ COINMARKETCAP_API_KEY: 'fake-key' });

    // Stub by URL so order doesn't matter (CoinGecko has a random jitter delay)
    axiosStub.get.callsFake(function (url) {
        if (hostIs(url, 'api.coingecko.com')) {
            return Promise.resolve(cgBody(100000, 80, 0.08));
        }
        if (hostIs(url, 'pro-api.coinmarketcap.com')) {
            return Promise.resolve({ data: { data: {
                BTC:  { quote: { USD: { price: 100000 } } },
                LTC:  { quote: { USD: { price: 80 } } },
                DOGE: { quote: { USD: { price: 0.08 } } }
            }}});
        }
        return Promise.reject(new Error('unexpected URL: ' + url));
    });

    let prices = await fetcher.fetchPrices();
    let btc = prices.find(p => p.coinPair === 'BTC/USD');
    expect(btc.sources).to.equal(2);
    expect(btc.price).to.equal('100000.00000000');
}
async function testTwoSourcesDifferMedianIsTheAverageOfTheTwoValues() {
    let fetcher = makeFetcher({ COINMARKETCAP_API_KEY: 'fake-key' });

    // Stub by URL so order doesn't matter (CoinGecko has a random jitter delay)
    axiosStub.get.callsFake(function (url) {
        if (hostIs(url, 'api.coingecko.com')) {
            return Promise.resolve(cgBody(100000, 80, 0.08));
        }
        if (hostIs(url, 'pro-api.coinmarketcap.com')) {
            return Promise.resolve({ data: { data: {
                BTC:  { quote: { USD: { price: 100002 } } },
                LTC:  { quote: { USD: { price: 82 } } },
                DOGE: { quote: { USD: { price: 0.10 } } }
            }}});
        }
        return Promise.reject(new Error('unexpected URL: ' + url));
    });

    let prices = await fetcher.fetchPrices();
    let btc = prices.find(p => p.coinPair === 'BTC/USD');
    // (100000 + 100002) / 2 = 100001
    expect(btc.price).to.equal('100001.00000000');
    expect(btc.sources).to.equal(2);
}

function registerMedianEdgeCases() {
    beforeEach(function () {
        fetcher = makeFetcher();
    });
    // _median returns an 8-decimal bignumber string (mathjs/bcmath mandate)
    it('empty array → returns 0', testEmptyArrayReturns0);
    it('single value → returns that value', testSingleValueReturnsThatValue);
    it('two values → returns their average', testTwoValuesReturnsTheirAverage);
    it('two identical values → returns that value', testTwoIdenticalValuesReturnsThatValue);
    it('three values (odd) → returns the middle element', testThreeValuesOddReturnsTheMiddleElement);
    it('four values (even) → returns average of middle two', testFourValuesEvenReturnsAverageOfMiddleTwo);
    it('unsorted input → sorts before computing median', testUnsortedInputSortsBeforeComputingMedian);
    it('does not mutate the original array', testDoesNotMutateTheOriginalArray);
    it('all-zero array → returns 0', testAllZeroArrayReturns0);
    it('large values → no overflow, returns correct average (bignumber, exact)', testLargeValuesNoOverflowReturnsCorrectAverageBignumberExact);
}
function testEmptyArrayReturns0() {
    expect(fetcher._median([])).to.equal('0.00000000');
}
function testSingleValueReturnsThatValue() {
    expect(fetcher._median([42])).to.equal('42.00000000');
}
function testTwoValuesReturnsTheirAverage() {
    expect(fetcher._median([10, 20])).to.equal('15.00000000');
}
function testTwoIdenticalValuesReturnsThatValue() {
    expect(fetcher._median([7, 7])).to.equal('7.00000000');
}
function testThreeValuesOddReturnsTheMiddleElement() {
    expect(fetcher._median([1, 3, 5])).to.equal('3.00000000');
}
function testFourValuesEvenReturnsAverageOfMiddleTwo() {
    expect(fetcher._median([1, 2, 3, 4])).to.equal('2.50000000');
}
function testUnsortedInputSortsBeforeComputingMedian() {
    // Unsorted: [5, 1, 3] → sorted: [1, 3, 5] → median = 3
    expect(fetcher._median([5, 1, 3])).to.equal('3.00000000');
}
function testDoesNotMutateTheOriginalArray() {
    let original = [3, 1, 2];
    fetcher._median(original);
    expect(original).to.deep.equal([3, 1, 2]);
}
function testAllZeroArrayReturns0() {
    expect(fetcher._median([0, 0, 0])).to.equal('0.00000000');
}
function testLargeValuesNoOverflowReturnsCorrectAverageBignumberExact() {
    let result = fetcher._median([1e18, 2e18]);
    expect(result).to.equal('1500000000000000000.00000000');
}
