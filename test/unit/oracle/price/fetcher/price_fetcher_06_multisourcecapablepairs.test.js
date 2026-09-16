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

// multiSourceCapablePairs()
const testCase1 = function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0 });
            let capable = pf.multiSourceCapablePairs();
            expect(capable.has('BTC/USD')).to.be.true;
            // Two of the nineteen pairs the Kraken-seeded set silently excluded (item
            // 7068): Kraken lists neither, but the keyless Coinbase source prices both,
            // so a sources=1 reading on them IS a degradation and must reach the signal.
            expect(capable.has('BTC/MXN')).to.be.true;
            expect(capable.has('LTC/CAD')).to.be.true;
            expect(capable.size).to.equal(36);
        };

const testCase2 = function () {
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, COINMARKETCAP_API_KEY: 'k' });
            expect(pf.multiSourceCapablePairs().size).to.equal(36);
        };

const testCase3 = function () {
            // Teeth, not a restatement of 36: recompute the >=2-sources rule from the
            // declared lineup, so the assertion follows the lineup if a source is ever added
            // or dropped instead of pinning today's answer. Drop Coinbase from the table and
            // the expected set shrinks back to the Kraken-only pairs, which is the state the
            // shipped code was stuck in.
            const lineup = PriceFetcher.priceSources();
            function expected(hasKey) {
                const counts = new Map();
                for (const s of lineup) {
                    if (s.requiresKey && !hasKey) continue;
                    for (const p of s.covers) counts.set(p, (counts.get(p) || 0) + 1);
                }
                return [...counts.entries()].filter(([, n]) => n >= 2).map(([p]) => p).sort();
            }
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0 });
            expect([...pf.multiSourceCapablePairs()].sort()).to.deep.equal(expected(false));
            pf = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0, COINMARKETCAP_API_KEY: 'k' });
            expect([...pf.multiSourceCapablePairs()].sort()).to.deep.equal(expected(true));

            // The filter still has teeth: with Coinbase removed from the lineup, only
            // the Kraken-listed pairs clear the bar.
            const withoutCoinbase = lineup.filter(s => s.key !== 'coinbase');
            const counts = new Map();
            for (const s of withoutCoinbase.filter(s => !s.requiresKey))
                for (const p of s.covers) counts.set(p, (counts.get(p) || 0) + 1);
            const kraken = [...counts.entries()].filter(([, n]) => n >= 2).map(([p]) => p);
            expect(kraken.length).to.be.below(36);
            expect(kraken).to.not.include('BTC/MXN');
        };

const testCase4 = async function () {
            // The gap this replaced was a hand-written second statement of the source
            // lineup that stopped matching fetchPrices(). Pin the two together, so a source
            // added to one and not the other reddens instead of quietly changing what the
            // health signal is allowed to see.
            const sinon  = require('sinon');
            const lineup = PriceFetcher.priceSources();
            for (const s of lineup)
                expect(PriceFetcher.prototype[s.method], s.key + ' names a missing fetcher').to.be.a('function');

            async function dispatched(config) {
                const f = new PriceFetcher(Object.assign({ PRICE_FETCH_JITTER_MS: 0 }, config));
                const called = [];
                for (const s of lineup)
                    sinon.stub(f, s.method).callsFake(async () => { called.push(s.key); return null; });
                await f.fetchPrices();
                return called.sort();
            }

            expect(await dispatched({}))
                .to.deep.equal(lineup.filter(s => !s.requiresKey).map(s => s.key).sort());
            expect(await dispatched({ COINMARKETCAP_API_KEY: 'k' }))
                .to.deep.equal(lineup.map(s => s.key).sort());
        };

function registerSuite1() {
    it('keyless: every pair reaches two sources, because CoinGecko and Coinbase both cover all 36', testCase1);
    it('with a CoinMarketCap key: still all 36 pairs', testCase2);
    it('matches the >=2-configured-sources rule recomputed from the declared lineup', testCase3);
    it('the declared lineup is exactly the set of fetchers fetchPrices() dispatches', testCase4);
}

function registerOuterSuite6() {
    beforeEach(function () {
        axiosStub = { get: sinon.stub() };
        PriceFetcher = proxyquire('../../../../../src/oracle/price_fetcher', { axios: axiosStub });
    });
    afterEach(function () {
        sinon.restore();
    });
    describe('multiSourceCapablePairs()', registerSuite1);
}

describe('PriceFetcher', registerOuterSuite6);
