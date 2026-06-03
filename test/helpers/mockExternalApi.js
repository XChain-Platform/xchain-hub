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

// Full 12-fiat fixtures covering all 3 coins × 12 currencies = 36 pairs.
// The DEFAULT_* fixtures above are deliberately USD-only (most tests assert a
// 3-pair result); these FULL_* fixtures exercise the complete multi-fiat parse
// path. Every value is kept strictly below the oracle's price cap (10,000,000)
// so it survives the production validity filter — note this means BTC/KRW and
// BTC/JPY use high-magnitude values near the cap rather than their real-world
// rates (~137M / ~15.7M per BTC), which the cap would otherwise reject. The
// .25 / .5 fractions on the KRW/JPY entries are exactly representable in IEEE-754
// so toFixed(8) is deterministic for the spot-check assertions.
const FULL_COINGECKO_RESPONSE = {
    bitcoin: {
        usd: 100000,   cad: 137000,    aud: 152000,    mxn: 1700000,
        gbp: 79000,    jpy: 8200000.5, cny: 720000,    chf: 89000,
        brl: 510000,   inr: 8300000,   eur: 92000,     krw: 9876543.25
    },
    litecoin: {
        usd: 85,       cad: 116.45,    aud: 129.2,     mxn: 1445,
        gbp: 67.15,    jpy: 13345.5,   cny: 612,       chf: 75.65,
        brl: 433.5,    inr: 7055,      eur: 78.2,      krw: 116450.25
    },
    dogecoin: {
        usd: 0.15,     cad: 0.2055,    aud: 0.228,     mxn: 2.55,
        gbp: 0.1185,   jpy: 23.5,      cny: 1.08,      chf: 0.1335,
        brl: 0.765,    inr: 12.45,     eur: 0.138,     krw: 205.25
    }
};

// Build a matching CMC fixture from the CoinGecko one so both sources report
// identical values — the local median then equals the input and `sources` is 2
// for every pair, keeping multi-fiat assertions deterministic.
const FIATS_UPPER = ['USD', 'CAD', 'AUD', 'MXN', 'GBP', 'JPY', 'CNY', 'CHF', 'BRL', 'INR', 'EUR', 'KRW'];
const COINGECKO_TO_CMC = { bitcoin: 'BTC', litecoin: 'LTC', dogecoin: 'DOGE' };

function buildFullCmcResponse(coingeckoResponse) {
    let data = {};
    for (let coinId of Object.keys(coingeckoResponse)) {
        let symbol = COINGECKO_TO_CMC[coinId];
        let quote  = {};
        for (let fiat of FIATS_UPPER) {
            quote[fiat] = { price: coingeckoResponse[coinId][fiat.toLowerCase()] };
        }
        data[symbol] = { quote };
    }
    return { data };
}

const FULL_CMC_RESPONSE = buildFullCmcResponse(FULL_COINGECKO_RESPONSE);

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
    DEFAULT_COINGECKO_RESPONSE, DEFAULT_CMC_RESPONSE,
    FULL_COINGECKO_RESPONSE, FULL_CMC_RESPONSE
};
