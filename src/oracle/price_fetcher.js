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

const { PRICE_MAX } = require('../constants.js');
const bcmath = require('../bcmath.js');
const { KRAKEN_PAIRS, COIN_PAIRS } = require('./price_fetcher/pairs.js');
const { getLogger } = require('../observability');
const logger = getLogger();

// The upstreams themselves, one method per source, installed on the prototype
// below. They are a part rather than a module of functions because each one is
// dispatched by name from PRICE_SOURCES and calls this class's own fetchWithRetry.
const sourcesPart = require('./price_fetcher/sources.js');
const PARTS = [sourcesPart];

// How many offending pairs the aggregated bound-rejection warn names before it
// elides the rest. Enough to identify whether one pair or a whole coin regressed,
// short enough to stay one readable log line.
const BOUND_REJECT_SAMPLE = 5;

// The price-source lineup, declared ONCE as data: which fetcher, whether it needs a
// key, and which pairs it can price. multiSourceCapablePairs() derives the
// multi-source-capable set from this instead of restating the lineup, which is how
// nineteen pairs sat outside the single-source health signal for the whole life of the
// keyless Coinbase source (item 7068). test/unit/oracle/price/fetcher/price_fetcher.test.js pins it against
// the fetchers fetchPrices() actually dispatches, so adding or dropping a source on one
// side reddens rather than silently re-opening the gap.
//
// `covers` is a function, not an array, because KRAKEN_PAIRS is the coverage fact for
// Kraken and reading it lazily keeps the two from being copied apart.
const PRICE_SOURCES = [
    { key: 'coingecko',     method: 'fetchFromCoinGecko',     requiresKey: null,
      covers: () => COIN_PAIRS },
    { key: 'kraken',        method: 'fetchFromKraken',        requiresKey: null,
      covers: () => Object.keys(KRAKEN_PAIRS) },
    { key: 'coinbase',      method: 'fetchFromCoinbase',      requiresKey: null,
      covers: () => COIN_PAIRS },
    { key: 'coinmarketcap', method: 'fetchFromCoinMarketCap', requiresKey: 'coinmarketcapApiKey',
      covers: () => COIN_PAIRS }
];

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
        // in this pipeline already says it out loud (OracleRound.handleMessage,
        // OracleConsensus.aggregate, XchainPriceSource.entry); this was the
        // last silent one.
        // One entry per source that calls reportBoundRejects. Coinbase was added to
        // the dispatch after this counter and missed the list, so its first rejection
        // evaluated `undefined + n` and pinned the counter at NaN for the process
        // lifetime, on the source with the widest pair coverage. The accumulator
        // self-initialises now (see reportBoundRejects), so this list documents the
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
    reportBoundRejects(sourceKey, label, rejected) {
        if (!rejected || rejected.length === 0) return;
        // Self-initialising: a source key missing from the declaration above must
        // degrade to a correct count, never to a permanent NaN that reads as a
        // working counter in the warn line below.
        this._boundRejects[sourceKey] = (this._boundRejects[sourceKey] || 0) + rejected.length;
        let sample = rejected.slice(0, BOUND_REJECT_SAMPLE);
        logger.warn('PriceFetcher: ' + label + ' returned ' + rejected.length +
            ' value(s) outside the ingestion bound (0 < value < ' + PRICE_MAX + ') this fetch; ' +
            'dropped from those pairs\' medians: ' + sample.join(', ') +
            (rejected.length > sample.length ? ', ...' : '') +
            '. Cumulative for this source: ' + this._boundRejects[sourceKey] + '.');
    }

    // Render one rejected value for the aggregated warn, truncated so a garbage
    // upstream payload cannot turn a diagnostic line into a multi-kilobyte log entry.
    static rejectSample(coinPair, raw) {
        let shown = String(raw);
        if (shown.length > 32) shown = shown.slice(0, 32) + '...';
        return coinPair + '=' + shown;
    }

    // The coin pairs at least two configured providers can supply this round. Used by
    // the federation single-source health signal (OracleConsensus.finalizeRound) so it
    // does not cry wolf on a pair only one upstream can ever price: such a pair reports
    // sources=1 in every healthy round, and without the filter the global minimum is
    // ~always 1 and the warn trains operators to ignore it. Counting only, never gating.
    //
    // DERIVED from PRICE_SOURCES rather than restated (item 7068). The set was seeded
    // from KRAKEN_PAIRS alone, which was true when Kraken was the only companion to
    // CoinGecko, and stayed a hand-written second statement of the lineup when the
    // keyless Coinbase source landed covering all 36 pairs. Nineteen pairs were
    // therefore excluded from the signal on every keyless hub: BTC/MXN could fall to
    // CoinGecko alone and the degradation counter would not move.
    multiSourceCapablePairs() {
        let counts = new Map();
        for (let source of PRICE_SOURCES) {
            if (source.requiresKey && !this[source.requiresKey]) continue;
            for (let pair of source.covers()) counts.set(pair, (counts.get(pair) || 0) + 1);
        }
        let capable = new Set();
        for (let [pair, n] of counts) if (n >= 2) capable.add(pair);
        return capable;
    }

    // The lineup as data, so a test can pin it against the fetchers fetchPrices()
    // actually dispatches. Returns copies; `covers` is re-read per call because
    // KRAKEN_PAIRS and COIN_PAIRS are module state a test may not mutate safely.
    static priceSources() {
        return PRICE_SOURCES.map(s => ({
            key: s.key, method: s.method, requiresKey: s.requiresKey, covers: s.covers().slice()
        }));
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
            logger.warn('PriceFetcher: only ' + liveSources + ' live price source(s) this round ' +
                '(need at least 2 uncorrelated sources for a healthy oracle). ' +
                'Check CoinGecko / Kraken / Coinbase reachability' +
                (this.coinmarketcapApiKey ? ' / CoinMarketCap API key.' : '.'));
        }

        return this.medianPrices(results);
    }

    // The local median per pair, over whatever the live sources contributed.
    medianPrices(results) {
        let prices = [];
        for (let pair of COIN_PAIRS) {
            let values = results[pair];
            if (values.length > 0) {
                let median = this.computeMedian(values);   // already an 8dp bignumber string
                prices.push({
                    coinPair: pair,
                    price:    median,
                    sources:  values.length
                });
            } else {
                // Surface a pair every source stopped returning: without
                // this the pair silently vanishes from the submission, masking a per-hub
                // degradation while the round still looks healthy.
                logger.warn('Oracle PriceFetcher: no source returned a value for ' + pair
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
    async fetchWithRetry(url, options) {
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
                    logger.warn('CoinMarketCap returned 400 (possible plan-tier limit: multi-currency convert may require a paid plan). Skipping CMC this round.');
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

    // Compute median of a numeric array, returned as an 8-decimal bignumber string
    // (mathjs/bcmath per the platform mandate; the even-length midpoint average is
    // done in bignumber so the submitted local price carries no float/.toFixed artifact).
    // Ordering uses a float compare (no consensus arithmetic).
    computeMedian(values) {
        if (values.length === 0) return bcmath.bcformat('0', 8);
        let sorted = [...values].sort((a, b) => a - b);
        let mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
            return bcmath.bcformat(bcmath.bcdiv(bcmath.bcadd(String(sorted[mid - 1]), String(sorted[mid]), 8), '2', 8), 8);
        }
        return bcmath.bcformat(String(sorted[mid]), 8);
    }

    // Expose the supported pair list (used by OracleConsensus.storeSkippedRound and tests)
    static getCoinPairs() {
        return COIN_PAIRS.slice();
    }
}

// Install the source part's methods on the prototype, non-enumerably, the same
// way src/db/index.js installs its table mixins: a moved method stays
// indistinguishable from one declared in the class above, and a name already on
// the prototype throws rather than being silently overwritten.
function installParts(target, parts) {
    for (const part of parts) {
        const descriptors = {};
        for (const name of Object.keys(part)) {
            if (Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('Duplicate PriceFetcher method: ' + name + ' is already ' +
                    'defined on the prototype. Two parts, or a part and the class, claim it.');
            descriptors[name] = { value: part[name], enumerable: false, writable: true, configurable: true };
        }
        Object.defineProperties(target, descriptors);
    }
}

installParts(PriceFetcher.prototype, PARTS);

module.exports = PriceFetcher;
