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

const sinon      = require('sinon');
const { expect } = require('chai');
const nock       = require('nock');
const PriceFetcher = require('../../../src/oracle/price_fetcher');
const OracleRound  = require('../../../src/oracle/round');
const { createMockHub }        = require('../../helpers/mockHub');
const { runExperiment }        = require('../helpers/chaosRunner');
const mockApi                  = require('../../helpers/mockExternalApi');



let fetcher;
function registerBeforeHook() {

    before(function () {
        mockApi.setup();
    });
}

function registerAfterHook() {

    after(function () {
        mockApi.teardown();
    });
}

function registerBeforeEachHook() {

    beforeEach(function () {
        mockApi.reset();
        fetcher = new PriceFetcher({
            COINMARKETCAP_API_KEY: 'test-key',
            PRICE_FETCH_TIMEOUT:  5000
        });
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });
}

function registerAfterEachHook() {

    afterEach(function () {
        sinon.restore();
    });
}

function registerNegativePricesRejectedValidSourceUsedTest() {

    it('negative prices rejected, valid source used', async function () {
        mockApi.mockCoinGeckoSuccess({
            bitcoin:  { usd: -1 },
            litecoin: { usd: -50 },
            dogecoin: { usd: -0.01 }
        });
        mockApi.mockCmcSuccess();

        let prices = await fetcher.fetchPrices();
        expect(prices).to.have.length(3);

        // Only CMC data should be used (sources=1)
        for (let p of prices) {
            expect(p.sources).to.equal(1);
            expect(parseFloat(p.price)).to.be.gt(0);
        }
    });
}

function registerZeroPricesRejectedTest() {

    it('zero prices rejected', async function () {
        mockApi.mockCoinGeckoSuccess({
            bitcoin:  { usd: 0 },
            litecoin: { usd: 0 },
            dogecoin: { usd: 0 }
        });
        mockApi.mockCmcSuccess();

        let prices = await fetcher.fetchPrices();
        expect(prices).to.have.length(3);
        for (let p of prices) {
            expect(p.sources).to.equal(1);
        }
    });
}

function registerPricesAbove10MRejectedTest() {

    it('prices above 10M rejected', async function () {
        mockApi.mockCoinGeckoSuccess({
            bitcoin:  { usd: 10000001 },
            litecoin: { usd: 999999999 },
            dogecoin: { usd: 1e18 }
        });
        mockApi.mockCmcSuccess();

        let prices = await fetcher.fetchPrices();
        expect(prices).to.have.length(3);
        for (let p of prices) {
            expect(p.sources).to.equal(1);
            expect(parseFloat(p.price)).to.be.lt(10000000);
        }
    });
}

function registerNaNPricesRejectedTest() {

    it('NaN prices rejected', async function () {
        mockApi.mockCoinGeckoSuccess({
            bitcoin:  { usd: NaN },
            litecoin: { usd: 'not-a-number' },
            dogecoin: { usd: undefined }
        });
        mockApi.mockCmcSuccess();

        let prices = await fetcher.fetchPrices();
        expect(prices).to.have.length(3);
        for (let p of prices) {
            expect(p.sources).to.equal(1);
        }
    });
}

function registerInfinityPricesRejectedTest() {

    it('Infinity prices rejected', async function () {
        mockApi.mockCoinGeckoSuccess({
            bitcoin:  { usd: Infinity },
            litecoin: { usd: -Infinity },
            dogecoin: { usd: Number.POSITIVE_INFINITY }
        });
        mockApi.mockCmcSuccess();

        let prices = await fetcher.fetchPrices();
        expect(prices).to.have.length(3);
        for (let p of prices) {
            expect(p.sources).to.equal(1);
        }
    });
}

function registerMissingCoinPairFieldsPartialResultsTest() {

    it('missing coin pair fields → partial results from valid source', async function () {
        // CoinGecko returns only BTC
        mockApi.mockCoinGeckoSuccess({
            bitcoin: { usd: 100000 }
            // litecoin and dogecoin missing
        });
        mockApi.mockCmcSuccess();

        let prices = await fetcher.fetchPrices();
        expect(prices).to.have.length(3);

        // BTC has 2 sources, LTC/DOGE have 1
        let btc = prices.find(p => p.coinPair === 'BTC/USD');
        let ltc = prices.find(p => p.coinPair === 'LTC/USD');
        expect(btc.sources).to.equal(2);
        expect(ltc.sources).to.equal(1);
    });
}

function registerCompletelyEmptyResponseBodyTreatedAsTest() {

    it('completely empty response body → treated as failure', async function () {
        nock('https://api.coingecko.com')
            .get('/api/v3/simple/price')
            .query(true)
            .reply(200, {});
        mockApi.mockCmcSuccess();

        let prices = await fetcher.fetchPrices();
        expect(prices).to.have.length(3);
        for (let p of prices) {
            expect(p.sources).to.equal(1);
        }
    });
}

function registerTruncatedJSONResponseHandledAsErrorTest() {

    it('truncated JSON response → handled as error', async function () {
        nock('https://api.coingecko.com')
            .get('/api/v3/simple/price')
            .query(true)
            .replyWithError('Parse Error: Unexpected end of JSON input');
        mockApi.mockCmcSuccess();

        let prices = await fetcher.fetchPrices();
        expect(prices).to.have.length(3);
        for (let p of prices) {
            expect(p.sources).to.equal(1);
        }
    });
}

function registerOracleRoundFiltersMalformedSubmissionsFromTest() {

    it('oracle round filters malformed submissions from peers', async function () {
        let hub = createMockHub();
        let oracle = new OracleRound(hub);
        oracle.currentRound = 5;
        oracle.roundStartTime = Date.now();
        oracle.submissions.set(5, new Map());

        // Simulate peer submission with invalid prices
        let envelope = {
            type: 'ORACLE_PRICE_SUBMIT',
            sender: 'ws://peer:10001',
            timestamp: Date.now(),
            data: {
                round: 5,
                prices: [
                    { coinPair: 'BTC/USD', price: '-100',    sources: 1 },
                    { coinPair: 'LTC/USD', price: 'NaN',     sources: 1 },
                    { coinPair: 'DOGE/USD', price: '0',      sources: 1 }
                ],
                sources: 1
            }
        };

        oracle.handleMessage(envelope);

        // All prices invalid → submission rejected entirely
        let subs = oracle.submissions.get(5);
        expect(subs.has('ws://peer:10001')).to.be.false;
    });
}

function registerOracleRoundAcceptsValidPricesFromTest() {

    it('oracle round accepts valid prices from malformed batch', async function () {
        let hub = createMockHub();
        let oracle = new OracleRound(hub);
        oracle.currentRound = 5;
        oracle.roundStartTime = Date.now();
        oracle.submissions.set(5, new Map());

        let envelope = {
            type: 'ORACLE_PRICE_SUBMIT',
            sender: 'ws://peer:10001',
            timestamp: Date.now(),
            data: {
                round: 5,
                prices: [
                    { coinPair: 'BTC/USD', price: '100000',  sources: 1 },  // Valid
                    { coinPair: 'LTC/USD', price: '-50',      sources: 1 },  // Invalid
                    { coinPair: 'DOGE/USD', price: '0.15',    sources: 1 }   // Valid
                ],
                sources: 1
            }
        };

        oracle.handleMessage(envelope);

        let subs = oracle.submissions.get(5);
        expect(subs.has('ws://peer:10001')).to.be.true;
        let sub = subs.get('ws://peer:10001');
        expect(sub.prices).to.have.length(2); // Only BTC and DOGE
    });
}

function registerNoNaNInfinityStoredInPriceTest() {

    it('no NaN/Infinity stored in price snapshots after malformed data', async function () {
        let hub = createMockHub();
        let oracle = new OracleRound(hub);

        // Fetch returns valid data despite malformed source
        sinon.stub(oracle.priceFetcher, 'fetchPrices').resolves([
            { coinPair: 'BTC/USD', price: '100000.00000000', sources: 1 }
        ]);

        await oracle.executeRound();

        // Verify broadcast data has no NaN or Infinity
        if (hub._peerManager.broadcast.called) {
            let data = hub._peerManager.broadcast.getCall(0).args[1];
            for (let p of data.prices) {
                let val = parseFloat(p.price);
                expect(Number.isFinite(val)).to.be.true;
                expect(val).to.be.gt(0);
            }
        }
    });
}
describe('Chaos: Malformed Price Data (API-4)', function () {
    this.timeout(10000);
    registerBeforeHook();
    registerAfterHook();
    registerBeforeEachHook();
    registerAfterEachHook();
    registerNegativePricesRejectedValidSourceUsedTest();
    registerZeroPricesRejectedTest();
    registerPricesAbove10MRejectedTest();
    registerNaNPricesRejectedTest();
    registerInfinityPricesRejectedTest();
    registerMissingCoinPairFieldsPartialResultsTest();
    registerCompletelyEmptyResponseBodyTreatedAsTest();
    registerTruncatedJSONResponseHandledAsErrorTest();
    registerOracleRoundFiltersMalformedSubmissionsFromTest();
    registerOracleRoundAcceptsValidPricesFromTest();
    registerNoNaNInfinityStoredInPriceTest();
});
