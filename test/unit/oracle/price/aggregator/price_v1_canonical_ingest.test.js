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

const { expect }       = require('chai');
const PriceAggregator  = require('../../../../../src/oracle/price_aggregator');
const { createMockHub } = require('../../../../helpers/mockHub');

const PADDED_VALUE = '0'.repeat(297) + '1.5';
const PADDED_FEE   = '0'.repeat(297) + '0.5';

const NETWORKS = [
    { network: 'mainnet', sourceChain: 'BTC' },
    { network: 'testnet', sourceChain: 'TBTC' },
    { network: 'regtest', sourceChain: 'TBTC' }
];

async function receivePrice(network, sourceChain, value, fee) {
    const hub = createMockHub();
    hub.network = network;
    hub.db.doQuery.callsFake(async (sql) => (/^INSERT INTO oracle_prices/.test(sql) ? {} : []));

    const agg = new PriceAggregator(hub);
    const priceData = {
        source_address: 'addr1', coin: 'BTC', tick: 'GOLD', fiat: 'USD', value,
        block_time: 1700000000, action_index: 7
    };
    if (fee !== undefined) priceData.fee = fee;
    return agg.receiveOraclePrice(sourceChain, priceData);
}

describe('PriceAggregator.receiveOraclePrice() PRICE v1 zero-padded values', function () {
    for (const { network, sourceChain } of NETWORKS.slice(0, 2)) {
        it('accepts 300-character zero-padded value and fee on ' + network, async function () {
            const result = await receivePrice(network, sourceChain, PADDED_VALUE, PADDED_FEE);
            expect(result).to.deep.equal({ accepted: true });
        });
    }
});

describe('PriceAggregator.receiveOraclePrice() PRICE v1 honest values', function () {
    for (const { network, sourceChain } of NETWORKS) {
        for (const fee of ['0', '0.01', '1', undefined]) {
            const feeLabel = fee === undefined ? 'absent fee' : 'fee ' + fee;
            it('accepts value 12345.12345678 with ' + feeLabel + ' on ' + network, async function () {
                const result = await receivePrice(network, sourceChain, '12345.12345678', fee);
                expect(result).to.deep.equal({ accepted: true });
            });
        }
    }
});
