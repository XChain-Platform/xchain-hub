'use strict';

const nock = require('nock');

const COINGECKO_BASE = 'https://api.coingecko.com';
const CMC_BASE       = 'https://pro-api.coinmarketcap.com';

const DEFAULT_COINGECKO_RESPONSE = {
    bitcoin:  { usd: 100000 },
    litecoin: { usd: 85 },
    dogecoin: { usd: 0.15 }
};

const DEFAULT_CMC_RESPONSE = {
    data: {
        BTC:  { quote: { USD: { price: 100200 } } },
        LTC:  { quote: { USD: { price: 86 } } },
        DOGE: { quote: { USD: { price: 0.155 } } }
    }
};

function setup() {
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
}

function teardown() {
    nock.cleanAll();
    nock.enableNetConnect();
}

function reset() {
    nock.cleanAll();
}

function mockCoinGeckoSuccess(prices) {
    return nock(COINGECKO_BASE)
        .get('/api/v3/simple/price')
        .query(true)
        .reply(200, prices || DEFAULT_COINGECKO_RESPONSE);
}

function mockCoinGeckoError(statusCode) {
    return nock(COINGECKO_BASE)
        .get('/api/v3/simple/price')
        .query(true)
        .reply(statusCode || 503);
}

function mockCoinGeckoTimeout(delayMs) {
    return nock(COINGECKO_BASE)
        .get('/api/v3/simple/price')
        .query(true)
        .delayConnection(delayMs || 15000)
        .reply(200, DEFAULT_COINGECKO_RESPONSE);
}

function mockCmcSuccess(prices) {
    return nock(CMC_BASE)
        .get('/v1/cryptocurrency/quotes/latest')
        .query(true)
        .reply(200, prices || DEFAULT_CMC_RESPONSE);
}

function mockCmcError(statusCode) {
    return nock(CMC_BASE)
        .get('/v1/cryptocurrency/quotes/latest')
        .query(true)
        .reply(statusCode || 503);
}

module.exports = {
    setup, teardown, reset,
    mockCoinGeckoSuccess, mockCoinGeckoError, mockCoinGeckoTimeout,
    mockCmcSuccess, mockCmcError,
    DEFAULT_COINGECKO_RESPONSE, DEFAULT_CMC_RESPONSE
};
