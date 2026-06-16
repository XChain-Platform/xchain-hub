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

const { expect }       = require('chai');
const PriceFetcher     = require('../../../src/PriceFetcher');
const mockApi          = require('../../helpers/mockExternalApi');

describe('Integration: Price Fetching (SC-1.x)', function () {

    before(function () { mockApi.setup(); });
    after(function ()  { mockApi.teardown(); });
    beforeEach(function () { mockApi.reset(); });

    // SC-1.1: Normal dual-source price fetch and aggregation
    describe('SC-1.1: Dual-source fetch', function () {
        it('computes local median from CoinGecko and CoinMarketCap', async function () {
            mockApi.mockCoinGeckoSuccess({ bitcoin: { usd: 100000 }, litecoin: { usd: 85 }, dogecoin: { usd: 0.15 } });
            mockApi.mockCmcSuccess({ data: {
                BTC:  { quote: { USD: { price: 100200 } } },
                LTC:  { quote: { USD: { price: 86 } } },
                DOGE: { quote: { USD: { price: 0.155 } } }
            }});

            let fetcher = new PriceFetcher({
                COINMARKETCAP_API_KEY: 'test-key',
                PRICE_FETCH_TIMEOUT: 5000
            });
            let prices = await fetcher.fetchPrices();

            expect(prices).to.be.an('array').with.lengthOf(3);

            let btc = prices.find(p => p.coinPair === 'BTC/USD');
            expect(btc).to.exist;
            // Median of 100000 and 100200 = 100100
            expect(btc.price).to.equal('100100.00000000');
            expect(btc.sources).to.equal(2);

            let ltc = prices.find(p => p.coinPair === 'LTC/USD');
            expect(ltc.price).to.equal('85.50000000');
            expect(ltc.sources).to.equal(2);

            let doge = prices.find(p => p.coinPair === 'DOGE/USD');
            // Median of 0.15 and 0.155 = 0.1525
            expect(doge.price).to.equal('0.15250000');
            expect(doge.sources).to.equal(2);
        });
    });

    // SC-1.2: Single source failure with graceful degradation
    describe('SC-1.2: Single source failure', function () {
        it('returns prices from CoinGecko when CoinMarketCap fails', async function () {
            mockApi.mockCoinGeckoSuccess();
            mockApi.mockCmcError(503);

            let fetcher = new PriceFetcher({
                COINMARKETCAP_API_KEY: 'test-key',
                PRICE_FETCH_TIMEOUT: 5000
            });
            let prices = await fetcher.fetchPrices();

            expect(prices).to.be.an('array').with.lengthOf(3);
            let btc = prices.find(p => p.coinPair === 'BTC/USD');
            expect(btc.sources).to.equal(1);
            expect(btc.price).to.equal('100000.00000000');
        });

        it('returns prices from CoinMarketCap when CoinGecko fails', async function () {
            mockApi.mockCoinGeckoError(500);
            mockApi.mockCmcSuccess();

            let fetcher = new PriceFetcher({
                COINMARKETCAP_API_KEY: 'test-key',
                PRICE_FETCH_TIMEOUT: 5000
            });
            let prices = await fetcher.fetchPrices();

            expect(prices).to.be.an('array').with.lengthOf(3);
            let btc = prices.find(p => p.coinPair === 'BTC/USD');
            expect(btc.sources).to.equal(1);
        });
    });

    // SC-1.3: Both sources fail
    describe('SC-1.3: Both sources fail', function () {
        it('returns empty array when all sources fail', async function () {
            mockApi.mockCoinGeckoError(500);
            mockApi.mockCmcError(503);

            let fetcher = new PriceFetcher({
                COINMARKETCAP_API_KEY: 'test-key',
                PRICE_FETCH_TIMEOUT: 5000
            });
            let prices = await fetcher.fetchPrices();

            expect(prices).to.be.an('array').with.lengthOf(0);
        });
    });

    // SC-1.4: API timeout handling
    describe('SC-1.4: Timeout handling', function () {
        it('handles CoinGecko timeout while using CoinMarketCap', async function () {
            this.timeout(10000);
            mockApi.mockCoinGeckoTimeout(5000);
            mockApi.mockCmcSuccess();

            let fetcher = new PriceFetcher({
                COINMARKETCAP_API_KEY: 'test-key',
                PRICE_FETCH_TIMEOUT: 1000
            });
            let prices = await fetcher.fetchPrices();

            expect(prices).to.be.an('array').with.lengthOf(3);
            let btc = prices.find(p => p.coinPair === 'BTC/USD');
            expect(btc.sources).to.equal(1);
        });
    });

    // SC-1.5: Malformed API response
    describe('SC-1.5: Malformed response', function () {
        it('handles CoinGecko returning incomplete data', async function () {
            mockApi.mockCoinGeckoSuccess({ bitcoin: {} });

            let fetcher = new PriceFetcher({ PRICE_FETCH_TIMEOUT: 5000 });
            let prices = await fetcher.fetchPrices();

            // bitcoin.usd is undefined, so BTC/USD should be skipped
            let btc = prices.find(p => p.coinPair === 'BTC/USD');
            expect(btc).to.be.undefined;
        });

        it('handles CoinGecko returning empty object', async function () {
            mockApi.mockCoinGeckoSuccess({});

            let fetcher = new PriceFetcher({ PRICE_FETCH_TIMEOUT: 5000 });
            let prices = await fetcher.fetchPrices();

            expect(prices).to.be.an('array').with.lengthOf(0);
        });
    });

    // SC-1.6: API key header propagation
    describe('SC-1.6: API key headers', function () {
        it('sends CoinGecko API key header when configured', async function () {
            let scope = nockCoinGeckoWithHeaderCheck('test-cg-key');

            let fetcher = new PriceFetcher({
                COINGECKO_API_KEY: 'test-cg-key',
                PRICE_FETCH_TIMEOUT: 5000
            });
            await fetcher.fetchFromCoinGecko();

            expect(scope.isDone()).to.be.true;
        });

        it('sends CoinMarketCap API key header', async function () {
            let scope = nockCmcWithHeaderCheck('test-cmc-key');

            let fetcher = new PriceFetcher({
                COINMARKETCAP_API_KEY: 'test-cmc-key',
                PRICE_FETCH_TIMEOUT: 5000
            });
            await fetcher.fetchFromCoinMarketCap();

            expect(scope.isDone()).to.be.true;
        });
    });

    // SC-1.7: Full multi-fiat fetch — all 3 coins × 12 fiats = 36 pairs.
    // The other scenarios use USD-only fixtures; this one exercises the complete
    // multi-fiat parse + median path and guards precision at high magnitudes
    // (KRW/JPY values near the price cap), where parseFloat + toFixed(8) is most
    // susceptible to floating-point regressions.
    describe('SC-1.7: Full multi-fiat fetch (all 36 pairs)', function () {
        it('returns all 36 coin/fiat pairs from a full dual-source response', async function () {
            mockApi.mockCoinGeckoSuccess(mockApi.FULL_COINGECKO_RESPONSE);
            mockApi.mockCmcSuccess(mockApi.FULL_CMC_RESPONSE);

            let fetcher = new PriceFetcher({
                COINMARKETCAP_API_KEY: 'test-key',
                PRICE_FETCH_TIMEOUT: 5000
            });
            let prices = await fetcher.fetchPrices();

            // Every one of the 36 supported pairs must be present.
            expect(prices).to.be.an('array').with.lengthOf(36);

            let byPair = {};
            for (let p of prices) { byPair[p.coinPair] = p; }

            for (let pair of PriceFetcher.getCoinPairs()) {
                expect(byPair[pair], 'missing pair ' + pair).to.exist;
                // Both sources agree, so every pair has 2 sources and 8-decimal format.
                expect(byPair[pair].sources, pair + ' sources').to.equal(2);
                expect(byPair[pair].price, pair + ' format').to.match(/^\d+\.\d{8}$/);
            }
        });

        it('preserves precision for high-magnitude non-USD pairs (KRW, JPY)', async function () {
            mockApi.mockCoinGeckoSuccess(mockApi.FULL_COINGECKO_RESPONSE);
            mockApi.mockCmcSuccess(mockApi.FULL_CMC_RESPONSE);

            let fetcher = new PriceFetcher({
                COINMARKETCAP_API_KEY: 'test-key',
                PRICE_FETCH_TIMEOUT: 5000
            });
            let prices = await fetcher.fetchPrices();
            let byPair = {};
            for (let p of prices) { byPair[p.coinPair] = p; }

            // KRW ~9.87M and JPY ~8.2M per BTC — both sources agree, so the median
            // equals the input and toFixed(8) must reproduce it exactly.
            expect(byPair['BTC/KRW'].price).to.equal('9876543.25000000');
            expect(byPair['BTC/JPY'].price).to.equal('8200000.50000000');

            // A non-USD pair at a smaller magnitude, for good measure.
            expect(byPair['DOGE/KRW'].price).to.equal('205.25000000');
            expect(byPair['LTC/JPY'].price).to.equal('13345.50000000');
        });
    });
});

// Helper: nock interceptor that validates the CoinGecko API key header
function nockCoinGeckoWithHeaderCheck(apiKey) {
    let nock = require('nock');
    return nock('https://api.coingecko.com')
        .get('/api/v3/simple/price')
        .query(true)
        .matchHeader('x-cg-demo-api-key', apiKey)
        .reply(200, mockApi.DEFAULT_COINGECKO_RESPONSE);
}

// Helper: nock interceptor that validates the CoinMarketCap API key header
function nockCmcWithHeaderCheck(apiKey) {
    let nock = require('nock');
    return nock('https://pro-api.coinmarketcap.com')
        .get('/v1/cryptocurrency/quotes/latest')
        .query(true)
        .matchHeader('X-CMC_PRO_API_KEY', apiKey)
        .reply(200, mockApi.DEFAULT_CMC_RESPONSE);
}
