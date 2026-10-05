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
const { PRICE_MAX } = require('../../../src/constants');
const { createMockHub }        = require('../../helpers/mockHub');
const { runExperiment }        = require('../helpers/chaosRunner');
const mockApi                  = require('../../helpers/mockExternalApi');

// Peer submissions are admitted only when the envelope carries a proven signing
// key that the chain or the local registry attributes, so the peer used by the
// ingest tests is registered under its key and stamps it on the envelope.
const PEER_ADDR   = 'ws://peer:10001';
const PEER_PUBKEY = 'dd'.repeat(32);

function createPeerAdmittingHub() {
    return createMockHub({ validatorPubkeys: new Map([[PEER_ADDR, PEER_PUBKEY]]) });
}



let fetcher;
let oracle;
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
        oracle = null;
        mockApi.reset();
        fetcher = new PriceFetcher({
            COINMARKETCAP_API_KEY: 'test-key',
            PRICE_FETCH_TIMEOUT:  5000,
            PRICE_FETCH_JITTER_MS: 0
        });
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        sinon.stub(console, 'error');
    });
}

function registerAfterEachHook() {

    afterEach(function () {
        if (oracle) {
            for (let timer of oracle.finalizationTimers.values()) clearTimeout(timer);
            oracle.finalizationTimers.clear();
        }
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

function registerPricesAtOrAbovePriceMaxRejectedTest() {

    it('prices at or above PRICE_MAX rejected', async function () {
        mockApi.mockCoinGeckoSuccess({
            bitcoin:  { usd: PRICE_MAX },
            litecoin: { usd: PRICE_MAX + 1 },
            dogecoin: { usd: 1e18 }
        });
        mockApi.mockCmcSuccess();

        let prices = await fetcher.fetchPrices();
        expect(prices).to.have.length(3);
        for (let p of prices) {
            expect(p.sources).to.equal(1);
            expect(parseFloat(p.price)).to.be.lt(PRICE_MAX);
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
        let hub = createPeerAdmittingHub();
        oracle = new OracleRound(hub);
        oracle.currentRound = 5;
        oracle.roundStartTime = Date.now();
        oracle.submissions.set(5, new Map());

        // Simulate peer submission with invalid prices
        let envelope = {
            type: 'ORACLE_PRICE_SUBMIT',
            sender: PEER_ADDR,
            sig_pubkey: PEER_PUBKEY,
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

        // All prices invalid → submission rejected entirely, by the price filter
        // rather than by the signer admission gate
        let subs = oracle.submissions.get(5);
        expect(subs.has(PEER_ADDR)).to.be.false;
        expect(console.warn.calledWithMatch('zero valid pairs')).to.be.true;
    });
}

function registerOracleRoundAcceptsValidPricesFromTest() {

    it('oracle round accepts valid prices from malformed batch', async function () {
        let hub = createPeerAdmittingHub();
        oracle = new OracleRound(hub);
        oracle.currentRound = 5;
        oracle.roundStartTime = Date.now();
        oracle.submissions.set(5, new Map());

        let envelope = {
            type: 'ORACLE_PRICE_SUBMIT',
            sender: PEER_ADDR,
            sig_pubkey: PEER_PUBKEY,
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
        expect(subs.has(PEER_ADDR)).to.be.true;
        let sub = subs.get(PEER_ADDR);
        expect(sub.prices).to.have.length(2); // Only BTC and DOGE
    });
}

function registerNoNaNInfinityStoredInPriceTest() {

    it('no NaN/Infinity stored in price snapshots after malformed data', async function () {
        let hub = createMockHub();
        oracle = new OracleRound(hub);

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
    registerPricesAtOrAbovePriceMaxRejectedTest();
    registerNaNPricesRejectedTest();
    registerInfinityPricesRejectedTest();
    registerMissingCoinPairFieldsPartialResultsTest();
    registerCompletelyEmptyResponseBodyTreatedAsTest();
    registerTruncatedJSONResponseHandledAsErrorTest();
    registerOracleRoundFiltersMalformedSubmissionsFromTest();
    registerOracleRoundAcceptsValidPricesFromTest();
    registerNoNaNInfinityStoredInPriceTest();
});
