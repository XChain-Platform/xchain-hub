'use strict';

const {
    sinon,
    expect,
    proxyquire,
    hostIs
} = require('./price_fetcher.test.js');

let axiosStub;
let PriceFetcher;
let pf;

// fetchPrices()
const testCase1 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, COINMARKETCAP_API_KEY: 'key' });

            // Stub by URL so order doesn't matter (CoinGecko has a random jitter delay)
            axiosStub.get.callsFake(function (url) {
                if (hostIs(url, 'api.coingecko.com')) {
                    return Promise.resolve({
                        data: { bitcoin: { usd: 100000 }, litecoin: { usd: 80 }, dogecoin: { usd: 0.14 } }
                    });
                }
                if (hostIs(url, 'pro-api.coinmarketcap.com')) {
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
        };

const testCase2 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, COINMARKETCAP_API_KEY: 'key' });

            // CoinGecko succeeds; CMC fails. Stub by URL for order-independence.
            axiosStub.get.callsFake(function (url) {
                if (hostIs(url, 'api.coingecko.com')) {
                    return Promise.resolve({
                        data: { bitcoin: { usd: 99000 }, litecoin: { usd: 78 }, dogecoin: { usd: 0.13 } }
                    });
                }
                if (hostIs(url, 'pro-api.coinmarketcap.com')) {
                    return Promise.reject(new Error('CMC down'));
                }
                return Promise.reject(new Error('unexpected URL: ' + url));
            });

            let prices = await pf.fetchPrices();
            expect(prices).to.have.lengthOf(3);
            let btc = prices.find(p => p.coinPair === 'BTC/USD');
            expect(btc.price).to.equal('99000.00000000');
            expect(btc.sources).to.equal(1);
        };

const testCase3 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, COINMARKETCAP_API_KEY: 'key' });
            axiosStub.get.rejects(new Error('fail'));

            let prices = await pf.fetchPrices();
            expect(prices).to.deep.equal([]);
        };

const testCase4 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, PRICE_FETCH_JITTER_MS: 0 });
            axiosStub.get.callsFake(function (url) {
                if (hostIs(url, 'api.coingecko.com')) {
                    return Promise.resolve({
                        data: { bitcoin: { usd: 50000 }, litecoin: { usd: 40 }, dogecoin: { usd: 0.1 } }
                    });
                }
                if (hostIs(url, 'api.kraken.com')) {
                    // Kraken response shape: { error: [], result: { ALTNAME: { c: [price, lot] } } }
                    return Promise.resolve({
                        data: { error: [], result: { XBTUSD: { c: ['50000', '1'] } } }
                    });
                }
                if (hostIs(url, 'api.coinbase.com')) {
                    // Coinbase answers ONE coin per call, priced in every currency.
                    let coin = /currency=([A-Z]+)/.exec(url);
                    let usd  = { BTC: '50000', LTC: '40', DOGE: '0.1' }[coin && coin[1]] || '1';
                    return Promise.resolve({ data: { data: { rates: { USD: usd } } } });
                }
                return Promise.reject(new Error('unexpected URL: ' + url));
            });

            let prices = await pf.fetchPrices();
            // Five calls, not three: CoinGecko and Kraken batch into one request each,
            // while Coinbase needs one per coin (its endpoint takes a single currency).
            expect(axiosStub.get.callCount).to.equal(5);
            let urls = axiosStub.get.getCalls().map(c => c.args[0]);
            expect(urls.some(u => hostIs(u, 'api.coingecko.com'))).to.be.true;
            expect(urls.some(u => hostIs(u, 'api.kraken.com'))).to.be.true;
            expect(urls.filter(u => hostIs(u, 'api.coinbase.com'))).to.have.lengthOf(3);
            // The point of the test: no key, so CMC is never contacted.
            expect(urls.some(u => hostIs(u, 'pro-api.coinmarketcap.com'))).to.be.false;
            expect(prices).to.have.lengthOf(3);
        };

const testCase5 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, PRICE_FETCH_JITTER_MS: 0 });
            axiosStub.get.resolves({
                data: { bitcoin: { usd: 1.5 }, litecoin: { usd: 2 }, dogecoin: { usd: 3 } }
            });

            let prices = await pf.fetchPrices();
            for (let p of prices) {
                expect(p.price).to.match(/^\d+\.\d{8}$/);
            }
        };

function registerSuite1() {
    it('returns median from both sources', testCase1);
    it('returns prices from single source when other fails', testCase2);
    it('returns empty array when all sources fail', testCase3);
    it('fetches CoinGecko + Kraken + Coinbase when no CMC key', testCase4);
    it('returns 8-decimal fixed-point prices', testCase5);
}

function registerOuterSuite4() {
    beforeEach(function () {
        axiosStub = { get: sinon.stub() };
        PriceFetcher = proxyquire('../../src/oracle/price_fetcher', { axios: axiosStub });
    });
    afterEach(function () {
        sinon.restore();
    });
    describe('fetchPrices()', registerSuite1);
}

describe('PriceFetcher', registerOuterSuite4);
