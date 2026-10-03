'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const sinon            = require('sinon');
const { expect }       = require('chai');
const PriceAggregator  = require('../../../../../src/oracle/price_aggregator');
const { createMockHub } = require('../../../../helpers/mockHub');

// The cut's arm writer inserts per-chain testnet keys beside the shared sentinel and
// leaves the bare `testnet` unarmed, so ingest must resolve the key of the source chain.
describe('PriceAggregator.receiveOraclePrice() PRICE v1 canonical gate on the writer-produced table', function () {
    const priceScale = require('../../../../../src/consensus/gates/price_scale_gate.js');
    const INSTANT = 1791019443;
    const table = priceScale.PRICE_V1_CANONICAL_ACTIVATION;
    let saved, hub, agg;
    const VALID = {
        source_address: 'addr1', coin: 'BTC', tick: 'GOLD', fiat: 'USD',
        value: '1.23', block_time: 1700000000, action_index: 7
    };

    beforeEach(function () {
        saved = Object.assign({}, table);
        Object.assign(table, { testnet: 9999999999, 'BTC:testnet': INSTANT, 'LTC:testnet': INSTANT, 'DOGE:testnet': INSTANT });
        hub = createMockHub();
        hub.network = 'testnet';
        agg = new PriceAggregator(hub);
    });

    afterEach(function () {
        for (const key of Object.keys(table)) delete table[key];
        Object.assign(table, saved);
        sinon.restore();
    });

    for (const chain of ['BTC', 'LTC', 'DOGE']) {
        it('refuses a non-canonical value from ' + chain + ' exactly at the armed instant', async function () {
            const below = await agg.receiveOraclePrice(chain, Object.assign({}, VALID, { value: '01.5', block_time: INSTANT - 1 }));
            expect(below.reason).to.not.equal('invalid value');
            const at = await agg.receiveOraclePrice(chain, Object.assign({}, VALID, { value: '01.5', block_time: INSTANT }));
            expect(at).to.deep.equal({ accepted: false, reason: 'invalid value' });
        });
    }
});
