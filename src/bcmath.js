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
 * XChain Hub - Big-number math (cross-chain ORDER partial-fill matching)
 *
 * Faithful port of the bignumber helpers in xchain-indexer/src/utility.js
 * (mathjs bignumber + decimal.js native compare/floor). The cross-chain DEX
 * order book must compute fill quantities with the SAME arithmetic the indexer
 * uses for its local order book (order_match.js bottleneck-clamp + getPrice /
 * bcmul precision 18 / bcsub precision 64) so a fill the hub finalizes lands the
 * legs and reduces each order's `getOrderAmountsRemaining` consistently. Pin the
 * same mathjs major as the indexer (15.x, default BigNumber precision 64).
 * These MUST stay byte-equivalent.
 *
 ********************************************************************/

const mathjs = require('mathjs');

function isNull(value){
    return (value === null || value === undefined || value === '');
}

function isNumeric(value){
    return typeof value === 'bigint' || (!isNaN(parseFloat(value)) && isFinite(value));
}

// Coerce to a mathjs bignumber (decimal.js). Non-numeric → 0, mirroring utility.js.
function bcnum(num){
    let str = String(num).trim();
    if(str === 'NaN' || str === 'Infinity' || str === '-Infinity' || !isNumeric(num))
        return mathjs.bignumber(0);
    return mathjs.bignumber(str);
}

function bcsub(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return bcnum(mathjs.format(mathjs.subtract(mathjs.bignumber(a), mathjs.bignumber(b)), {notation: 'fixed', precision: d}));
}

function bcadd(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return bcnum(mathjs.format(mathjs.add(mathjs.bignumber(a), mathjs.bignumber(b)), {notation: 'fixed', precision: d}));
}

function bcmul(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return bcnum(mathjs.format(mathjs.multiply(mathjs.bignumber(a), mathjs.bignumber(b)), {notation: 'fixed', precision: d}));
}

function bcdiv(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    if(String(b) === '0' || b === 0)
        return mathjs.bignumber(0);
    return bcnum(mathjs.format(mathjs.divide(mathjs.bignumber(a), mathjs.bignumber(b)), {notation: 'fixed', precision: d}));
}

// Price = numerator / denominator at 64 decimals (matches util.getPrice).
function getPrice(numerator, denominator, precision = 64){
    return bcdiv(numerator, denominator, precision);
}

// Exact decimal comparisons (decimal.js native, no mathjs epsilon).
function bcgt(numA, numB){ return bcnum(numA).gt(bcnum(numB)); }
function bclt(numA, numB){ return bcnum(numA).lt(bcnum(numB)); }
function bcgte(numA, numB){ return bcnum(numA).gte(bcnum(numB)); }
function bclte(numA, numB){ return bcnum(numA).lte(bcnum(numB)); }

// Zero-padded fixed-decimal string (e.g. bcformat('1.5', 8) -> '1.50000000').
// Named bcformat to match xchain-indexer/src/utility.js, where the padded
// helper is bcformat and bcstr is the minimal form below. Keeping the names
// aligned makes the byte-equivalence claim in this file's header true.
function bcformat(num, decimals){
    // Byte-equivalence contract with xchain-indexer/src/utility.js: an
    // omitted/null `decimals` formats at 0 (integer), NOT a wide fixed width.
    // Every current hub caller passes decimals explicitly (verified 2026-07);
    // do not reintroduce a wide default without re-checking every call site.
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return mathjs.format(bcnum(num), {notation: 'fixed', precision: d});
}

// Minimal-form string, byte-identical to the indexer's utility.js bcstr
// (bcnum(num).toFixed(), no zero padding): bcstr('1.5') -> '1.5'. Use this
// wherever output must byte-match indexer-produced amount strings (the SMT
// canonicalAmount path); use bcformat when a fixed width is required.
function bcstr(num){
    return bcnum(num).toFixed();
}

// Round to d decimal places, half-up, entirely in decimal.js space. Faithful port
// of xchain-indexer/src/utility.js bcround (): floor(n * 10^d + 0.5)
// / 10^d, so the rounding mode is EXPLICIT and config-independent rather than
// inheriting the global decimal.js/mathjs rounding setting. It exists to snap a
// derived settlement amount onto its tick's decimal grid, which both recovers the
// true value from sub-ULP artifacts (1 - 1e-18 = 0.999999999999999999 -> 1) and
// forces indivisible (0-decimal) tokens to integers.
//
// This file's header declares byte-equivalence with the indexer's helpers, and
// until now that claim was false by omission: the indexer quantizes both derived
// fill amounts with bcround and the hub had no bcround at all. The helper is
// ported here so the family is complete and the claim can be tested. See
// CrossChainDexEngine for what the hub can and cannot yet quantize.
function bcround(num, decimals){
    let n = (!isNull(num)) ? num : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    let scale   = mathjs.bignumber(10).pow(d);
    let half    = mathjs.bignumber('0.5');
    let rounded = bcnum(n).times(scale).plus(half).floor().div(scale);
    return bcnum(mathjs.format(rounded, {notation: 'fixed', precision: d}));
}

module.exports = { isNull, isNumeric, bcnum, bcsub, bcadd, bcmul, bcdiv, getPrice, bcgt, bclt, bcgte, bclte, bcstr, bcformat, bcround };
