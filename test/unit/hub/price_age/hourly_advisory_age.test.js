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

const gateRegistry = require('../../../../src/consensus/gate_registry');
const Prices = require('../../../../src/hub/prices.js');

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

// getprice and the advertised oracleMaxPriceAgeSeconds follow the same tip-aware bound
// (9586). Tip 1e9 is past every testnet arming height and tip 1 below it, so no
// activation height is restated here.
describe('hourly advisory age on getprice and the advertised scalar', function () {
    const coins = require('../../../../src/coins');
    const LEGACY = Number(coins.getCoinConfig('BTC', 'testnet').ORACLE_MAX_PRICE_AGE_SECONDS);
    const HOURLY = Number(coins.getCoinConfig('BTC', 'testnet').ORACLE_MAX_PRICE_AGE_HOURLY_SECONDS);
    const ALL = { BTC: 1e9, LTC: 1e9, DOGE: 1e9 };

    function hubAtTips(tips, ageSeconds = 0) {
        let hub = new Prices();
        hub.network = 'testnet';
        hub.db = {
            getChainTip: async (chain) => {
                if (tips[chain] instanceof Error) throw tips[chain];
                return tips[chain] == null ? null : { blockHeight: tips[chain] };
            },
            getFinalizedPriceSnapshotByCoinPair: async (coinPair) => [{
                coin_pair: coinPair, price: '100000', block_timestamp: Math.floor(Date.now() / 1000) - ageSeconds
            }]
        };
        return hub;
    }

    it('a registry pair reads its own chain bound at the tip', async function () {
        assert.ok(HOURLY > LEGACY);
        assert.strictEqual(await hubAtTips(ALL).oracleMaxAgeSecondsInForce('BTC/USD'), HOURLY);
        assert.strictEqual(await hubAtTips({ BTC: 1, LTC: 1e9, DOGE: 1e9 }).oracleMaxAgeSecondsInForce('BTC/USD'), LEGACY);
    });

    it('the pairless scalar is the tightest bound in force across chains', async function () {
        let staggered = hubAtTips({ BTC: 1e9, LTC: 1, DOGE: 1e9 });
        assert.strictEqual(await staggered.oracleMaxAgeSecondsInForce(), LEGACY);
        assert.strictEqual(await staggered.oracleMaxAgeSecondsInForce('XCHAIN/USD'), LEGACY);
        assert.strictEqual(await hubAtTips(ALL).oracleMaxAgeSecondsInForce(), HOURLY);
    });

    it('getprice accepts an hourly-age price after activation and not before', async function () {
        assert.strictEqual((await hubAtTips(ALL, LEGACY + 600).getPriceStatus('BTC/USD')).stale, false);
        assert.strictEqual((await hubAtTips({ BTC: 1 }, LEGACY + 600).getPriceStatus('BTC/USD')).stale, true);
    });

    it('falls back to the legacy bound when the tip read throws, without throwing', async function () {
        let hub = hubAtTips({ BTC: new Error('db down'), LTC: null, DOGE: new Error('db down') });
        assert.strictEqual(await hub.oracleMaxAgeSecondsInForce(), LEGACY);
        assert.strictEqual(await hub.oracleMaxAgeSecondsInForce('BTC/USD'), LEGACY);
    });
});
