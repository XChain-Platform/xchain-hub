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
 * XChain Hub - Price Fetcher: the pair roll and the per-source pair names
 *
 * The coins and fiats a round is priced over, and how each upstream spells
 * them. Read by both the fetcher and its source part, so the roll and the
 * spellings have exactly one home.
 *
 ********************************************************************/

'use strict';

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

// Supported coins (from the canonical registry) and fiat currencies (12).
// THE V0 HALF OF A TWO-LANE FENCE: the product below becomes OracleRound's
// canonicalPairs, which gates v0 ingest and PROPOSE co-signing, while the v1 push lane
// gates on constants.PRICE_V1_COINS / PRICE_V1_FIATS. Those are separate literals, so a
// fiat added here alone is fetched and co-signed but rejected on push, and a coin added
// to coins/ alone is picked up here automatically while v1 ingest still calls it an
// invalid coin. Pinned to the v1 fence and to the indexer config by
// test/unit/shared/constants_conformance.test.js (#7215).
const coins = require('../../coins');
const COINS = [...coins.ALLOWED_COINS];
const FIATS = ['USD', 'CAD', 'AUD', 'MXN', 'GBP', 'JPY', 'CNY', 'CHF', 'BRL', 'INR', 'EUR', 'KRW'];

// Build all 36 coin pairs (BTC/USD, BTC/CAD, ..., DOGE/KRW)
const COIN_PAIRS = [];
for (let coin of COINS) {
    for (let fiat of FIATS) {
        COIN_PAIRS.push(coin + '/' + fiat);
    }
}

module.exports = { COINGECKO_IDS, CMC_SYMBOLS, KRAKEN_PAIRS, KRAKEN_ALT_TO_CANON,
                   krakenResultCandidates, COINS, FIATS, COIN_PAIRS };
