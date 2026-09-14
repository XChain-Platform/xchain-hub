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
 * XChain Hub - Price Fetcher: one method per upstream
 *
 * Each fetcher jitters, calls the shell's fetchWithRetry (where `axios` lives,
 * because that is what the suites stub), parses, and returns a
 * { COIN/FIAT: number } map or null. Every one fails SOFT: a source that errors
 * must never drop the sources that answered.
 *
 ********************************************************************/

'use strict';

const { PRICE_MAX } = require('../../constants.js');
const { COINGECKO_IDS, CMC_SYMBOLS, KRAKEN_PAIRS,
        krakenResultCandidates, COINS, FIATS } = require('./pairs.js');
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

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

        // Initial jitter (0-PRICE_FETCH_JITTER_MS) so multiple hubs behind the same
        // NAT don't collide on CoinGecko's per-second rate limit at the start of each round.
        if (this.fetchJitterMs > 0)
            await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * this.fetchJitterMs)));

        let response;
        try {
            response = await this.fetchWithRetry(url, { timeout: this.timeout, headers });
        } catch (err) {
            logger.warn('CoinGecko fetch failed after retries: ' + (err ? err.message : 'unknown error'));
            return null;
        }

        let data = response.data;
        let prices = {};
        let rejected = [];
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
                } else {
                    rejected.push(this.constructor.rejectSample(coin + '/' + fiat, raw));
                }
            }
        }
        this.reportBoundRejects('coingecko', 'CoinGecko', rejected);
        return prices;
    },

    // Fetch all coin/fiat pairs from Coinbase's keyless exchange-rates endpoint,
    // retrying on 429/503 with the same backoff+jitter as the other sources.
    //
    // ONE REQUEST PER COIN: /v2/exchange-rates takes a single `currency` and prices
    // it in ~640 others, so three calls cover all 36 pairs. The only source here
    // costing more than one round trip, and the only free one covering every pair.
    //
    // On fiats with no traded market this is likely COIN/USD times an FX rate, and
    // CoinGecko may derive its own the same way: the source COUNT overstates
    // independence on those pairs.
    //
    // Returns: { 'BTC/USD': number, ..., 'DOGE/KRW': number } or null
    async fetchFromCoinbase() {
        // Same startup-collision jitter as CoinGecko: several hubs behind one NAT
        // would otherwise hit this endpoint in lockstep every round.
        if (this.fetchJitterMs > 0)
            await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * this.fetchJitterMs)));

        let prices = {};
        let rejected = [];
        let anyCoinSucceeded = false;

        for (let coin of COINS) {
            let url = 'https://api.coinbase.com/v2/exchange-rates?currency=' + encodeURIComponent(coin);
            let response;
            try {
                response = await this.fetchWithRetry(url, { timeout: this.timeout, headers: {} });
            } catch (err) {
                // Per-coin failure only. One coin erroring must not discard the two
                // that answered, the same fail-soft rule the other sources follow.
                logger.warn('Coinbase fetch failed after retries for ' + coin + ': ' +
                             (err ? err.message : 'unknown error'));
                continue;
            }
            anyCoinSucceeded = true;

            let rates = response.data && response.data.data && response.data.data.rates;
            if (!rates) continue;
            for (let fiat of FIATS) {
                let raw = rates[fiat];
                if (raw === undefined || raw === null) continue;
                let val = parseFloat(raw);
                if (Number.isFinite(val) && val > 0 && val < PRICE_MAX) {
                    prices[coin + '/' + fiat] = val;
                } else {
                    rejected.push(this.constructor.rejectSample(coin + '/' + fiat, raw));
                }
            }
        }

        this.reportBoundRejects('coinbase', 'Coinbase', rejected);
        // null, not {}, when every coin failed: fetchPrices counts a source as live
        // only if it contributed a price, and null keeps that distinction honest.
        return anyCoinSucceeded ? prices : null;
    },

    // Fetch coin/fiat pairs from Kraken's keyless public ticker in a single request,
    // retrying on 429/503 with the same backoff+jitter as CoinGecko. Kraken is a
    // second uncorrelated keyless upstream so every hub has 2 sources by default.
    // Only the pairs Kraken lists are requested (KRAKEN_PAIRS); the
    // others stay CoinGecko-only. Mirrors fetchFromCoinGecko's fetch+parse+normalize
    // shape: jitter, fetchWithRetry, then a { 'COIN/FIAT': number } map (or null).
    // Returns: { 'BTC/USD': number, ... } for the listed pairs, or null on failure.
    async fetchFromKraken() {
        let pairCodes = Object.values(KRAKEN_PAIRS).join(',');
        let url       = 'https://api.kraken.com/0/public/Ticker?pair=' + pairCodes;

        // Initial jitter (0-PRICE_FETCH_JITTER_MS) so multiple hubs behind the same
        // NAT don't collide on Kraken's per-IP rate limit at the start of each round
        // (mirrors fetchFromCoinGecko).
        if (this.fetchJitterMs > 0)
            await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * this.fetchJitterMs)));

        let response;
        try {
            response = await this.fetchWithRetry(url, { timeout: this.timeout });
        } catch (err) {
            logger.warn('Kraken fetch failed after retries: ' + (err ? err.message : 'unknown error'));
            return null;
        }

        // Kraken wraps everything in { error: [...], result: {...} }. A non-empty
        // error array means the whole batch was rejected (e.g. an unknown pair);
        // treat it as a failed round for this source rather than a partial parse.
        let body = response.data;
        if (!body || (Array.isArray(body.error) && body.error.length > 0)) {
            logger.warn('Kraken returned error: ' + (body && body.error ? JSON.stringify(body.error) : 'no body'));
            return null;
        }
        let result = body.result;
        if (!result) return null;

        let prices = {};
        let rejected = [];
        for (let pair of Object.keys(KRAKEN_PAIRS)) {
            let altname = KRAKEN_PAIRS[pair];
            // Kraken's result key may be the request altname or a canonical X/Z form;
            // probe each candidate and take the first present.
            let entry = null;
            for (let key of krakenResultCandidates(altname)) {
                if (result[key]) { entry = result[key]; break; }
            }
            // 'c' is last-trade-closed [price, lotVolume]; index 0 is the price.
            // A null last-trade price is an absence, not a bound rejection (same
            // reading as the CoinGecko and CoinMarketCap loops); it was already
            // dropped by the bound, so no price behavior changes.
            if (!entry || !Array.isArray(entry.c) || entry.c[0] === undefined || entry.c[0] === null) continue;
            let val = parseFloat(entry.c[0]);
            if (Number.isFinite(val) && val > 0 && val < PRICE_MAX) {
                prices[pair] = val;
            } else {
                rejected.push(this.constructor.rejectSample(pair, entry.c[0]));
            }
        }
        this.reportBoundRejects('kraken', 'Kraken', rejected);
        return prices;
    },

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
            response = await this.fetchWithRetry(url, {
                timeout: this.timeout,
                headers: { 'X-CMC_PRO_API_KEY': this.coinmarketcapApiKey }
            });
        } catch (err) {
            this.noteCoinMarketCapFailure(err);
            return null;
        }
        this._cmc400Count = 0;  // reset on success

        let data = response.data && response.data.data;
        if (!data) return null;

        let prices = {};
        let rejected = [];
        for (let coin of COINS) {
            let symbol  = CMC_SYMBOLS[coin];
            let cmcData = data[symbol];
            if (!cmcData || !cmcData.quote) continue;
            for (let fiat of FIATS) {
                let cmcQuote = cmcData.quote[fiat];
                // An explicit null price is an ABSENCE, not a bound rejection: CMC
                // returns null for conversions the configured plan does not cover, so
                // counting it would fire the warn on every fetch of a healthy free-plan
                // hub and train the operator to ignore the real signal. Skipped here for
                // the same reason CoinGecko's loop skips null above; it was already
                // dropped by the bound, so no price behavior changes.
                if (!cmcQuote || cmcQuote.price === undefined || cmcQuote.price === null) continue;
                let val = parseFloat(cmcQuote.price);
                if (Number.isFinite(val) && val > 0 && val < PRICE_MAX) {
                    prices[coin + '/' + fiat] = val;
                } else {
                    rejected.push(this.constructor.rejectSample(coin + '/' + fiat, cmcQuote.price));
                }
            }
        }
        this.reportBoundRejects('coinmarketcap', 'CoinMarketCap', rejected);
        return prices;
    },


    // A persistent 400 most likely means the operator's CMC plan does not support
    // multi-currency convert, which is a different operator action from a transient
    // failure, so the two are counted and reported apart.
    noteCoinMarketCapFailure(err) {
        let status = err && err.response && err.response.status;
        if (status === 400) {
            this._cmc400Count++;
            if (this._cmc400Count >= this._cmc400AlertThreshold) {
                logger.error(
                    'CoinMarketCap has returned HTTP 400 for ' + this._cmc400Count + ' consecutive rounds. ' +
                    'The configured COINMARKETCAP_API_KEY likely does not support multi-currency convert ' +
                    '(a paid plan feature). Price oracle is running on CoinGecko only. ' +
                    'Upgrade your CMC plan or remove COINMARKETCAP_API_KEY to silence this alert.'
                );
            }
            return;
        }
        logger.warn('CoinMarketCap fetch failed after retries: ' + (err ? err.message : 'unknown error'));
    }
};
