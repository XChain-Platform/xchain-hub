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
 * Supports 3 coins × 12 fiat currencies = 36 pairs per round.
 * Validators get all 12 fiats per coin in a single API call.
 *
 ********************************************************************/

const axios = require('axios');

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

        let maxAttempts = 3;
        let lastErr     = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                let response = await axios.get(url, { timeout: this.timeout, headers });
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
                        if (Number.isFinite(val) && val > 0 && val < 1e12) {
                            prices[coin + '/' + fiat] = val;
                        }
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

    // Fetch all coin/fiat pairs from CoinMarketCap (requires API key)
    // CMC supports `convert` as a comma-separated list of fiat currencies
    // Returns: { 'BTC/USD': number, ..., 'DOGE/KRW': number } or null
    async fetchFromCoinMarketCap() {
        if (!this.coinmarketcapApiKey) return null;

        let symbols = COINS.map(c => CMC_SYMBOLS[c]).join(',');
        let convert = FIATS.join(',');
        let url     = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=' + symbols + '&convert=' + convert;

        try {
            let response = await axios.get(url, {
                timeout: this.timeout,
                headers: { 'X-CMC_PRO_API_KEY': this.coinmarketcapApiKey }
            });
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
                    if (Number.isFinite(val) && val > 0 && val < 1e12) {
                        prices[coin + '/' + fiat] = val;
                    }
                }
            }
            return prices;
        } catch (err) {
            console.warn('CoinMarketCap fetch failed:', err);
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

    // Expose the supported pair list (used by OracleConsensus._storeSkippedRound and tests)
    static getCoinPairs() {
        return COIN_PAIRS.slice();
    }
}

module.exports = PriceFetcher;
