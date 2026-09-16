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

let warnStub;

// (0, PRICE_MAX) bound rejections: drop signal + per-source counter
const hook1 = function () {
            warnStub = sinon.stub(console, 'warn');
        };

function boundWarns() {
            // Other warn lines these fetchers emit (fetch-failed, total-loss) must not
            // satisfy these assertions, so match on the bound line's own phrase.
            return warnStub.getCalls()
                .map(c => String(c.args[0]))
                .filter(m => m.includes('outside the ingestion bound'));
        }

const testCase2 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0 });
            axiosStub.get.resolves({
                data: {
                    bitcoin:  { usd: 0 },        // rejected by the bound
                    litecoin: { usd: 85.25 },
                    dogecoin: { usd: 0.15 }
                }
            });

            let result = await pf.fetchFromCoinGecko();
            expect(result['BTC/USD']).to.be.undefined;   // still excluded from the median
            expect(result['LTC/USD']).to.equal(85.25);   // healthy pairs unaffected

            let warns = boundWarns();
            expect(warns).to.have.lengthOf(1);
            expect(warns[0]).to.include('CoinGecko');
            expect(warns[0]).to.include('BTC/USD=0');
            expect(pf._boundRejects.coingecko).to.equal(1);
        };

const testCase3 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0 });
            axiosStub.get.resolves({
                data: {
                    bitcoin:  { usd: 0, cad: -1, gbp: 'not-a-number' },
                    litecoin: { usd: 1e20 },   // at/above PRICE_MAX
                    dogecoin: { usd: 0.15 }
                }
            });

            let result = await pf.fetchFromCoinGecko();
            expect(result['DOGE/USD']).to.equal(0.15);

            let warns = boundWarns();
            expect(warns).to.have.lengthOf(1);           // one line per source per fetch
            expect(warns[0]).to.include('4 value(s)');
            expect(pf._boundRejects.coingecko).to.equal(4);
        };

const testCase4 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0 });
            axiosStub.get.resolves({ data: { bitcoin: { usd: 0 }, litecoin: { usd: 85 }, dogecoin: { usd: 0.15 } } });

            await pf.fetchFromCoinGecko();
            await pf.fetchFromCoinGecko();
            expect(pf._boundRejects.coingecko).to.equal(2);
            expect(boundWarns()).to.have.lengthOf(2);    // one per fetch, not one per pair
        };

const testCase5 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0 });
            axiosStub.get.resolves({ data: { bitcoin: { usd: 100000 }, litecoin: { usd: 85 }, dogecoin: { usd: 0.15 } } });

            await pf.fetchFromCoinGecko();
            expect(boundWarns()).to.have.lengthOf(0);
            expect(pf._boundRejects.coingecko).to.equal(0);
        };

const testCase6 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0 });
            // Only BTC/USD is present; every other pair is simply missing.
            axiosStub.get.resolves({ data: { bitcoin: { usd: 100000 } } });

            await pf.fetchFromCoinGecko();
            expect(boundWarns()).to.have.lengthOf(0);
            expect(pf._boundRejects.coingecko).to.equal(0);
        };

const testCase7 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0 });
            axiosStub.get.resolves({
                data: { error: [], result: { XXBTZUSD: { c: ['0', '1'] }, XXBTZEUR: { c: ['90000', '1'] } } }
            });

            let result = await pf.fetchFromKraken();
            expect(result['BTC/USD']).to.be.undefined;
            expect(result['BTC/EUR']).to.equal(90000);

            let warns = boundWarns();
            expect(warns).to.have.lengthOf(1);
            expect(warns[0]).to.include('Kraken');
            expect(pf._boundRejects.kraken).to.equal(1);
            expect(pf._boundRejects.coingecko).to.equal(0);   // counters are per source
        };

const testCase8 = async function () {
            // Coinbase reaches reportBoundRejects like every other source, but its key
            // was missing from the _boundRejects declaration, so `undefined + n` pinned
            // the counter at NaN on the first rejection and the warn line printed
            // "Cumulative for this source: NaN." for the rest of the process, on the
            // source with the widest pair coverage.
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0 });
            // One request per coin (BTC/LTC/DOGE), each answering a zero USD rate and a
            // healthy EUR one: 3 rejections in one fetch, 3 surviving pairs.
            axiosStub.get.resolves({ data: { data: { rates: { USD: '0', EUR: '90000' } } } });

            let result = await pf.fetchFromCoinbase();
            expect(result['BTC/USD']).to.be.undefined;
            expect(result['BTC/EUR']).to.equal(90000);

            let warns = boundWarns();
            expect(warns).to.have.lengthOf(1);
            expect(warns[0]).to.include('Coinbase');
            expect(warns[0]).to.include('BTC/USD=0');
            expect(warns[0]).to.not.include('NaN');
            expect(pf._boundRejects.coinbase).to.equal(3);
            expect(pf._boundRejects.coingecko).to.equal(0);   // counters are per source
        };

const testCase9 = async function () {
            // The structural half: a future fifth source that misses the declaration
            // must degrade to a correct count, not to a counter that reads as working.
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0 });
            pf.reportBoundRejects('a-source-nobody-declared', 'NewSource', ['X/USD=0', 'Y/USD=0']);
            pf.reportBoundRejects('a-source-nobody-declared', 'NewSource', ['Z/USD=0']);
            expect(pf._boundRejects['a-source-nobody-declared']).to.equal(3);
        };

const testCase10 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, COINMARKETCAP_API_KEY: 'k' });
            axiosStub.get.resolves({
                data: {
                    data: {
                        BTC:  { quote: { USD: { price: -5 }, CAD: { price: null } } },
                        LTC:  { quote: { USD: { price: 85 } } },
                        DOGE: { quote: { USD: { price: 0.15 } } }
                    }
                }
            });

            let result = await pf.fetchFromCoinMarketCap();
            expect(result['BTC/USD']).to.be.undefined;
            expect(result['LTC/USD']).to.equal(85);

            let warns = boundWarns();
            expect(warns).to.have.lengthOf(1);
            expect(warns[0]).to.include('CoinMarketCap');
            expect(warns[0]).to.include('BTC/USD=-5');
            expect(pf._boundRejects.coinmarketcap).to.equal(1);   // the null CAD quote is an absence
        };

const testCase11 = async function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0 });
            let garbage = 'x'.repeat(500);
            axiosStub.get.resolves({
                data: { bitcoin: { usd: garbage }, litecoin: { usd: 85 }, dogecoin: { usd: 0.15 } }
            });

            await pf.fetchFromCoinGecko();
            let warns = boundWarns();
            expect(warns).to.have.lengthOf(1);
            expect(warns[0].length).to.be.below(300);
            expect(warns[0]).to.include('...');
        };

function registerSuite1() {
    beforeEach(hook1);
    it('CoinGecko: a zero price is dropped, warned once, and counted', testCase2);
    it('CoinGecko: several rejected pairs in one fetch emit exactly ONE warn line', testCase3);
    it('CoinGecko: the counter accumulates across fetches', testCase4);
    it('CoinGecko: a clean fetch emits no bound warn and leaves the counter at zero', testCase5);
    it('CoinGecko: an absent pair is not counted as a bound rejection', testCase6);
    it('Kraken: a zero last-trade price is dropped, warned and counted under its own source', testCase7);
    it('Coinbase: rejections are counted, not accumulated as NaN (#6190)', testCase8);
    it('a source key absent from the declaration self-initialises instead of going NaN (#6190)', testCase9);
    it('CoinMarketCap: an out-of-bound price is warned and counted; a null price is not', testCase10);
    it('a garbage upstream value is truncated in the warn line', testCase11);
}

function registerOuterSuite7() {
    beforeEach(function () {
        axiosStub = { get: sinon.stub() };
        PriceFetcher = proxyquire('../../../../../src/oracle/price_fetcher', { axios: axiosStub });
    });
    afterEach(function () {
        sinon.restore();
    });
    describe('bound-rejection signal', registerSuite1);
}

describe('PriceFetcher', registerOuterSuite7);
