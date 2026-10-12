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
const priceScale       = require('../../../../../src/consensus/gates/price_scale_gate.js');
const { createMockHub } = require('../../../../helpers/mockHub');

const PADDED_VALUE = '0'.repeat(297) + '1.5';
const PADDED_FEE   = '0'.repeat(297) + '0.5';

const NETWORKS = [
    { network: 'mainnet', sourceChain: 'BTC' },
    { network: 'testnet', sourceChain: 'TBTC' },
    { network: 'regtest', sourceChain: 'TBTC' }
];

async function receivePrice(network, sourceChain, value, fee) {
    const hub = createMockHub({ network });
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

describe('PriceAggregator.receiveOraclePrice() PRICE v1 canonical gate on regtest', function () {
    const overlongValue = '0'.repeat(priceScale.PRICE_V1_VALUE_MAX_LENGTH - 2) + '1.5';
    const overlongFee   = '0'.repeat(priceScale.PRICE_V1_FEE_MAX_LENGTH - 2) + '0.5';
    const cases = [
        ['01.5', '0.5', 'invalid value', 'leading-zero value'],
        ['1.5', '00.5', 'invalid fee', 'leading-zero fee'],
        [overlongValue, '0.5', 'invalid value', 'value one character over its cap'],
        ['1.5', overlongFee, 'invalid fee', 'fee one character over its cap']
    ];

    for (const [value, fee, reason, label] of cases) {
        it('rejects ' + label, async function () {
            const result = await receivePrice('regtest', 'TBTC', value, fee);
            expect(result).to.deep.equal({ accepted: false, reason });
        });
    }
});
