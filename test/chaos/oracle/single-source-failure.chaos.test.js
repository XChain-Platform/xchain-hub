'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const nock       = require('nock');
const PriceFetcher = require('../../../src/PriceFetcher');
const OracleRound  = require('../../../src/OracleRound');
const { createMockHub }        = require('../../helpers/mockHub');
const { SAMPLE_PRICES }        = require('../../helpers/fixtures');
const { runExperiment }        = require('../helpers/chaosRunner');
const mockApi                  = require('../../helpers/mockExternalApi');

describe('Chaos: Single Price Source Failure (API-1)', function () {
    this.timeout(10000);

    before(function () {
        mockApi.setup();
    });

    after(function () {
        mockApi.teardown();
    });

    beforeEach(function () {
        mockApi.reset();
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('CoinGecko 500 → uses CoinMarketCap data only', async function () {
        let fetcher = new PriceFetcher({
            COINMARKETCAP_API_KEY: 'test-key',
            PRICE_FETCH_TIMEOUT:  5000
        });

        await runExperiment({
            name: 'Single source failure — CoinGecko 500',

            inject: () => {
                mockApi.mockCoinGeckoError(500);
                mockApi.mockCmcSuccess();
            },

            observe: async () => {
                let prices = await fetcher.fetchPrices();
                expect(prices).to.have.length(3);

                // All prices should come from CMC (sources=1 per pair)
                for (let p of prices) {
                    expect(p.sources).to.equal(1);
                    let val = parseFloat(p.price);
                    expect(val).to.be.gt(0);
                    expect(val).to.be.lt(10000000);
                }

                // Warning should be logged for CoinGecko
                expect(console.warn.calledWithMatch('CoinGecko')).to.be.true;

                return prices;
            }
        });
    });

    it('CoinMarketCap 503 → uses CoinGecko data only', async function () {
        let fetcher = new PriceFetcher({
            COINMARKETCAP_API_KEY: 'test-key',
            PRICE_FETCH_TIMEOUT:  5000
        });

        await runExperiment({
            name: 'Single source failure — CMC 503',

            inject: () => {
                mockApi.mockCoinGeckoSuccess();
                mockApi.mockCmcError(503);
            },

            observe: async () => {
                let prices = await fetcher.fetchPrices();
                expect(prices).to.have.length(3);

                for (let p of prices) {
                    expect(p.sources).to.equal(1);
                }

                return prices;
            }
        });
    });

    it('CoinGecko 429 rate limited → degrades gracefully', async function () {
        let fetcher = new PriceFetcher({
            COINMARKETCAP_API_KEY: 'test-key',
            PRICE_FETCH_TIMEOUT:  5000
        });

        mockApi.mockCoinGeckoError(429);
        mockApi.mockCmcSuccess();

        let prices = await fetcher.fetchPrices();
        expect(prices).to.have.length(3);
        for (let p of prices) {
            expect(p.sources).to.equal(1);
        }
    });

    it('source failure does not affect oracle round broadcast', async function () {
        let hub = createMockHub();
        let oracle = new OracleRound(hub);

        // Stub the price fetcher to simulate partial failure
        sinon.stub(oracle.priceFetcher, 'fetchPrices').resolves([
            { coinPair: 'BTC/USD', price: '100000.00000000', sources: 1 },
            { coinPair: 'LTC/USD', price: '85.00000000',     sources: 1 },
            { coinPair: 'DOGE/USD', price: '0.15000000',     sources: 1 }
        ]);

        await oracle._executeRound();

        expect(hub._peerManager.broadcast.calledOnce).to.be.true;
        let broadcastArgs = hub._peerManager.broadcast.getCall(0).args;
        expect(broadcastArgs[0]).to.equal('ORACLE_PRICE_SUBMIT');
        expect(broadcastArgs[1].prices).to.have.length(3);
        expect(broadcastArgs[1].prices[0].sources).to.equal(1);
    });

    it('recovery: both sources return → source count restores to 2', async function () {
        let fetcher = new PriceFetcher({
            COINMARKETCAP_API_KEY: 'test-key',
            PRICE_FETCH_TIMEOUT:  5000
        });

        // Phase 1: CoinGecko down
        mockApi.mockCoinGeckoError(500);
        mockApi.mockCmcSuccess();

        let degraded = await fetcher.fetchPrices();
        expect(degraded[0].sources).to.equal(1);

        // Phase 2: CoinGecko recovers
        mockApi.reset();
        mockApi.mockCoinGeckoSuccess();
        mockApi.mockCmcSuccess();

        let recovered = await fetcher.fetchPrices();
        expect(recovered[0].sources).to.equal(2);
    });
});
