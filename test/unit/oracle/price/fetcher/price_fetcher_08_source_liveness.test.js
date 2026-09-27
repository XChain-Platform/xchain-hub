'use strict';

const {
    sinon,
    expect
} = require('./price_fetcher.test.js');
const PriceFetcher = require('../../../../../src/oracle/price_fetcher');
const { summarizeSourceLiveness } = require(
    '../../../../../src/oracle/price_fetcher/source_liveness.js'
);
const { getLogger } = require('../../../../../src/observability');

function prices(value) {
    return Object.fromEntries(PriceFetcher.getCoinPairs().map(pair => [pair, value]));
}

function stubSources(fetcher, values) {
    sinon.stub(fetcher, 'fetchFromCoinGecko').resolves(values.coingecko);
    sinon.stub(fetcher, 'fetchFromKraken').resolves(values.kraken);
    sinon.stub(fetcher, 'fetchFromCoinbase').resolves(values.coinbase);
    if (Object.prototype.hasOwnProperty.call(values, 'coinmarketcap')) {
        sinon.stub(fetcher, 'fetchFromCoinMarketCap').resolves(values.coinmarketcap);
    }
}

describe('PriceFetcher source liveness', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('classifies fulfilled, rejected, null and empty source results', function () {
        const keys = ['fulfilled', 'rejected', 'null', 'empty'];
        const sourceResults = [
            { status: 'fulfilled', value: { 'BTC/USD': 1 } },
            { status: 'rejected', reason: new Error('down') },
            { status: 'fulfilled', value: null },
            { status: 'fulfilled', value: {} }
        ];

        expect(summarizeSourceLiveness(keys, sourceResults, ['BTC/USD'])).to.deep.equal({
            live: ['fulfilled'],
            dead: ['rejected', 'null', 'empty']
        });
    });

    it('records the keyless source list when CMC is not configured', async function () {
        const fetcher = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0 });
        expect(fetcher.lastSourceLiveness).to.equal(null);
        stubSources(fetcher, { coingecko: prices(1), kraken: prices(2), coinbase: prices(3) });

        await fetcher.fetchPrices();

        expect(fetcher.lastSourceLiveness.live).to.deep.equal(['coingecko', 'kraken', 'coinbase']);
        expect(fetcher.lastSourceLiveness.dead).to.deep.equal([]);
        expect(fetcher.lastSourceLiveness.at).to.be.a('number');
    });

    it('appends the CMC key when CMC is configured', async function () {
        const fetcher = new PriceFetcher({
            PRICE_FETCH_JITTER_MS: 0,
            COINMARKETCAP_API_KEY: 'key'
        });
        stubSources(fetcher, {
            coingecko: prices(1), kraken: prices(2), coinbase: prices(3), coinmarketcap: prices(4)
        });

        await fetcher.fetchPrices();

        expect(fetcher.lastSourceLiveness.live).to.deep.equal([
            'coingecko', 'kraken', 'coinbase', 'coinmarketcap'
        ]);
        expect(fetcher.lastSourceLiveness.dead).to.deep.equal([]);
    });

    it('names live and dead sources in the low-liveness warning', async function () {
        const fetcher = new PriceFetcher({ PRICE_FETCH_JITTER_MS: 0 });
        sinon.stub(fetcher, 'fetchFromCoinGecko').resolves(prices(1));
        sinon.stub(fetcher, 'fetchFromKraken').rejects(new Error('down'));
        sinon.stub(fetcher, 'fetchFromCoinbase').resolves(null);
        const warn = sinon.stub(getLogger(), 'warn');
        sinon.stub(Date, 'now').returns(123456789);

        await fetcher.fetchPrices();

        const healthWarning = warn.getCalls().map(call => call.args[0])
            .find(message => message.includes('live price source(s) this round'));
        expect(healthWarning).to.include('live: coingecko; dead: kraken, coinbase');
        expect(fetcher.lastSourceLiveness).to.deep.equal({
            live: ['coingecko'],
            dead: ['kraken', 'coinbase'],
            at: 123456789
        });
    });
});
