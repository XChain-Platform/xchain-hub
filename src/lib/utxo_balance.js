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
 * XChain Hub - UTXO balance in whole coins
 *
 * get_utxos carries TWO denominations per output and they differ by 1e8:
 * `value` is the raw satoshi/koinu integer (the field the encoder validates
 * as a satoshi amount and the field create_tx spends), while `amount` is an
 * optional convenience field the utxo-tracker derives from it as a whole-coin
 * decimal string (`amount = satoshiToDecimalString(value)`). Every balance
 * floor in this service is whole-coin: lowBalanceThreshold defaults to 10
 * DOGE, SpendGuard.minBalance mirrors it, and the monitor alerts on the
 * dogeBalance the publishers report.
 *
 * Both publishers used to sum `parseFloat(u.value || u.amount || 0)`, which
 * can never reach the `amount` branch because a funded output's satoshi
 * `value` is always truthy. That summed satoshis into a whole-DOGE
 * comparison, so the fail-closed floor could only fire below ~1e-7 DOGE and
 * was inert at every balance an operator would call low. One helper, so the
 * two guards cannot silently re-diverge.
 *
 * ARITHMETIC IS EXACT AND INTEGER. Every parse and every addition happens in
 * BigInt satoshi/koinu, and the one conversion to a double happens once, at
 * the API boundary, through a decimal string rather than a division. The
 * float path this replaced was wrong at BOTH ends: `Number(u.value)` rounds
 * any single output above 2^53 koinu (~90.07M DOGE), which is the hazard the
 * utxo-tracker's own `satoshiToDecimalString` comment warns about, and the
 * `total +=` accumulator drifted at ordinary magnitudes - 100 outputs of 0.1
 * DOGE summed to 9.99999999999998, so a wallet holding exactly the default
 * 10 DOGE floor read as below it and SpendGuard refused the broadcast.
 * A caller that needs an exact reportable balance takes sumUtxosSatoshis and
 * formats it itself; the coin Number is a threshold quantity, not a report.
 *
 **********************************************************************/

'use strict';

const SATOSHI_PER_COIN = 1e8;

// The same scale as SATOSHI_PER_COIN, in the integer domain the arithmetic
// actually runs in. Kept separate because SATOSHI_PER_COIN is exported and a
// test pins it to the double 1e8.
const SATOSHI_PER_COIN_BIG = 100000000n;

// Parse a raw satoshi/koinu `value` into BigInt, or null when it is not one.
// Strict on purpose: the tracker emits readBigUInt64BE().toString(), so a
// non-integer or exponential `value` is malformed data, and rejecting it here
// routes the output to the `amount` fallback and then to 0 - the understating,
// fail-closed direction. BigInt() THROWS on '1.5'/'1e8' where Number() merely
// produced a float, so the guard runs before the conversion, never after.
function parseSatoshis(v){
    if(typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : null;
    if(typeof v !== 'string') return null;
    let s = v.trim();
    if(!/^-?\d+$/.test(s)) return null;
    return BigInt(s);
}

// Parse a whole-coin decimal `amount` into BigInt satoshis. Digits past the
// eighth are truncated rather than rejected: koinu granularity is 8 dp, so
// anything finer is unspendable and dropping it understates the balance.
function parseCoinAmount(a){
    if(typeof a !== 'string' && typeof a !== 'number') return null;
    let m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(String(a).trim());
    if(!m) return null;
    let frac = (m[3] || '').slice(0, 8).padEnd(8, '0');
    let mag  = BigInt(m[2]) * SATOSHI_PER_COIN_BIG + BigInt(frac);
    return m[1] === '-' ? -mag : mag;
}

// Round an exact satoshi count to the nearest double whole-coin figure. Built
// from a decimal string so the only rounding is the one String->Number does,
// rather than a division that rounds the numerator first.
function satoshisToCoins(sats){
    let neg   = sats < 0n;
    let abs   = neg ? -sats : sats;
    let whole = abs / SATOSHI_PER_COIN_BIG;
    let frac  = abs % SATOSHI_PER_COIN_BIG;
    return Number((neg ? '-' : '') + whole.toString() + '.' + frac.toString().padStart(8, '0'));
}

// Convert one UTXO to whole coins. `value` is preferred over `amount`
// deliberately: it is the field the tracker validates as present, the field
// the tracker derives `amount` FROM, and the field create_tx will actually
// spend, so a balance built from it measures the same quantity the spend path
// sees even if a non-tracker source ever lets the two disagree. `amount` is
// the fallback for a source that omits `value` entirely. Anything unparseable
// contributes 0, which understates the balance and therefore errs toward
// tripping the floor (the fail-closed direction).
function utxoToSatoshis(u){
    if(!u || typeof u !== 'object') return 0n;
    let sats = parseSatoshis(u.value);
    if(sats !== null) return sats;
    let fromAmount = parseCoinAmount(u.amount);
    return fromAmount === null ? 0n : fromAmount;
}

function utxoToCoins(u){
    return satoshisToCoins(utxoToSatoshis(u));
}

// Sum a get_utxos list in exact satoshis. This is the accessor for a caller
// that wants a reportable balance; the coin figure below is a threshold
// quantity and is lossy above 2^53 koinu by construction, whatever it is
// summed from.
function sumUtxosSatoshis(utxos){
    if(!Array.isArray(utxos)) return 0n;
    let total = 0n;
    for(let u of utxos) total += utxoToSatoshis(u);
    return total;
}

// Sum a get_utxos list into a whole-coin balance. A non-array input sums to 0;
// callers that must distinguish "no readable balance" from "zero balance" keep
// their own Array.isArray guard and leave the balance null.
function sumUtxosCoins(utxos){
    return satoshisToCoins(sumUtxosSatoshis(utxos));
}

module.exports = { sumUtxosCoins, sumUtxosSatoshis, utxoToCoins, utxoToSatoshis, SATOSHI_PER_COIN };
