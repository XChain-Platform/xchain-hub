/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - Price Fetcher
 *
 * Fetches cryptocurrency prices from multiple external APIs and
 * computes a local median for each coin pair. Used by the oracle
 * round system to generate price submissions.
 *
 * Supports 3 coins × 12 fiat currencies = 36 pairs per round.
 * Validators get all 12 fiats per coin in a single API call.
 *
 ********************************************************************/

const axios = require('axios');

const { PRICE_MAX } = require('./constants.js');
const bcmath = require('./bcmath.js');

// CoinGecko coin IDs for the 3 supported coins
const COINGECKO_IDS = { 'BTC': 'bitcoin', 'LTC': 'litecoin', 'DOGE': 'dogecoin' };

// CoinMarketCap symbols for the 3 supported coins
const CMC_SYMBOLS = { 'BTC': 'BTC', 'LTC': 'LTC', 'DOGE': 'DOGE' };

// Supported coins (3) and fiat currencies (12)
const COINS = ['BTC', 'LTC', 'DOGE'];
const FIATS = ['USD', 'CAD', 'AUD', 'MXN', 'GBP', 'JPY', 'CNY', 'CHF', 'BRL', 'INR', 'EUR', 'KRW'];

// Build all 36 coin pairs (BTC/USD, BTC/CAD, ..., DOGE/KRW)
const COIN_PAIRS = [];
for (let coin of COINS) {
    for (let fiat of FIATS) {
        COIN_PAIRS.push(coin + '/' + fiat);
    }
}

class PriceFetcher {

    constructor(config) {
        this.coingeckoApiKey     = config.COINGECKO_API_KEY || '';
        this.coinmarketcapApiKey = config.COINMARKETCAP_API_KEY || '';
        this.timeout             = config.PRICE_FETCH_TIMEOUT || 10000;

        // Count of consecutive rounds where CMC returned HTTP 400. Resets on
        // any successful CMC fetch. A persistent 400 most likely means the
        // operator's CMC plan does not support multi-currency convert; once
        // CMC_400_ALERT_THRESHOLD consecutive failures accumulate the hub logs
        // a high-visibility warning so the operator knows they have one source,
        // not two, and can upgrade their plan or remove the key.
        this._cmc400Count          = 0;
        this._cmc400AlertThreshold = parseInt(config.CMC_400_ALERT_THRESHOLD) || 5;
    }

    // Fetch prices from all configured sources and return the local median per coin pair
    // Returns: [{ coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }, ...] for all 36 pairs
    async fetchPrices() {
        let results = {};
        for (let pair of COIN_PAIRS) {
            results[pair] = [];
        }

        // Fetch from all sources in parallel
        let fetches = [this.fetchFromCoinGecko()];
        if (this.coinmarketcapApiKey) {
            fetches.push(this.fetchFromCoinMarketCap());
        }

        let sourceResults = await Promise.allSettled(fetches);

        for (let result of sourceResults) {
            if (result.status === 'fulfilled' && result.value) {
                for (let pair of COIN_PAIRS) {
                    if (result.value[pair] !== undefined && result.value[pair] !== null) {
                        results[pair].push(result.value[pair]);
                    }
                }
            }
        }

        // Compute median for each pair
        let prices = [];
        for (let pair of COIN_PAIRS) {
            let values = results[pair];
            if (values.length > 0) {
                let median = this._median(values);   // already an 8dp bignumber string
                prices.push({
                    coinPair: pair,
                    price:    median,
                    sources:  values.length
                });
            }
        }

        return prices;
    }

    // Perform an HTTP GET with up to 3 attempts, retrying only on HTTP 429/503
    // with exponential backoff + jitter (attempt 1 → 1-3s, attempt 2 → 2-6s).
    // Non-retryable errors fail immediately. Resolves with the axios response;
    // rejects with the last error once every attempt is exhausted. Shared by both
    // price-source fetchers so each gets identical rate-limit resilience.
    async _fetchWithRetry(url, options) {
        let maxAttempts = 3;
        let lastErr     = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await axios.get(url, options);
            } catch (err) {
                lastErr = err;
                let status = err.response && err.response.status;
                if (status === 400) {
                    // 400 is non-retryable and typically indicates a plan-tier
                    // incompatibility (e.g. multi-currency /convert requires a paid
                    // CMC plan). Log a distinct warning so operators can distinguish
                    // this from a transient network error and upgrade their plan.
                    console.warn('CoinMarketCap returned 400 (possible plan-tier limit: multi-currency convert may require a paid plan). Skipping CMC this round.');
                    break;
                }
                let retryable = status === 429 || status === 503;
                if (retryable && attempt < maxAttempts) {
                    // Backoff with jitter: attempt 1 → 1-3s, attempt 2 → 2-6s
                    let baseMs   = 1000 * attempt;
                    let jitterMs = Math.floor(Math.random() * 2000 * attempt);
                    await new Promise(resolve => setTimeout(resolve, baseMs + jitterMs));
                    continue;
                }
                break;
            }
        }
        throw lastErr;
    }

    // Fetch all coin/fiat pairs from CoinGecko in a single request, retrying on
    // 429/503 with exponential backoff + jitter. Multiple hubs behind the same NAT
    // hit CoinGecko's per-IP limit simultaneously on synchronized startup; jittered
    // retries spread the attempts across a wider window so they succeed individually.
    // Returns: { 'BTC/USD': number, 'BTC/CAD': number, ..., 'DOGE/KRW': number } or null
    async fetchFromCoinGecko() {
        let ids  = COINS.map(c => COINGECKO_IDS[c]).join(',');
        let vs   = FIATS.map(f => f.toLowerCase()).join(',');
        let url  = 'https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=' + vs;

        let headers = {};
        if (this.coingeckoApiKey) {
            headers['x-cg-demo-api-key'] = this.coingeckoApiKey;
        }

        // Initial jitter (0-3000ms) so multiple hubs behind the same NAT don't
        // collide on CoinGecko's per-second rate limit at the start of each round.
        await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 3000)));

        let response;
        try {
            response = await this._fetchWithRetry(url, { timeout: this.timeout, headers });
        } catch (err) {
            console.warn('CoinGecko fetch failed after retries: ' + (err ? err.message : 'unknown error'));
            return null;
        }

        let data = response.data;
        let prices = {};
        for (let coin of COINS) {
            let cgId   = COINGECKO_IDS[coin];
            let cgData = data && data[cgId];
            if (!cgData) continue;
            for (let fiat of FIATS) {
                let raw = cgData[fiat.toLowerCase()];
                if (raw === undefined || raw === null) continue;
                let val = parseFloat(raw);
                if (Number.isFinite(val) && val > 0 && val < PRICE_MAX) {
                    prices[coin + '/' + fiat] = val;
                }
            }
        }
        return prices;
    }

    // Fetch all coin/fiat pairs from CoinMarketCap (requires API key), retrying on
    // 429/503 with the same exponential backoff + jitter as CoinGecko so a transient
    // CMC rate-limit doesn't silently drop the round to a single source.
    // CMC supports `convert` as a comma-separated list of fiat currencies
    // Returns: { 'BTC/USD': number, ..., 'DOGE/KRW': number } or null
    async fetchFromCoinMarketCap() {
        if (!this.coinmarketcapApiKey) return null;

        let symbols = COINS.map(c => CMC_SYMBOLS[c]).join(',');
        let convert = FIATS.join(',');
        let url     = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=' + symbols + '&convert=' + convert;

        let response;
        try {
            response = await this._fetchWithRetry(url, {
                timeout: this.timeout,
                headers: { 'X-CMC_PRO_API_KEY': this.coinmarketcapApiKey }
            });
        } catch (err) {
            let status = err && err.response && err.response.status;
            if (status === 400) {
                this._cmc400Count++;
                if (this._cmc400Count >= this._cmc400AlertThreshold) {
                    console.error(
                        'CoinMarketCap has returned HTTP 400 for ' + this._cmc400Count + ' consecutive rounds. ' +
                        'The configured COINMARKETCAP_API_KEY likely does not support multi-currency convert ' +
                        '(a paid plan feature). Price oracle is running on CoinGecko only. ' +
                        'Upgrade your CMC plan or remove COINMARKETCAP_API_KEY to silence this alert.'
                    );
                }
            } else {
                console.warn('CoinMarketCap fetch failed after retries: ' + (err ? err.message : 'unknown error'));
            }
            return null;
        }
        this._cmc400Count = 0;  // reset on success

        let data = response.data && response.data.data;
        if (!data) return null;

        let prices = {};
        for (let coin of COINS) {
            let symbol  = CMC_SYMBOLS[coin];
            let cmcData = data[symbol];
            if (!cmcData || !cmcData.quote) continue;
            for (let fiat of FIATS) {
                let cmcQuote = cmcData.quote[fiat];
                if (!cmcQuote || cmcQuote.price === undefined) continue;
                let val = parseFloat(cmcQuote.price);
                if (Number.isFinite(val) && val > 0 && val < PRICE_MAX) {
                    prices[coin + '/' + fiat] = val;
                }
            }
        }
        return prices;
    }

    // Compute median of a numeric array, returned as an 8-decimal bignumber string
    // (mathjs/bcmath per the platform mandate; the even-length midpoint average is
    // done in bignumber so the submitted local price carries no float/.toFixed artifact).
    // Ordering uses a float compare (no consensus arithmetic).
    _median(values) {
        if (values.length === 0) return bcmath.bcstr('0', 8);
        let sorted = [...values].sort((a, b) => a - b);
        let mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
            return bcmath.bcstr(bcmath.bcdiv(bcmath.bcadd(String(sorted[mid - 1]), String(sorted[mid]), 8), '2', 8), 8);
        }
        return bcmath.bcstr(String(sorted[mid]), 8);
    }

    // Expose the supported pair list (used by OracleConsensus._storeSkippedRound and tests)
    static getCoinPairs() {
        return COIN_PAIRS.slice();
    }
}

module.exports = PriceFetcher;
