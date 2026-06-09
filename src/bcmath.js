/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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
 * same mathjs major as the indexer (15.x, default BigNumber precision 64) — these
 * MUST stay byte-equivalent.
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

// Exact decimal comparisons (decimal.js native — no mathjs epsilon).
function bcgt(numA, numB){ return bcnum(numA).gt(bcnum(numB)); }
function bclt(numA, numB){ return bcnum(numA).lt(bcnum(numB)); }
function bcgte(numA, numB){ return bcnum(numA).gte(bcnum(numB)); }
function bclte(numA, numB){ return bcnum(numA).lte(bcnum(numB)); }

// Format a bignumber/string to a fixed-decimal string (for storage as VARCHAR).
function bcstr(num, decimals = 64){
    return mathjs.format(bcnum(num), {notation: 'fixed', precision: parseInt(decimals)});
}

module.exports = { isNull, isNumeric, bcnum, bcsub, bcadd, bcmul, bcdiv, getPrice, bcgt, bclt, bcgte, bclte, bcstr };
