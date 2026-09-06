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
 * XChain Hub - canonical decimal price spelling guard
 *
 * The oracle admits a submitted price with parseFloat and then keeps the
 * SUBMITTED value. parseFloat is prefix-tolerant, so '100junk' admits as 100,
 * and every later hop reads the original string with bcmath, whose bcnum()
 * coerces a non-numeric to 0 (isNumeric uses isFinite, which is false for
 * '100junk'). One value, two readings: 100 at every admission gate and 0 in
 * every bignumber computation - the trimmed median, the co-sign deviation band
 * and the slash evidence all disagree with the gate that let it in, and the
 * row persisted for audit is the junk itself.
 *
 * The guard is on the RAW spelling, like lib/canonical_int.js, and for the same
 * reason: coercing first is what hides the spelling under test. It is
 * fail-closed and needs no activation flag - an honest submission already
 * carries bcmath.bcformat(value, 8) output (PriceFetcher._median,
 * XchainPriceSource._entry), which this accepts unchanged, so an honest round
 * never sees it fire.
 *
 * The predicate is the one PriceAggregator.js:351/712 already applies at the
 * batch-ingest door; this is that rule made shareable, plus the scalar-type and
 * column-width checks a `String(value)` test cannot make.
 *
 **********************************************************************/

'use strict';

// oracle_submissions.price is VARCHAR(40) (src/sql/oracle_submissions.sql). A
// longer spelling is either truncated on write or refused by the driver, and a
// truncated one is a THIRD reading of the same value, so refuse it here where
// the drop is logged. An honest price is ~15 characters.
const PRICE_MAX_CHARS = 40;

// Unsigned fixed-point decimal, whole string. Rejects the prefix garbage that
// started this ('100junk'), and equally '', ' 100', '+100', '-1', '100.',
// '.5', '1e3', '0x64', 'Infinity' and 'NaN'.
const CANONICAL_PRICE = /^[0-9]+(\.[0-9]+)?$/;

// The canonical spelling of `v` as a decimal string, or null when `v` is not
// one. Never coerces: the string a caller retains is a string the caller was
// given, so what admission validated and what bcmath later reads are the same
// characters.
function canonicalPrice(v){
    let s;
    if(typeof v === 'number'){
        // A JSON number reaches fixed notation only inside a bounded range:
        // String(1e-7) is '1e-7' and String(1e21) is '1e+21', both of which the
        // pattern refuses rather than quietly reinterpret. No honest hub sends a
        // number here at all (both local price sources emit bcformat strings), so
        // this door is compatibility, not a path anything relies on.
        if(!Number.isFinite(v)) return null;
        s = String(v);
    } else if(typeof v === 'string'){
        s = v;
    } else {
        // null / undefined / boolean / bigint / object / array. parseFloat(['100'])
        // is 100, so an array slips through a coercing gate; nothing here does.
        return null;
    }
    if(s.length > PRICE_MAX_CHARS) return null;
    if(!CANONICAL_PRICE.test(s)) return null;
    return s;
}

// True iff `v` is already a canonical decimal price spelling.
function isCanonicalPrice(v){
    return canonicalPrice(v) !== null;
}

module.exports = { canonicalPrice, isCanonicalPrice, PRICE_MAX_CHARS };
