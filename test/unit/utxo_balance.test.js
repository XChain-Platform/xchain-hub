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
 * utxo_balance: the satoshi-to-whole-coin conversion both DOGE publishers
 * sum their low-balance floor from. get_utxos reports `value` in satoshis
 * and lowBalanceThreshold is whole DOGE, so a sum that skips the conversion
 * leaves the fail-closed floor inert by a factor of 1e8.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { sumUtxosCoins, utxoToCoins, SATOSHI_PER_COIN } = require('../../src/lib/utxo_balance.js');

describe('utxo_balance', function () {

    it('converts a tracker UTXO from satoshis to whole coins', function () {
        // The tracker emits both fields off one amount: value is the satoshi
        // integer, amount is satoshiToDecimalString(value).
        expect(utxoToCoins({ value: '1500000000', amount: '15.00000000' })).to.equal(15);
        expect(SATOSHI_PER_COIN).to.equal(1e8);
    });

    it('converts from value alone when the source omits the amount field', function () {
        expect(utxoToCoins({ value: 1500000000 })).to.equal(15);
    });

    it('falls back to amount only when value is absent or unusable', function () {
        expect(utxoToCoins({ amount: '2.5' })).to.equal(2.5);
        expect(utxoToCoins({ value: null, amount: '2.5' })).to.equal(2.5);
        expect(utxoToCoins({ value: '', amount: '2.5' })).to.equal(2.5);
        expect(utxoToCoins({ value: 'not-a-number', amount: '2.5' })).to.equal(2.5);
    });

    it('prefers value over amount, the field create_tx actually spends', function () {
        // A source whose two fields disagree is malformed, but the balance gate
        // must measure the same quantity the spend path will select.
        expect(utxoToCoins({ value: '100000000', amount: '99' })).to.equal(1);
    });

    it('contributes 0 for an unparseable entry rather than NaN-poisoning the sum', function () {
        expect(utxoToCoins(null)).to.equal(0);
        expect(utxoToCoins({})).to.equal(0);
        expect(utxoToCoins({ value: 'x', amount: 'y' })).to.equal(0);
        expect(sumUtxosCoins([{ value: '100000000' }, null, { value: 'x' }])).to.equal(1);
    });

    it('sums a list into whole coins and treats a non-list as zero', function () {
        expect(sumUtxosCoins([{ value: '500000000' }, { value: '350000000' }])).to.equal(8.5);
        expect(sumUtxosCoins([])).to.equal(0);
        expect(sumUtxosCoins(null)).to.equal(0);
        expect(sumUtxosCoins(undefined)).to.equal(0);
    });

    it('reads a genuinely low wallet as low, which the raw-satoshi sum never did', function () {
        // 4 DOGE against the default floor of 10. The pre-fix sum returned 4e8,
        // which cleared every floor an operator would ever configure.
        expect(sumUtxosCoins([{ value: '400000000', amount: '4.00000000' }])).to.equal(4);
    });
});
