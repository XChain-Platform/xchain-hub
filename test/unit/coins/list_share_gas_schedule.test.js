'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const coins = require('../../../src/coins');
const Prices = require('../../../src/hub/prices.js');

const EXPECTED_GAS = {
    LIST_SHARE: 100000,
    LIST_SHARED_EDIT_BASE: 5000,
    LIST_SHARED_EDIT_PER_ITEM: 100,
};

const EXPECTED_XCHAIN = {
    LIST_SHARE: '1.00000000',
    LIST_SHARED_EDIT_BASE: '0.05000000',
    LIST_SHARED_EDIT_PER_ITEM: '0.00100000',
};

describe('Shared-list gas schedule', function () {
    for (const tick of coins.ALLOWED_COINS) {
        for (const network of coins.NETWORKS) {
            it(`pins the shared-list gas entries for ${tick}/${network}`, function () {
                const config = coins.getCoinConfig(tick, network);
                for (const [action, gas] of Object.entries(EXPECTED_GAS)) {
                    expect(config.GAS_SCHEDULE[action], action).to.equal(gas);
                }
            });

            it(`quotes the shared-list actions for ${tick}/${network}`, async function () {
                const prices = new Prices();
                prices.network = network;
                prices.db = { getConfig: async () => ({}) };
                prices.getPrice = async (pair) => ({
                    price: pair === 'XCHAIN/USD' ? '1.00' : '100.00',
                });

                for (const [action, amount] of Object.entries(EXPECTED_XCHAIN)) {
                    const quote = await prices.getFeeQuote(action, tick);
                    expect(quote.gasCost, action).to.equal(EXPECTED_GAS[action]);
                    expect(quote.gasPrice, action).to.equal('0.00001000');
                    expect(quote.xchainAmount, action).to.equal(amount);
                }
            });
        }
    }
});
