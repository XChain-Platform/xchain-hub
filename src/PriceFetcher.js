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
 * Sources, and what each costs:
 *   CoinGecko  keyless, 1 request,  36/36 pairs
 *   Kraken     keyless, 1 request,  17/36 pairs (it lists no others)
 *   Coinbase   keyless, 3 requests, 36/36 pairs (one per coin)
 *   CMC        API KEY, 1 request,  36/36 pairs, billed 12 credits per call
 *              (one per convert-currency), so it is opt-in only.
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

// Kraken public-ticker pairs (keyless). Mapping COIN/FIAT -> Kraken request
// "altname". Kraken errors the WHOLE batch if ANY requested pair is unknown, so
// this set is restricted to the pairs Kraken actually lists for these three coins
// (verified live): Kraken has no MXN/CNY/BRL/INR/KRW markets, and a handful of
// per-coin gaps (LTC/CHF, LTC/CAD, DOGE/CHF, DOGE/JPY). The hub still gets a
// second uncorrelated source on the most-traded fiats; pairs Kraken does not list
// simply fall back to CoinGecko-only for that pair (unchanged from before).
const KRAKEN_PAIRS = {
    'BTC/USD': 'XBTUSD', 'BTC/EUR': 'XBTEUR', 'BTC/GBP': 'XBTGBP', 'BTC/CHF': 'XBTCHF',
    'BTC/AUD': 'XBTAUD', 'BTC/JPY': 'XBTJPY', 'BTC/CAD': 'XBTCAD',
    'LTC/USD': 'LTCUSD', 'LTC/EUR': 'LTCEUR', 'LTC/GBP': 'LTCGBP', 'LTC/AUD': 'LTCAUD', 'LTC/JPY': 'LTCJPY',
    'DOGE/USD': 'XDGUSD', 'DOGE/EUR': 'XDGEUR', 'DOGE/GBP': 'XDGGBP', 'DOGE/AUD': 'XDGAUD', 'DOGE/CAD': 'XDGCAD'
};

// Kraken returns result keys inconsistently: some as the request altname
// (e.g. XBTAUD, LTCGBP, XDGUSD), others in the canonical X/Z-prefixed form
// (e.g. XXBTZUSD, XLTCZEUR). Map a request altname to its canonical asset prefix
// so we can probe both candidate key shapes when reading the response.
const KRAKEN_ALT_TO_CANON = { 'XBT': 'XXBT', 'LTC': 'XLTC', 'XDG': 'XXDG' };

// Given a Kraken request altname (ASSET + 3-char FIAT, e.g. "XBTUSD"), return the
// set of candidate result keys Kraken may use for it (altname, canonical X/Z form,
// and the two intermediate shapes), so the parser is robust to Kraken's mixed
// key naming without a per-pair hardcoded canonical key.
function krakenResultCandidates(altname) {
    let asset      = altname.slice(0, altname.length - 3);
    let fiat       = altname.slice(-3);
    let canonAsset = KRAKEN_ALT_TO_CANON[asset] || asset;
    return [altname, canonAsset + 'Z' + fiat, canonAsset + fiat, asset + 'Z' + fiat];
}

// Supported coins (from the canonical registry) and fiat currencies (12)
const coins = require('./coins');
const COINS = [...coins.ALLOWED_COINS];
const FIATS = ['USD', 'CAD', 'AUD', 'MXN', 'GBP', 'JPY', 'CNY', 'CHF', 'BRL', 'INR', 'EUR', 'KRW'];

// How many offending pairs the aggregated bound-rejection warn names before it
// elides the rest. Enough to identify whether one pair or a whole coin regressed,
// short enough to stay one readable log line.
const BOUND_REJECT_SAMPLE = 5;

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
        // Upper bound of the random pre-fetch sleep that de-synchronizes hubs
        // behind one NAT from a provider's per-IP rate limit. Overridable so
        // tests (mocked providers, timing assertions) can set it to 0.
        this.fetchJitterMs       = (config.PRICE_FETCH_JITTER_MS != null)
            ? parseInt(config.PRICE_FETCH_JITTER_MS) : 3000;

        // Count of consecutive rounds where CMC returned HTTP 400. Resets on
        // any successful CMC fetch. A persistent 400 most likely means the
        // operator's CMC plan does not support multi-currency convert; once
        // CMC_400_ALERT_THRESHOLD consecutive failures accumulate the hub logs
        // a high-visibility warning so the operator knows they have one source,
        // not two, and can upgrade their plan or remove the key.
        this._cmc400Count          = 0;
        this._cmc400AlertThreshold = parseInt(config.CMC_400_ALERT_THRESHOLD) || 5;

        // Cumulative count, per source, of upstream values the (0, PRICE_MAX)
        // ingest bound rejected. Without a signal here a source that starts
        // returning zero or mis-scaled values for SOME pairs stops contributing
        // to those pairs' medians in silence: the pair still publishes at a
        // reduced `sources` count, the liveSources<2 warn in fetchPrices stays
        // quiet (that source is still contributing other pairs), and the
        // total-loss warn fires only when EVERY source dropped the pair and
        // blames the absence rather than the bound. Every sibling rejection site
        // in this pipeline already says it out loud (OracleRound._handleMessage,
        // OracleConsensus._aggregate, XchainPriceSource._entry); this was the
        // last silent one.
        // One entry per source that calls _reportBoundRejects. Coinbase was added to
        // the dispatch after this counter and missed the list, so its first rejection
        // evaluated `undefined + n` and pinned the counter at NaN for the process
        // lifetime, on the source with the widest pair coverage. The accumulator
        // self-initialises now (see _reportBoundRejects), so this list documents the
        // reporting sources rather than gating them.
        this._boundRejects = { coingecko: 0, coinbase: 0, kraken: 0, coinmarketcap: 0 };
    }

    // Emit ONE aggregated warn per source per fetch for the values that source's
    // parse loop dropped on the (0, PRICE_MAX) bound, and carry the cumulative
    // per-source counter (same shape as _cmc400Count above). Aggregated rather
    // than per-pair on purpose: the fetch is scheduled and there are 36 pairs, so
    // a genuinely mis-scaled upstream would emit 36 lines per round and bury the
    // signal this exists to give. Absences (a pair the source simply did not
    // return) are NOT counted; only values that were present and failed the bound.
    _reportBoundRejects(sourceKey, label, rejected) {
        if (!rejected || rejected.length === 0) return;
        // Self-initialising: a source key missing from the declaration above must
        // degrade to a correct count, never to a permanent NaN that reads as a
        // working counter in the warn line below.
        this._boundRejects[sourceKey] = (this._boundRejects[sourceKey] || 0) + rejected.length;
        let sample = rejected.slice(0, BOUND_REJECT_SAMPLE);
        console.warn('PriceFetcher: ' + label + ' returned ' + rejected.length +
            ' value(s) outside the ingestion bound (0 < value < ' + PRICE_MAX + ') this fetch; ' +
            'dropped from those pairs\' medians: ' + sample.join(', ') +
            (rejected.length > sample.length ? ', ...' : '') +
            '. Cumulative for this source: ' + this._boundRejects[sourceKey] + '.');
    }

    // Render one rejected value for the aggregated warn, truncated so a garbage
    // upstream payload cannot turn a diagnostic line into a multi-kilobyte log entry.
    static _rejectSample(coinPair, raw) {
        let shown = String(raw);
        if (shown.length > 32) shown = shown.slice(0, 32) + '...';
        return coinPair + '=' + shown;
    }

    // The coin pairs at least two configured providers can supply this round. Used by
    // the federation single-source health signal so it does not cry wolf on pairs that
    // are CoinGecko-only by design: Kraken lists no MXN/CNY/BRL/INR/KRW markets (plus
    // per-coin gaps like LTC/CAD, DOGE/JPY), so those pairs always report sources=1 in
    // a healthy keyless round. CoinGecko is the always-on baseline for all 36 pairs;
    // the second source is Kraken (keyless, KRAKEN_PAIRS only) or CoinMarketCap (all 36,
    // only when a key is configured). A pair absent from this set can never reach two
    // sources, so a sources=1 reading for it is expected, not a degradation.
    multiSourceCapablePairs() {
        let capable = new Set(Object.keys(KRAKEN_PAIRS));
        if (this.coinmarketcapApiKey) {
            for (let pair of COIN_PAIRS) capable.add(pair);
        }
        return capable;
    }

    // Fetch prices from all configured sources and return the local median per coin pair
    // Returns: [{ coinPair: 'BTC/USD', price: '100000.00000000', sources: 2 }, ...] for all 36 pairs
    async fetchPrices() {
        let results = {};
        for (let pair of COIN_PAIRS) {
            results[pair] = [];
        }

        // Fetch from all sources in parallel. CoinGecko, Kraken and Coinbase are all
        // keyless, so every hub has THREE uncorrelated upstreams out of the box, and
        // CoinGecko and Coinbase both cover all 36 pairs: no pair is left resting on
        // a single API the way the thin fiats were when Kraken (17 pairs) was the
        // only companion. CoinMarketCap is added as a fourth only when an API key is
        // configured; it is billed per convert-currency (12 credits per call here),
        // which is why it stays opt-in rather than assumed.
        // Each fetcher fails soft (returns null on error), so one source erroring
        // never drops the others.
        let fetches = [this.fetchFromCoinGecko(), this.fetchFromKraken(), this.fetchFromCoinbase()];
        if (this.coinmarketcapApiKey) {
            fetches.push(this.fetchFromCoinMarketCap());
        }

        let sourceResults = await Promise.allSettled(fetches);

        // Count sources that returned at least one usable price this round, so we
        // can warn when fewer than two live sources are active (a single correlated
        // upstream is exactly the failure mode the second keyless provider closes).
        let liveSources = 0;
        for (let result of sourceResults) {
            if (result.status === 'fulfilled' && result.value) {
                let contributed = false;
                for (let pair of COIN_PAIRS) {
                    if (result.value[pair] !== undefined && result.value[pair] !== null) {
                        results[pair].push(result.value[pair]);
                        contributed = true;
                    }
                }
                if (contributed) liveSources++;
            }
        }

        if (liveSources < 2) {
            console.warn('PriceFetcher: only ' + liveSources + ' live price source(s) this round ' +
                '(need at least 2 uncorrelated sources for a healthy oracle). ' +
                'Check CoinGecko / Kraken / Coinbase reachability' +
                (this.coinmarketcapApiKey ? ' / CoinMarketCap API key.' : '.'));
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
            } else {
                // Surface a pair every source stopped returning: without
                // this the pair silently vanishes from the submission, masking a per-hub
                // degradation while the round still looks healthy.
                console.warn('Oracle PriceFetcher: no source returned a value for ' + pair
                    + ' this fetch; omitting it from the submission');
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

        // Initial jitter (0-PRICE_FETCH_JITTER_MS) so multiple hubs behind the same
        // NAT don't collide on CoinGecko's per-second rate limit at the start of each round.
        if (this.fetchJitterMs > 0)
            await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * this.fetchJitterMs)));

        let response;
        try {
            response = await this._fetchWithRetry(url, { timeout: this.timeout, headers });
        } catch (err) {
            console.warn('CoinGecko fetch failed after retries: ' + (err ? err.message : 'unknown error'));
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
                    rejected.push(PriceFetcher._rejectSample(coin + '/' + fiat, raw));
                }
            }
        }
        this._reportBoundRejects('coingecko', 'CoinGecko', rejected);
        return prices;
    }

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
                response = await this._fetchWithRetry(url, { timeout: this.timeout, headers: {} });
            } catch (err) {
                // Per-coin failure only. One coin erroring must not discard the two
                // that answered, the same fail-soft rule the other sources follow.
                console.warn('Coinbase fetch failed after retries for ' + coin + ': ' +
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
                    rejected.push(PriceFetcher._rejectSample(coin + '/' + fiat, raw));
                }
            }
        }

        this._reportBoundRejects('coinbase', 'Coinbase', rejected);
        // null, not {}, when every coin failed: fetchPrices counts a source as live
        // only if it contributed a price, and null keeps that distinction honest.
        return anyCoinSucceeded ? prices : null;
    }

    // Fetch coin/fiat pairs from Kraken's keyless public ticker in a single request,
    // retrying on 429/503 with the same backoff+jitter as CoinGecko. Kraken is a
    // second uncorrelated keyless upstream so every hub has 2 sources by default.
    // Only the pairs Kraken lists are requested (KRAKEN_PAIRS); the
    // others stay CoinGecko-only. Mirrors fetchFromCoinGecko's fetch+parse+normalize
    // shape: jitter, _fetchWithRetry, then a { 'COIN/FIAT': number } map (or null).
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
            response = await this._fetchWithRetry(url, { timeout: this.timeout });
        } catch (err) {
            console.warn('Kraken fetch failed after retries: ' + (err ? err.message : 'unknown error'));
            return null;
        }

        // Kraken wraps everything in { error: [...], result: {...} }. A non-empty
        // error array means the whole batch was rejected (e.g. an unknown pair);
        // treat it as a failed round for this source rather than a partial parse.
        let body = response.data;
        if (!body || (Array.isArray(body.error) && body.error.length > 0)) {
            console.warn('Kraken returned error: ' + (body && body.error ? JSON.stringify(body.error) : 'no body'));
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
                rejected.push(PriceFetcher._rejectSample(pair, entry.c[0]));
            }
        }
        this._reportBoundRejects('kraken', 'Kraken', rejected);
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
                    rejected.push(PriceFetcher._rejectSample(coin + '/' + fiat, cmcQuote.price));
                }
            }
        }
        this._reportBoundRejects('coinmarketcap', 'CoinMarketCap', rejected);
        return prices;
    }

    // Compute median of a numeric array, returned as an 8-decimal bignumber string
    // (mathjs/bcmath per the platform mandate; the even-length midpoint average is
    // done in bignumber so the submitted local price carries no float/.toFixed artifact).
    // Ordering uses a float compare (no consensus arithmetic).
    _median(values) {
        if (values.length === 0) return bcmath.bcformat('0', 8);
        let sorted = [...values].sort((a, b) => a - b);
        let mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
            return bcmath.bcformat(bcmath.bcdiv(bcmath.bcadd(String(sorted[mid - 1]), String(sorted[mid]), 8), '2', 8), 8);
        }
        return bcmath.bcformat(String(sorted[mid]), 8);
    }

    // Expose the supported pair list (used by OracleConsensus._storeSkippedRound and tests)
    static getCoinPairs() {
        return COIN_PAIRS.slice();
    }
}

module.exports = PriceFetcher;
