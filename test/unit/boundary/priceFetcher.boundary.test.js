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

describe('Boundary: PriceFetcher', function () {

    let axiosStub;
    let PriceFetcher;

    beforeEach(function () {
        axiosStub    = { get: sinon.stub() };
        PriceFetcher = proxyquire('../../../src/PriceFetcher', { axios: axiosStub });
    });

    afterEach(function () {
        sinon.restore();
    });

    // Helper: build a minimal PriceFetcher with no CMC key (so only CoinGecko is called)
    function makeFetcher(overrides) {
        return new PriceFetcher(Object.assign({ PRICE_FETCH_TIMEOUT: 5000 }, overrides || {}));
    }

    // Helper: build a standard CoinGecko response body
    function cgBody(bitcoin, litecoin, dogecoin) {
        let body = {};
        if (bitcoin   !== undefined) body.bitcoin  = { usd: bitcoin };
        if (litecoin  !== undefined) body.litecoin  = { usd: litecoin };
        if (dogecoin  !== undefined) body.dogecoin  = { usd: dogecoin };
        return { data: body };
    }

    // -----------------------------------------------------------------
    // CoinGecko response edge-cases
    // -----------------------------------------------------------------

    describe('CoinGecko price value edge cases', function () {

        it('price=0 is filtered out by price bounds (must be > 0)', async function () {
            axiosStub.get.resolves(cgBody(0, 80, 0.08));
            let fetcher = makeFetcher();
            let prices = await fetcher.fetchPrices();

            let btc = prices.find(p => p.coinPair === 'BTC/USD');
            expect(btc).to.be.undefined;
            // LTC and DOGE still present with valid prices
            expect(prices.find(p => p.coinPair === 'LTC/USD')).to.not.be.undefined;
        });

        it('negative price is filtered out by price bounds', async function () {
            axiosStub.get.resolves(cgBody(-100, 80, 0.08));
            let fetcher = makeFetcher();
            let prices = await fetcher.fetchPrices();

            let btc = prices.find(p => p.coinPair === 'BTC/USD');
            expect(btc).to.be.undefined;
        });

        it('NaN string is filtered out by isFinite check', async function () {
            axiosStub.get.resolves(cgBody('not-a-number', 80, 0.08));
            let fetcher = makeFetcher();
            let prices = await fetcher.fetchPrices();

            let btc = prices.find(p => p.coinPair === 'BTC/USD');
            expect(btc).to.be.undefined;
            // LTC still present
            expect(prices.find(p => p.coinPair === 'LTC/USD')).to.not.be.undefined;
        });

        it('very large price (1e18) is filtered out by upper bound', async function () {
            axiosStub.get.resolves(cgBody(1e18, 80, 0.08));
            let fetcher = makeFetcher();
            let prices = await fetcher.fetchPrices();

            let btc = prices.find(p => p.coinPair === 'BTC/USD');
            expect(btc).to.be.undefined;
        });

        it('string price "100000" → parseFloat coerces to number correctly', async function () {
            axiosStub.get.resolves(cgBody('100000', 80, 0.08));
            let fetcher = makeFetcher();
            let prices = await fetcher.fetchPrices();

            let btc = prices.find(p => p.coinPair === 'BTC/USD');
            expect(btc).to.not.be.undefined;
            expect(btc.price).to.equal('100000.00000000');
        });

        it('Infinity price is filtered out by isFinite check', async function () {
            axiosStub.get.resolves(cgBody(Infinity, 80, 0.08));
            let fetcher = makeFetcher();
            let prices = await fetcher.fetchPrices();

            let btc = prices.find(p => p.coinPair === 'BTC/USD');
            expect(btc).to.be.undefined;
        });
    });

    // -----------------------------------------------------------------
    // CoinGecko response structure edge cases
    // -----------------------------------------------------------------

    describe('CoinGecko response structure edge cases', function () {

        it('usd key missing for one coin → that coin is skipped, others included', async function () {
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
        });

        it('entire coin key missing from response → that coin is skipped', async function () {
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
        });

        it('CoinGecko returns empty object {} → no prices collected, fetchPrices returns []', async function () {
            axiosStub.get.resolves({ data: {} });
            let fetcher = makeFetcher();
            let prices = await fetcher.fetchPrices();
            expect(prices).to.deep.equal([]);
        });
    });

    // -----------------------------------------------------------------
    // Source failure scenarios
    // -----------------------------------------------------------------

    describe('source failure scenarios', function () {

        it('both sources fail (reject) → fetchPrices returns []', async function () {
            axiosStub.get.rejects(new Error('network error'));
            // Enable CMC so there are two sources that both reject
            let fetcher = makeFetcher({ COINMARKETCAP_API_KEY: 'fake-key' });
            let prices = await fetcher.fetchPrices();
            expect(prices).to.deep.equal([]);
        });

        it('CoinGecko fails, CMC succeeds → results come from CMC only', async function () {
            let fetcher = makeFetcher({ COINMARKETCAP_API_KEY: 'fake-key' });

            // Stub by URL so order doesn't matter (CoinGecko has a random jitter delay)
            axiosStub.get.callsFake(function (url) {
                if (url.includes('api.coingecko.com')) {
                    return Promise.reject(new Error('CoinGecko down'));
                }
                if (url.includes('coinmarketcap.com')) {
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
        });

        it('one source returns null values for all pairs → only valid prices from the other source used', async function () {
            // CoinGecko returns valid prices; CMC returns a response where all quote paths are absent
            let fetcher = makeFetcher({ COINMARKETCAP_API_KEY: 'fake-key' });

            // Stub by URL so order doesn't matter (CoinGecko has a random jitter delay)
            axiosStub.get.callsFake(function (url) {
                if (url.includes('api.coingecko.com')) {
                    return Promise.resolve(cgBody(100000, 80, 0.08));
                }
                if (url.includes('coinmarketcap.com')) {
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
        });

        it('CoinGecko returns null (fetch returns null, not rejected) → treated as no contribution', async function () {
            // axios.get resolves but with a shape that triggers the catch; simulate by
            // making response.data null so property access throws
            axiosStub.get.resolves({ data: null });
            let fetcher = makeFetcher();
            // Should not throw; catch block returns null, so fetchPrices returns []
            let prices = await fetcher.fetchPrices();
            expect(prices).to.deep.equal([]);
        });
    });

    // -----------------------------------------------------------------
    // Two-source median: prices combined across CoinGecko + CMC
    // -----------------------------------------------------------------

    describe('two-source median calculation', function () {

        it('two sources agree → median equals that price, sources=2', async function () {
            let fetcher = makeFetcher({ COINMARKETCAP_API_KEY: 'fake-key' });

            // Stub by URL so order doesn't matter (CoinGecko has a random jitter delay)
            axiosStub.get.callsFake(function (url) {
                if (url.includes('api.coingecko.com')) {
                    return Promise.resolve(cgBody(100000, 80, 0.08));
                }
                if (url.includes('coinmarketcap.com')) {
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
        });

        it('two sources differ → median is the average of the two values', async function () {
            let fetcher = makeFetcher({ COINMARKETCAP_API_KEY: 'fake-key' });

            // Stub by URL so order doesn't matter (CoinGecko has a random jitter delay)
            axiosStub.get.callsFake(function (url) {
                if (url.includes('api.coingecko.com')) {
                    return Promise.resolve(cgBody(100000, 80, 0.08));
                }
                if (url.includes('coinmarketcap.com')) {
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
        });
    });

    // -----------------------------------------------------------------
    // _median() direct boundary tests
    // -----------------------------------------------------------------

    describe('_median() edge cases', function () {

        let fetcher;
        beforeEach(function () {
            fetcher = makeFetcher();
        });

        // _median returns an 8-decimal bignumber string (mathjs/bcmath mandate)

        it('empty array → returns 0', function () {
            expect(fetcher._median([])).to.equal('0.00000000');
        });

        it('single value → returns that value', function () {
            expect(fetcher._median([42])).to.equal('42.00000000');
        });

        it('two values → returns their average', function () {
            expect(fetcher._median([10, 20])).to.equal('15.00000000');
        });

        it('two identical values → returns that value', function () {
            expect(fetcher._median([7, 7])).to.equal('7.00000000');
        });

        it('three values (odd) → returns the middle element', function () {
            expect(fetcher._median([1, 3, 5])).to.equal('3.00000000');
        });

        it('four values (even) → returns average of middle two', function () {
            expect(fetcher._median([1, 2, 3, 4])).to.equal('2.50000000');
        });

        it('unsorted input → sorts before computing median', function () {
            // Unsorted: [5, 1, 3] → sorted: [1, 3, 5] → median = 3
            expect(fetcher._median([5, 1, 3])).to.equal('3.00000000');
        });

        it('does not mutate the original array', function () {
            let original = [3, 1, 2];
            fetcher._median(original);
            expect(original).to.deep.equal([3, 1, 2]);
        });

        it('all-zero array → returns 0', function () {
            expect(fetcher._median([0, 0, 0])).to.equal('0.00000000');
        });

        it('large values → no overflow, returns correct average (bignumber, exact)', function () {
            let result = fetcher._median([1e18, 2e18]);
            expect(result).to.equal('1500000000000000000.00000000');
        });
    });
});
