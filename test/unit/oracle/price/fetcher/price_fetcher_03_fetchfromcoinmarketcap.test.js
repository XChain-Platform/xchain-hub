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

// fetchFromCoinMarketCap()
const testCase1 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, PRICE_FETCH_JITTER_MS: 0 });
            let result = await pf.fetchFromCoinMarketCap();
            expect(result).to.be.null;
            expect(axiosStub.get.called).to.be.false;
        };

const testCase2 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, COINMARKETCAP_API_KEY: 'cmc-key' });
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
        };

const testCase3 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, COINMARKETCAP_API_KEY: 'my-key' });
            axiosStub.get.resolves({ data: { data: {} } });

            await pf.fetchFromCoinMarketCap();
            let headers = axiosStub.get.getCall(0).args[1].headers;
            expect(headers['X-CMC_PRO_API_KEY']).to.equal('my-key');
        };

const testCase4 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, COINMARKETCAP_API_KEY: 'key' });
            axiosStub.get.rejects(new Error('500'));

            let result = await pf.fetchFromCoinMarketCap();
            expect(result).to.be.null;
        };

function registerSuite1() {
    it('returns null when no API key configured', testCase1);
    it('returns prices from valid response', testCase2);
    it('passes API key in header', testCase3);
    it('returns null on error', testCase4);
}

function registerOuterSuite3() {
    beforeEach(function () {
        axiosStub = { get: sinon.stub() };
        PriceFetcher = proxyquire('../../../../../src/oracle/price_fetcher', { axios: axiosStub });
    });
    afterEach(function () {
        sinon.restore();
    });
    describe('fetchFromCoinMarketCap()', registerSuite1);
}

describe('PriceFetcher', registerOuterSuite3);
