/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Hub - Price Fetcher
 *
 * Fetches cryptocurrency prices from multiple external APIs and
 * computes a local median for each coin pair. Used by the oracle
 * round system to generate price submissions.
 *
 ********************************************************************/

const axios = require('axios');

// Coin IDs for each API
const COINGECKO_IDS = { 'BTC/USD': 'bitcoin', 'LTC/USD': 'litecoin', 'DOGE/USD': 'dogecoin' };
const CMC_SYMBOLS   = { 'BTC/USD': 'BTC',     'LTC/USD': 'LTC',      'DOGE/USD': 'DOGE' };

const COIN_PAIRS = ['BTC/USD', 'LTC/USD', 'DOGE/USD'];

class PriceFetcher {

    constructor(config) {
        this.coingeckoApiKey     = config.COINGECKO_API_KEY || '';
        this.coinmarketcapApiKey = config.COINMARKETCAP_API_KEY || '';
        this.timeout             = config.PRICE_FETCH_TIMEOUT || 10000;
    }

    // Fetch prices from all configured sources and return the local median per coin pair
    // Returns: [{ coinPair: 'BTC/USD', price: '100000.00', sources: 2 }, ...]
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
                let median = this._median(values);
                prices.push({
                    coinPair: pair,
                    price:    median.toFixed(8),
                    sources:  values.length
                });
            }
        }

        return prices;
    }

    // Fetch prices from CoinGecko, retrying on 429/503 with exponential backoff
    // and jitter. Multiple hubs behind the same NAT all hit CoinGecko's per-IP
    // limit simultaneously on synchronized startup; jittered retries spread the
    // attempts across a wider window so they succeed individually.
    // Returns: { 'BTC/USD': number, 'LTC/USD': number, 'DOGE/USD': number } or null
    async fetchFromCoinGecko() {
        let ids = Object.values(COINGECKO_IDS).join(',');
        let url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=usd';

        let headers = {};
        if (this.coingeckoApiKey) {
            headers['x-cg-demo-api-key'] = this.coingeckoApiKey;
        }

        // Initial jitter (0-3000ms) so multiple hubs behind the same NAT don't
        // collide on CoinGecko's per-second rate limit at the start of each round.
        await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 3000)));

        let maxAttempts = 3;
        let lastErr     = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                let response = await axios.get(url, { timeout: this.timeout, headers });
                let data = response.data;

                let prices = {};
                for (let [pair, cgId] of Object.entries(COINGECKO_IDS)) {
                    if (data[cgId] && data[cgId].usd !== undefined) {
                        prices[pair] = parseFloat(data[cgId].usd);
                    }
                }
                return prices;
            } catch (err) {
                lastErr = err;
                let status = err.response && err.response.status;
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
        console.warn('CoinGecko fetch failed after ' + maxAttempts + ' attempts: ' + (lastErr ? lastErr.message : 'unknown error'));
        return null;
    }

    // Fetch prices from CoinMarketCap (requires API key)
    // Returns: { 'BTC/USD': number, 'LTC/USD': number, 'DOGE/USD': number } or null
    async fetchFromCoinMarketCap() {
        if (!this.coinmarketcapApiKey) return null;

        let symbols = Object.values(CMC_SYMBOLS).join(',');
        let url = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=' + symbols + '&convert=USD';

        try {
            let response = await axios.get(url, {
                timeout: this.timeout,
                headers: { 'X-CMC_PRO_API_KEY': this.coinmarketcapApiKey }
            });
            let data = response.data.data;

            let prices = {};
            for (let [pair, symbol] of Object.entries(CMC_SYMBOLS)) {
                if (data[symbol] && data[symbol].quote && data[symbol].quote.USD) {
                    prices[pair] = parseFloat(data[symbol].quote.USD.price);
                }
            }
            return prices;
        } catch (err) {
            console.warn('CoinMarketCap fetch failed:', err.message);
            return null;
        }
    }

    // Compute median of a numeric array
    _median(values) {
        if (values.length === 0) return 0;
        let sorted = [...values].sort((a, b) => a - b);
        let mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
            return (sorted[mid - 1] + sorted[mid]) / 2;
        }
        return sorted[mid];
    }
}

module.exports = PriceFetcher;
