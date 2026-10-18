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
 * PRICE v0 canonical price-value rule.
 *
 * A PRICE v0 round names each pair TICKER/FIAT and a price STRING. Every other
 * price entry point bounds that string's scale: the v1 push path caps the
 * decimal side at 8 places (PriceAggregator.receiveOraclePrice), the producer
 * normalizes with bcformat(price, 8) before its own bound
 * (XchainPriceSource._entry), and OracleConsensus._aggregate emits
 * bcformat(..., 8). The v0 wire alone accepted /^[0-9]+(\.[0-9]+)?$/, any
 * number of digits on either side of the point.
 *
 * So a quorum-signed v0 round could carry values every other lane refused, and
 * two of them bit.
 *
 * SCALE. 0.000000001 is refused by the v1 regex and by every producer, whose
 * bcformat(..., 8) renders it '0.00000000' and fails the positive lower bound.
 * It passed v0 ingest and finalized into the unified store, which was the
 * one-lane-accepts-what-another-refuses case this seam exists to prevent.
 *
 * LENGTH. The accepted string was stored and mirrored verbatim into
 * price_snapshots.price, a VARCHAR(40) on the hub and on the indexer mirror. A
 * 42-character price cleared every v0 gate, so under a permissive sql_mode the
 * stored row no longer equaled the value the validators signed, and under
 * STRICT_TRANS_TABLES the INSERT threw and the whole round was refused as a
 * 'db error'. Which of the two happens is a database setting rather than a
 * protocol decision. OracleBatchSigner re-derives batch canonical bytes from
 * its own finalized price_snapshots rows and compares pair prices as strings,
 * so a truncated row also poisons later batch co-signing.
 *
 * THE RULE. A v0 price is CANONICAL: no leading zeros on the integer side, at
 * most PRICE_SCALE_MAX_DECIMALS digits on the decimal side, and a point only
 * when digits follow it.
 *
 * The scale half and the leading-zero half are ONE rule because either alone
 * leaves the other consequence reachable. A scale cap by itself still admits
 * '00000000000000000000000001.5', arbitrarily long and 8-dp-legal, which
 * truncates exactly as the 42-character value does. Together they bound an
 * accepted price to 19 characters: PRICE_MAX is 10_000_000_000 and the ceiling
 * is exclusive, so at most 10 integer digits, a point, and 8 decimals. That is
 * what puts every accepted value inside VARCHAR(40) with room to spare and
 * makes the storage seam unreachable rather than merely wider, and it is why
 * no schema change carries this fix.
 *
 * It refuses nothing a producer emits. bcformat(..., 8) yields exactly this
 * form, so the honest wire is already canonical.
 *
 * VENDORED byte-identically into xchain-hub/src, where PriceAggregator applies
 * it to both v0 ingest paths. A test in each repo pins the byte-equality.
 *
 ********************************************************************/

'use strict';

const { copy } = require('../gate_registry');

const PRICE_SCALE_MAX_DECIMALS = copy('price_scale_activation.PRICE_SCALE_MAX_DECIMALS');

const PRICE_VALUE_RE_LEGACY = copy('price_scale_activation.PRICE_VALUE_RE_LEGACY');
const PRICE_VALUE_RE_CANONICAL = copy('price_scale_activation.PRICE_VALUE_RE_CANONICAL');
const PRICE_V1_CANONICAL_ACTIVATION = copy('price_scale_activation.PRICE_V1_CANONICAL_ACTIVATION');
const PRICE_V1_FEE_RE_CANONICAL = copy('price_scale_activation.PRICE_V1_FEE_RE_CANONICAL');
const PRICE_V1_VALUE_MAX_LENGTH = copy('price_scale_activation.PRICE_V1_VALUE_MAX_LENGTH');
const PRICE_V1_FEE_MAX_LENGTH = copy('price_scale_activation.PRICE_V1_FEE_MAX_LENGTH');

// `coin` is optional so existing network-only consumers retain the bare-key fallback.
function isPriceV1CanonicalActive(blockTime, network, coin){
    if(blockTime === null || blockTime === undefined || blockTime === '' || typeof blockTime === 'boolean')
        return false;
    let t = Number(blockTime);
    if(!Number.isFinite(t)) return false;
    let coinKey = coin + ':' + network;
    let threshold = coin !== null && coin !== undefined &&
        Object.prototype.hasOwnProperty.call(PRICE_V1_CANONICAL_ACTIVATION, coinKey)
        ? PRICE_V1_CANONICAL_ACTIVATION[coinKey]
        : Object.prototype.hasOwnProperty.call(PRICE_V1_CANONICAL_ACTIVATION, network)
            ? PRICE_V1_CANONICAL_ACTIVATION[network] : undefined;
    if(typeof threshold !== 'number' || !Number.isFinite(threshold)) return false;
    return t >= threshold;
}

function isCanonicalPriceV1Value(value){
    return typeof value === 'string' && value.length <= PRICE_V1_VALUE_MAX_LENGTH
        && PRICE_VALUE_RE_CANONICAL.test(value);
}

function isCanonicalPriceV1Fee(fee){
    return typeof fee === 'string' && fee.length <= PRICE_V1_FEE_MAX_LENGTH
        && PRICE_V1_FEE_RE_CANONICAL.test(fee);
}

// `blockTime` and `network` remain in the signature for caller compatibility.
function priceValuePattern(blockTime, network){
    return PRICE_VALUE_RE_CANONICAL;
}

// Whether `price` is a well-formed PRICE v0 value. The other arguments remain
// for caller compatibility. Non-string input is never coerced: String(null)
// would become the parseable-looking 'null' and String(['1']) would silently pass.
function isValidPriceValue(price, blockTime, network){
    if(typeof price !== 'string') return false;
    return PRICE_VALUE_RE_CANONICAL.test(price);
}

module.exports = {
    PRICE_SCALE_MAX_DECIMALS,
    PRICE_VALUE_RE_LEGACY,
    PRICE_VALUE_RE_CANONICAL,
    PRICE_V1_CANONICAL_ACTIVATION,
    PRICE_V1_FEE_RE_CANONICAL,
    PRICE_V1_VALUE_MAX_LENGTH,
    PRICE_V1_FEE_MAX_LENGTH,
    isPriceV1CanonicalActive,
    isCanonicalPriceV1Value,
    isCanonicalPriceV1Fee,
    priceValuePattern,
    isValidPriceValue,
};
