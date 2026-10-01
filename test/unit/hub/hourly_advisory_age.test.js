'use strict';

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
 ********************************************************************/

const assert = require('assert');
const sinon = require('sinon');

const gateRegistry = require('../../../src/consensus/gate_registry');
const Prices = require('../../../src/hub/prices.js');

describe('hourly advisory age', function () {
    afterEach(function () {
        sinon.restore();
    });

    it('refuses a 3000 second old round below the gate and quotes at the gate', async function () {
        sinon.useFakeTimers({ now: 2000000 * 1000, toFake: ['Date'] });
        let tip = 99;
        let hub = new Prices();
        hub.network = 'testnet';
        hub.db = {
            getConfig: sinon.stub().resolves({}),
            getChainTip: sinon.stub().callsFake(async () => ({ blockHeight: tip })),
            getFinalizedPriceSnapshotByCoinPair: sinon.stub().callsFake(async (coinPair) => [{
                coin_pair: coinPair,
                price: coinPair === 'XCHAIN/USD' ? '1.00' : '100000',
                block_timestamp: 2000000 - 3000
            }])
        };
        let activeAt = sinon.stub(gateRegistry, 'activeAt').callsFake(
            (gate, network, coin, height) => {
                assert.strictEqual(
                    gate,
                    'oracle_price_age_hourly_activation.ORACLE_PRICE_AGE_HOURLY_ACTIVATION'
                );
                assert.strictEqual(network, 'testnet');
                assert.strictEqual(coin, 'BTC');
                return height >= 100;
            }
        );

        await assert.rejects(
            hub.getFeeQuote('ISSUE', 'BTC'),
            /XCHAIN\/USD oracle price unavailable/
        );

        tip = 100;
        let quote = await hub.getFeeQuote('ISSUE', 'BTC');
        assert.strictEqual(quote.xchainUsd, '1.00000000');
        assert.strictEqual(quote.coinUsd, '100000.00000000');
        assert.deepStrictEqual(hub.db.getChainTip.args, [
            ['BTC', 'testnet'],
            ['BTC', 'testnet']
        ]);
        assert.deepStrictEqual(activeAt.args.map(call => call.slice(1, 4)), [
            ['testnet', 'BTC', 99],
            ['testnet', 'BTC', 100]
        ]);
    });
});
