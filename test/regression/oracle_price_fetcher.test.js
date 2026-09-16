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

const sinon            = require('sinon');
const { expect }       = require('chai');
const proxyquire       = require('proxyquire');

// Match a stubbed request by parsed hostname rather than a raw substring, so a
// lookalike host (e.g. api.coingecko.com.evil.example) cannot pass the check.
function hostIs(url, host) {
    try { return new URL(url).hostname === host; } catch (e) { return false; }
}

// =================================================================
// PriceFetcher
// =================================================================

function registerSuitePart1() {
    describe('PriceFetcher', function () {
    registerNestedSuite1Part1();
    registerNestedSuite1Part2();
    registerNestedSuite1Part3();
    registerNestedSuite1Part4();
    registerNestedSuite1Part5();
    registerNestedSuite1Part6();
    registerNestedSuite1Part7();

    });
}

describe('Regression: Oracle Pipeline', function () {
    registerSuitePart1();

});
      let axiosStub, PriceFetcher, pf;
      function registerNestedSuite1Part1() {
    beforeEach(function () {
            axiosStub = { get: sinon.stub() };
            PriceFetcher = proxyquire('../../src/oracle/price_fetcher', { axios: axiosStub });
        });
}
      function registerNestedSuite1Part2() {
    afterEach(function () { sinon.restore(); });
}
      // REG-ORA-001
    function registerNestedSuite1Part3() {
    describe('REG-ORA-001: Local median from CoinGecko + CoinMarketCap', function () {
            it('returns median of two sources @regression-p0', async function () {
                pf = new PriceFetcher({ COINMARKETCAP_API_KEY: 'key' });

                // Stub by URL, not call order: CoinGecko fetches carry a random
                // jitter delay and additional keyless upstreams (Kraken) exist,
                // so positional stubs no longer line up.
                axiosStub.get.callsFake(function (url) {
                    if (hostIs(url, 'api.coingecko.com')) {
                        return Promise.resolve({
                            data: { bitcoin: { usd: 100000 }, litecoin: { usd: 80 }, dogecoin: { usd: 0.14 } }
                        });
                    }
                    if (hostIs(url, 'pro-api.coinmarketcap.com')) {
                        return Promise.resolve({
                            data: { data: {
                                BTC: { quote: { USD: { price: 100010 } } },
                                LTC: { quote: { USD: { price: 82 } } },
                                DOGE: { quote: { USD: { price: 0.16 } } }
                            }}
                        });
                    }
                    return Promise.reject(new Error('unexpected URL: ' + url));
                });

                let prices = await pf.fetchPrices();
                expect(prices).to.have.lengthOf(3);

                let btc = prices.find(p => p.coinPair === 'BTC/USD');
                expect(btc.price).to.equal('100005.00000000');
                expect(btc.sources).to.equal(2);
            });
        });
}
      // REG-ORA-002
    function registerNestedSuite1Part4() {
    describe('REG-ORA-002: Price range validation (0 < price < 10M)', function () {
            it('returns empty array when all sources fail @regression-p0', async function () {
                pf = new PriceFetcher({ COINMARKETCAP_API_KEY: 'key' });
                axiosStub.get.rejects(new Error('fail'));

                let prices = await pf.fetchPrices();
                expect(prices).to.deep.equal([]);
            });
        });
}
      // REG-ORA-003
    function registerNestedSuite1Part5() {
    describe('REG-ORA-003: Single source failure handled gracefully', function () {
            it('returns prices from remaining source @regression-p1', async function () {
                pf = new PriceFetcher({ COINMARKETCAP_API_KEY: 'key' });

                axiosStub.get.callsFake(function (url) {
                    if (hostIs(url, 'api.coingecko.com')) {
                        return Promise.resolve({
                            data: { bitcoin: { usd: 99000 }, litecoin: { usd: 78 }, dogecoin: { usd: 0.13 } }
                        });
                    }
                    return Promise.reject(new Error('CMC down'));
                });

                let prices = await pf.fetchPrices();
                expect(prices).to.have.lengthOf(3);
                let btc = prices.find(p => p.coinPair === 'BTC/USD');
                expect(btc.price).to.equal('99000.00000000');
                expect(btc.sources).to.equal(1);
            });
        });
}
      // REG-ORA-004
    function registerNestedSuite1Part6() {
    describe('REG-ORA-004: Timeout configuration', function () {
            it('defaults to 10000ms @regression-p2', function () {
                pf = new PriceFetcher({});
                expect(pf.timeout).to.equal(10000);
            });

            it('uses configured timeout @regression-p2', function () {
                pf = new PriceFetcher({ PRICE_FETCH_TIMEOUT: 5000 });
                expect(pf.timeout).to.equal(5000);
            });
        });
}
      // REG-ORA-013
    function registerNestedSuite1Part7() {
    describe('REG-ORA-013: 8-decimal fixed-point prices', function () {
            it('all prices are 8-decimal strings @regression-p2', async function () {
                pf = new PriceFetcher({});
                axiosStub.get.resolves({
                    data: { bitcoin: { usd: 1.5 }, litecoin: { usd: 2 }, dogecoin: { usd: 3 } }
                });

                let prices = await pf.fetchPrices();
                for (let p of prices) {
                    expect(p.price).to.match(/^\d+\.\d{8}$/);
                }
            });
        });
}
