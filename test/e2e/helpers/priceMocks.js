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

const nock = require('nock');

const COINGECKO_BASE = 'https://api.coingecko.com';
const CMC_BASE       = 'https://pro-api.coinmarketcap.com';

const DEFAULT_COINGECKO = {
    bitcoin:  { usd: 100000 },
    litecoin: { usd: 85 },
    dogecoin: { usd: 0.15 }
};

const DEFAULT_CMC = {
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

/**
 * Mock CoinGecko to return prices (repeatable, persists across multiple fetches).
 */
function mockCoinGeckoSuccess(prices, times) {
    return nock(COINGECKO_BASE)
        .get('/api/v3/simple/price')
        .query(true)
        .times(times || 10)
        .reply(200, prices || DEFAULT_COINGECKO);
}

function mockCoinGeckoError(statusCode, times) {
    return nock(COINGECKO_BASE)
        .get('/api/v3/simple/price')
        .query(true)
        .times(times || 10)
        .reply(statusCode || 503);
}

/**
 * Mock CoinMarketCap to return prices (repeatable).
 */
function mockCmcSuccess(prices, times) {
    return nock(CMC_BASE)
        .get('/v1/cryptocurrency/quotes/latest')
        .query(true)
        .times(times || 10)
        .reply(200, prices || DEFAULT_CMC);
}

function mockCmcError(statusCode, times) {
    return nock(CMC_BASE)
        .get('/v1/cryptocurrency/quotes/latest')
        .query(true)
        .times(times || 10)
        .reply(statusCode || 503);
}

module.exports = {
    setup, teardown, reset,
    mockCoinGeckoSuccess, mockCoinGeckoError,
    mockCmcSuccess, mockCmcError,
    DEFAULT_COINGECKO, DEFAULT_CMC
};
