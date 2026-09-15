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

// fetchFromCoinGecko()
const testCase1 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, PRICE_FETCH_JITTER_MS: 0 });
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
        };

const testCase2 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, COINGECKO_API_KEY: 'test-key' });
            axiosStub.get.resolves({ data: { bitcoin: { usd: 1 }, litecoin: { usd: 1 }, dogecoin: { usd: 1 } } });

            await pf.fetchFromCoinGecko();
            let headers = axiosStub.get.getCall(0).args[1].headers;
            expect(headers['x-cg-demo-api-key']).to.equal('test-key');
        };

const testCase3 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, PRICE_FETCH_JITTER_MS: 0 });
            axiosStub.get.rejects(new Error('timeout'));

            let result = await pf.fetchFromCoinGecko();
            expect(result).to.be.null;
        };

const testCase4 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, PRICE_FETCH_JITTER_MS: 0 });
            axiosStub.get.resolves({
                data: { bitcoin: { usd: 100000 } } // missing litecoin, dogecoin
            });

            let result = await pf.fetchFromCoinGecko();
            expect(result['BTC/USD']).to.equal(100000);
            expect(result['LTC/USD']).to.be.undefined;
        };

function registerSuite1() {
    it('returns prices from valid response', testCase1);
    it('includes API key header when configured', testCase2);
    it('returns null on network error', testCase3);
    it('handles partial response (missing coin)', testCase4);
}

function registerOuterSuite2() {
    beforeEach(function () {
        axiosStub = { get: sinon.stub() };
        PriceFetcher = proxyquire('../../src/oracle/price_fetcher', { axios: axiosStub });
    });
    afterEach(function () {
        sinon.restore();
    });
    describe('fetchFromCoinGecko()', registerSuite1);
}

describe('PriceFetcher', registerOuterSuite2);
