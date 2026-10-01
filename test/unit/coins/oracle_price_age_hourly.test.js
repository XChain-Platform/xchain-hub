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
const coins      = require('../../../src/coins');

describe('coin hourly price age key', () => {
    for(const tick of ['BTC', 'LTC', 'DOGE']){
        for(const network of ['mainnet', 'testnet', 'regtest']){
            it(`exposes and hashes the hourly bound for ${tick}/${network}`, () => {
                const config = coins.getCoinConfig(tick, network);
                expect(config.ORACLE_MAX_PRICE_AGE_HOURLY_SECONDS).to.equal(4500);
                expect(config.ORACLE_MAX_PRICE_AGE_SECONDS).to.equal(1800);
                expect(coins.consensusSubset(tick, network))
                    .to.have.property('ORACLE_MAX_PRICE_AGE_HOURLY_SECONDS', 4500);
            });
        }
    }
});
