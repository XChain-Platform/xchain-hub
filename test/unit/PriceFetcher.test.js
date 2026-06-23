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

describe('PriceFetcher', function () {

    let axiosStub, PriceFetcher, pf;

    beforeEach(function () {
        axiosStub = { get: sinon.stub() };
        PriceFetcher = proxyquire('../../src/PriceFetcher', { axios: axiosStub });
    });

    afterEach(function () {
        sinon.restore();
    });

    // -----------------------------------------------------------------
    // _median()
    // -----------------------------------------------------------------

    describe('_median()', function () {
        beforeEach(function () {
            pf = new PriceFetcher({});
        });

        // _median returns an 8-decimal bignumber string (mathjs/bcmath mandate)

        it('single value returns that value', function () {
            expect(pf._median([42])).to.equal('42.00000000');
        });

        it('two values returns average', function () {
            expect(pf._median([10, 20])).to.equal('15.00000000');
        });

        it('odd count returns middle value', function () {
            expect(pf._median([1, 3, 2])).to.equal('2.00000000');
        });

        it('even count returns average of two middle values', function () {
            expect(pf._median([1, 2, 3, 4])).to.equal('2.50000000');
        });

        it('empty array returns 0', function () {
            expect(pf._median([])).to.equal('0.00000000');
        });

        it('does not mutate input array', function () {
            let arr = [3, 1, 2];
            pf._median(arr);
            expect(arr).to.deep.equal([3, 1, 2]);
        });
    });

    // -----------------------------------------------------------------
    // fetchFromCoinGecko()
    // -----------------------------------------------------------------

    describe('fetchFromCoinGecko()', function () {

        it('returns prices from valid response', async function () {
            pf = new PriceFetcher({});
            axiosStub.get.resolves({
                data: {
                    bitcoin:  { usd: 100000.5 },
                    litecoin: { usd: 85.25 },
                    dogecoin: { usd: 0.15 }
                }
            });

            let result = await pf.fetchFromCoinGecko();
            expect(result['BTC/USD']).to.equal(100000.5);
            expect(result['LTC/USD']).to.equal(85.25);
            expect(result['DOGE/USD']).to.equal(0.15);
        });

        it('includes API key header when configured', async function () {
            pf = new PriceFetcher({ COINGECKO_API_KEY: 'test-key' });
            axiosStub.get.resolves({ data: { bitcoin: { usd: 1 }, litecoin: { usd: 1 }, dogecoin: { usd: 1 } } });

            await pf.fetchFromCoinGecko();
            let headers = axiosStub.get.getCall(0).args[1].headers;
            expect(headers['x-cg-demo-api-key']).to.equal('test-key');
        });

        it('returns null on network error', async function () {
            pf = new PriceFetcher({});
            axiosStub.get.rejects(new Error('timeout'));

            let result = await pf.fetchFromCoinGecko();
            expect(result).to.be.null;
        });

        it('handles partial response (missing coin)', async function () {
            pf = new PriceFetcher({});
            axiosStub.get.resolves({
                data: { bitcoin: { usd: 100000 } } // missing litecoin, dogecoin
            });

            let result = await pf.fetchFromCoinGecko();
            expect(result['BTC/USD']).to.equal(100000);
            expect(result['LTC/USD']).to.be.undefined;
        });
    });

    // -----------------------------------------------------------------
    // fetchFromCoinMarketCap()
    // -----------------------------------------------------------------

    describe('fetchFromCoinMarketCap()', function () {

        it('returns null when no API key configured', async function () {
            pf = new PriceFetcher({});
            let result = await pf.fetchFromCoinMarketCap();
            expect(result).to.be.null;
            expect(axiosStub.get.called).to.be.false;
        });

        it('returns prices from valid response', async function () {
            pf = new PriceFetcher({ COINMARKETCAP_API_KEY: 'cmc-key' });
            axiosStub.get.resolves({
                data: {
                    data: {
                        BTC:  { quote: { USD: { price: 100500 } } },
                        LTC:  { quote: { USD: { price: 86.5 } } },
                        DOGE: { quote: { USD: { price: 0.16 } } }
                    }
                }
            });

            let result = await pf.fetchFromCoinMarketCap();
            expect(result['BTC/USD']).to.equal(100500);
            expect(result['LTC/USD']).to.equal(86.5);
        });

        it('passes API key in header', async function () {
            pf = new PriceFetcher({ COINMARKETCAP_API_KEY: 'my-key' });
            axiosStub.get.resolves({ data: { data: {} } });

            await pf.fetchFromCoinMarketCap();
            let headers = axiosStub.get.getCall(0).args[1].headers;
            expect(headers['X-CMC_PRO_API_KEY']).to.equal('my-key');
        });

        it('returns null on error', async function () {
            pf = new PriceFetcher({ COINMARKETCAP_API_KEY: 'key' });
            axiosStub.get.rejects(new Error('500'));

            let result = await pf.fetchFromCoinMarketCap();
            expect(result).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // fetchPrices()
    // -----------------------------------------------------------------

    describe('fetchPrices()', function () {

        it('returns median from both sources', async function () {
            pf = new PriceFetcher({ COINMARKETCAP_API_KEY: 'key' });

            // Stub by URL so order doesn't matter (CoinGecko has a random jitter delay)
            axiosStub.get.callsFake(function (url) {
                if (url.includes('api.coingecko.com')) {
                    return Promise.resolve({
                        data: { bitcoin: { usd: 100000 }, litecoin: { usd: 80 }, dogecoin: { usd: 0.14 } }
                    });
                }
                if (url.includes('coinmarketcap.com')) {
                    return Promise.resolve({
                        data: {
                            data: {
                                BTC: { quote: { USD: { price: 100010 } } },
                                LTC: { quote: { USD: { price: 82 } } },
                                DOGE: { quote: { USD: { price: 0.16 } } }
                            }
                        }
                    });
                }
                return Promise.reject(new Error('unexpected URL: ' + url));
            });

            let prices = await pf.fetchPrices();
            expect(prices).to.have.lengthOf(3);

            let btc = prices.find(p => p.coinPair === 'BTC/USD');
            expect(btc.price).to.equal('100005.00000000'); // median of 100000, 100010
            expect(btc.sources).to.equal(2);
        });

        it('returns prices from single source when other fails', async function () {
            pf = new PriceFetcher({ COINMARKETCAP_API_KEY: 'key' });

            // CoinGecko succeeds; CMC fails. Stub by URL for order-independence.
            axiosStub.get.callsFake(function (url) {
                if (url.includes('api.coingecko.com')) {
                    return Promise.resolve({
                        data: { bitcoin: { usd: 99000 }, litecoin: { usd: 78 }, dogecoin: { usd: 0.13 } }
                    });
                }
                if (url.includes('coinmarketcap.com')) {
                    return Promise.reject(new Error('CMC down'));
                }
                return Promise.reject(new Error('unexpected URL: ' + url));
            });

            let prices = await pf.fetchPrices();
            expect(prices).to.have.lengthOf(3);
            let btc = prices.find(p => p.coinPair === 'BTC/USD');
            expect(btc.price).to.equal('99000.00000000');
            expect(btc.sources).to.equal(1);
        });

        it('returns empty array when all sources fail', async function () {
            pf = new PriceFetcher({ COINMARKETCAP_API_KEY: 'key' });
            axiosStub.get.rejects(new Error('fail'));

            let prices = await pf.fetchPrices();
            expect(prices).to.deep.equal([]);
        });

        it('fetches CoinGecko + Kraken when no CMC key', async function () {
            pf = new PriceFetcher({});
            axiosStub.get.callsFake(function (url) {
                if (url.includes('api.coingecko.com')) {
                    return Promise.resolve({
                        data: { bitcoin: { usd: 50000 }, litecoin: { usd: 40 }, dogecoin: { usd: 0.1 } }
                    });
                }
                if (url.includes('kraken.com')) {
                    // Kraken response shape: { error: [], result: { ALTNAME: { c: [price, lot] } } }
                    return Promise.resolve({
                        data: { error: [], result: { XBTUSD: { c: ['50000', '1'] } } }
                    });
                }
                return Promise.reject(new Error('unexpected URL: ' + url));
            });

            let prices = await pf.fetchPrices();
            expect(axiosStub.get.calledTwice).to.be.true;
            let urls = [axiosStub.get.firstCall.args[0], axiosStub.get.secondCall.args[0]];
            expect(urls.some(u => u.includes('coingecko.com'))).to.be.true;
            expect(urls.some(u => u.includes('kraken.com'))).to.be.true;
            expect(prices).to.have.lengthOf(3);
        });

        it('returns 8-decimal fixed-point prices', async function () {
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

    // -----------------------------------------------------------------
    // Timeout configuration
    // -----------------------------------------------------------------

    describe('timeout', function () {
        it('uses default 10000ms', function () {
            pf = new PriceFetcher({});
            expect(pf.timeout).to.equal(10000);
        });

        it('uses configured timeout', function () {
            pf = new PriceFetcher({ PRICE_FETCH_TIMEOUT: 5000 });
            expect(pf.timeout).to.equal(5000);
        });
    });

    // -----------------------------------------------------------------
    // multiSourceCapablePairs()
    // -----------------------------------------------------------------

    describe('multiSourceCapablePairs()', function () {
        it('keyless: only Kraken-listed pairs can reach two sources', function () {
            pf = new PriceFetcher({});
            let capable = pf.multiSourceCapablePairs();
            // CoinGecko (all 36) + Kraken (its listed subset) are the two keyless sources.
            expect(capable.has('BTC/USD')).to.be.true;   // Kraken lists XBTUSD
            expect(capable.has('BTC/MXN')).to.be.false;  // CoinGecko-only by design
            expect(capable.has('LTC/CAD')).to.be.false;  // Kraken lists no LTC/CAD
            expect(capable.size).to.equal(17);           // current KRAKEN_PAIRS count
        });

        it('with a CoinMarketCap key: all 36 pairs become multi-source-capable', function () {
            pf = new PriceFetcher({ COINMARKETCAP_API_KEY: 'k' });
            let capable = pf.multiSourceCapablePairs();
            expect(capable.has('BTC/MXN')).to.be.true;   // CoinGecko + CMC both cover it
            expect(capable.size).to.equal(36);
        });
    });
});
