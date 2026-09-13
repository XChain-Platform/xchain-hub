/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/XchainPriceBatchedFillShape.test.js
 *
 * What a dispense row's coin side MEANS, which changed under the batch
 * issuance limits flag day and quietly changed an input to this oracle.
 *
 * DISPENSE_FILLS_SQL reads `dispenses.get_amount` as the coin side of a fill,
 * and deriveXchainRate divides the coin side by the XCHAIN side. Before that
 * flag, several dispenses settled out of ONE payment could each record the
 * WHOLE payment as their get_amount while giving only their own share of the
 * tokens, so every one of those rows priced XCHAIN at N times what was really
 * paid for it. The flag made each row record the share attributed to it.
 *
 * Nothing in this repository asserted which shape it was reading, so the
 * correction arrived here as a silent input change. These tests pin the
 * property rather than the incident: the coin side is what was paid FOR THIS
 * FILL, and if it ever goes back to meaning the whole payment, the second case
 * below fails and names the direction of the error.
 *
 * Note the exposure is narrower than it first looks and the check was made
 * rather than assumed: the DEX leg reads its amounts from `order_matches` and
 * touches `coinpays` only as settlement proof and for a block index, so
 * `coinpays.coin_amount` moving under the same flag is NOT a price input.
 */

'use strict';

const { expect } = require('chai');
const util = require('../../src/bcmath.js');
const { deriveXchainRate } = require('../../src/xchainPrice.js');

// One dispenser selling 10 XCHAIN for 0.001 BTC: a true rate of 0.0001 BTC per
// XCHAIN. Three fills settle out of one 0.003 payment.
const TRUE_RATE = '0.00010000';
const FILL_XCHAIN = '10.00000000';
const FILL_COIN = '0.00100000';
const WHOLE_PAYMENT = '0.00300000';

// The three fills are deliberately DIFFERENT sizes, at the same rate. Identical
// rows cannot tell per-row arithmetic apart from reusing one row's value for all
// of them: the first cut of this file used identical fills, and disabling the
// per-row coin contribution left it fully green, which is exactly the kind of
// pass that certifies nothing. Sizes 1x, 2x and 3x keep the true rate constant
// while making every row individually load-bearing.
const SIZES = [1, 2, 3];

function fills(shape) {
    return SIZES.map((n) => ({
        xchainAmount: util.bcmul(FILL_XCHAIN, String(n), 8),
        // attributed: this fill's own cost, which scales with the fill.
        // whole: the entire payment, recorded identically on every row, which is
        // what the pre-flag shape did.
        coinAmount: shape === 'attributed'
            ? util.bcmul(FILL_COIN, String(n), 8)
            : WHOLE_PAYMENT,
    }));
}

// The reference anchors the winsorize band. It is set to the true rate so the
// band is centred on truth and the wrong-shape case below is judged against it
// rather than against itself.
const REF = TRUE_RATE;

describe('XCHAIN rate against the batched dispense fill shape', function () {

    it('prices three fills that each record their attributed share at the true rate', function () {
        const out = deriveXchainRate(util, fills('attributed'), REF);
        expect(out).to.not.equal(null);
        expect(out.rate).to.equal(TRUE_RATE);
    });

    it('would price the SAME trade above the true rate if a row recorded the whole payment', function () {
        // The pre-flag shape. This is deliberately asserted rather than left as
        // prose: it is the only thing that makes the case above evidence instead
        // of a tautology, and it records the DIRECTION of the old error, which is
        // an overstatement of what XCHAIN costs, not an understatement.
        const out = deriveXchainRate(util, fills('whole'), REF);
        expect(out).to.not.equal(null);
        expect(util.bcgt(out.rate, TRUE_RATE)).to.equal(true);
    });

    it('reports the coin actually paid, so a wrong shape cannot be hidden by the band', function () {
        // totalCoin is summed pre-winsorize and is the volume metric that decides
        // whether the market is real enough to supersede the bootstrap. If the
        // clamp masked a wrong-shaped row in the rate, this is where it still shows.
        const right = deriveXchainRate(util, fills('attributed'), REF);
        const wrong = deriveXchainRate(util, fills('whole'), REF);
        expect(util.bcgt(wrong.totalCoin, right.totalCoin)).to.equal(true);
    });
});
