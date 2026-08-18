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
 **********************************************************************/

'use strict';

const SATOSHI_PER_COIN = 1e8;

// Convert one UTXO to whole coins. `value` is preferred over `amount`
// deliberately: it is the field the tracker validates as present, the field
// the tracker derives `amount` FROM, and the field create_tx will actually
// spend, so a balance built from it measures the same quantity the spend path
// sees even if a non-tracker source ever lets the two disagree. `amount` is
// the fallback for a source that omits `value` entirely. Anything unparseable
// contributes 0, which understates the balance and therefore errs toward
// tripping the floor (the fail-closed direction).
function utxoToCoins(u){
    if(!u || typeof u !== 'object') return 0;
    let sats = (u.value === null || u.value === undefined || u.value === '') ? NaN : Number(u.value);
    if(Number.isFinite(sats)) return sats / SATOSHI_PER_COIN;
    let coins = parseFloat(u.amount);
    return Number.isFinite(coins) ? coins : 0;
}

// Sum a get_utxos list into a whole-coin balance. A non-array input sums to 0;
// callers that must distinguish "no readable balance" from "zero balance" keep
// their own Array.isArray guard and leave the balance null.
function sumUtxosCoins(utxos){
    if(!Array.isArray(utxos)) return 0;
    let total = 0;
    for(let u of utxos) total += utxoToCoins(u);
    return total;
}

module.exports = { sumUtxosCoins, utxoToCoins, SATOSHI_PER_COIN };
