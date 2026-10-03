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

// HTTP 400 attribution: the CMC plan-tier hint names CMC only, and a 400 never retries.
const http400 = () => Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } });
const logLines = (stub) => stub.getCalls().map(c => String(c.args[0]));

const testCase5 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0 });
            axiosStub.get.rejects(http400());
            let warnStub = sinon.stub(console, 'warn');

            expect(await pf.fetchFromCoinGecko()).to.be.null;
            expect(await pf.fetchFromKraken()).to.be.null;
            let calls = axiosStub.get.callCount;
            expect(calls).to.equal(2);   // one request each: a 400 is never retried
            let warns = logLines(warnStub);
            expect(warns.some(m => m.includes('CoinGecko'))).to.equal(true);
            expect(warns.some(m => m.includes('Kraken'))).to.equal(true);
            expect(warns.filter(m => m.includes('CoinMarketCap'))).to.have.lengthOf(0);
        };

const testCase6 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, COINMARKETCAP_API_KEY: 'key', CMC_400_ALERT_THRESHOLD: 2 });
            axiosStub.get.rejects(http400());
            let warnStub  = sinon.stub(console, 'warn');
            let errorStub = sinon.stub(console, 'error');

            expect(await pf.fetchFromCoinMarketCap()).to.be.null;
            let planWarns = () => logLines(warnStub).filter(m => m.includes('CoinMarketCap') && m.includes('plan'));
            expect(planWarns()).to.have.lengthOf(1);
            expect(errorStub.called).to.equal(false);

            await pf.fetchFromCoinMarketCap();
            expect(planWarns()).to.have.lengthOf(2);
            let errors = logLines(errorStub);
            expect(errors.some(m => m.includes('2 consecutive rounds'))).to.equal(true);
            expect(errors.some(m => m.includes('CoinGecko only'))).to.equal(false);
        };

function registerSuite1() {
    it('returns null when no API key configured', testCase1);
    it('returns prices from valid response', testCase2);
    it('passes API key in header', testCase3);
    it('returns null on error', testCase4);
    it('never blames CMC for a 400 from another source', testCase5);
    it('warns per round on a CMC 400 and escalates at the threshold', testCase6);
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
