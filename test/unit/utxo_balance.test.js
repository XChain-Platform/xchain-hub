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
const { sumUtxosCoins, sumUtxosSatoshis, utxoToCoins, utxoToSatoshis, SATOSHI_PER_COIN } = require('../../src/lib/utxo_balance.js');

// A list of `n` identical outputs, for the accumulator-drift cases below.
const repeat = (n, value) => Array.from({ length: n }, () => ({ value }));

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

    it('does not drift a wallet sitting exactly on the default floor below it', function () {
        // 100 outputs of 0.1 DOGE is exactly the default 10 DOGE floor. Summed as
        // doubles this returned 9.99999999999998, so SpendGuard's
        // `Number(balance) < minBalance` refused a broadcast at a balance that
        // meets the floor. Nothing about this magnitude is exotic.
        const atFloor = sumUtxosCoins(repeat(100, '10000000'));
        expect(atFloor).to.equal(10);
        expect(atFloor < 10).to.equal(false);
        expect(sumUtxosCoins(repeat(1000, '10000000'))).to.equal(100);
    });

    it('does not accumulate per-output rounding error', function () {
        // Three single-koinu outputs summed as doubles gave 3.0000000000000004e-8.
        expect(sumUtxosCoins(repeat(3, '1'))).to.equal(3e-8);
        expect(sumUtxosSatoshis(repeat(3, '1'))).to.equal(3n);
    });

    it('keeps a u64 koinu value exact above 2^53', function () {
        // Number('9007199254740993') rounds to ...992, which is the precision loss
        // the utxo-tracker's satoshiToDecimalString comment exists to avoid. The
        // satoshi accessor carries the full u64; the coin Number is the nearest
        // double to the true figure rather than the double of a pre-rounded input.
        expect(utxoToSatoshis({ value: '9007199254740993' })).to.equal(9007199254740993n);
        expect(sumUtxosSatoshis([{ value: '9007199254740993' }, { value: '1' }]))
            .to.equal(9007199254740994n);
        expect(utxoToCoins({ value: '9007199254740993' })).to.equal(90071992.54740994);
    });

    it('routes a malformed value to the fallback instead of taking it as satoshis', function () {
        // '1.5' and '1e8' are not readBigUInt64BE().toString() output. The float
        // path silently read them as 1.5 and 1e8 satoshis; they now fall through
        // to `amount`, then to 0 - the understating, fail-closed direction. They
        // must not throw: BigInt() rejects both, and this sits on a spend gate.
        expect(utxoToCoins({ value: '1.5', amount: '2.5' })).to.equal(2.5);
        expect(utxoToCoins({ value: '1e8', amount: '2.5' })).to.equal(2.5);
        expect(utxoToCoins({ value: '1.5' })).to.equal(0);
        expect(utxoToCoins({ value: '1e8' })).to.equal(0);
        expect(utxoToSatoshis({ value: {} })).to.equal(0n);
    });

    it('truncates sub-koinu precision in an amount fallback rather than rejecting it', function () {
        // Finer than 8 dp is unspendable dust; dropping it understates.
        expect(utxoToCoins({ amount: '2.123456789' })).to.equal(2.12345678);
        expect(utxoToCoins({ amount: '2' })).to.equal(2);
    });
});
