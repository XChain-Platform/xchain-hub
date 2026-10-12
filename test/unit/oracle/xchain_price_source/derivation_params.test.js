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
 ********************************************************************/

'use strict';

const assert = require('assert');
const { resolveDerivationParams } =
    require('../../../../src/oracle/xchain_price_source/derivation_params.js');
const {
    XCHAIN_PRICE_WINDOW_BLOCKS,
    XCHAIN_PRICE_CONFIRMATION_BUFFER,
    XCHAIN_PRICE_BOOTSTRAP_XCHAIN_BTC,
    XCHAIN_PRICE_MIN_BTC_VOLUME
} = require('../../../../src/constants.js');

const OVERRIDES = {
    XCHAIN_PRICE_WINDOW_BLOCKS: '25',
    XCHAIN_PRICE_CONFIRMATION_BUFFER: '0',
    XCHAIN_PRICE_BOOTSTRAP_SATS: '5000',
    XCHAIN_PRICE_MIN_BTC_VOLUME: '0.125'
};

const PINNED = {
    windowBlocks: XCHAIN_PRICE_WINDOW_BLOCKS,
    confirmationBuffer: XCHAIN_PRICE_CONFIRMATION_BUFFER,
    bootstrapXchainBtc: XCHAIN_PRICE_BOOTSTRAP_XCHAIN_BTC,
    minBtcVolume: XCHAIN_PRICE_MIN_BTC_VOLUME
};

function withoutLogs(callback) {
    const original = console.log;
    console.log = () => {};
    try {
        return callback();
    } finally {
        console.log = original;
    }
}

describe('resolveDerivationParams', function() {
    it('honors all four overrides on regtest and returns only the public fields', function() {
        const params = resolveDerivationParams({ HUB_NETWORK: 'regtest', ...OVERRIDES });

        assert.deepStrictEqual(Object.keys(params), [
            'windowBlocks',
            'confirmationBuffer',
            'bootstrapXchainBtc',
            'minBtcVolume'
        ]);
        assert.strictEqual(params.windowBlocks, 25);
        assert.strictEqual(params.confirmationBuffer, 0);
        assert.strictEqual(String(params.bootstrapXchainBtc), '0.00005');
        assert.strictEqual(params.minBtcVolume, '0.125');
    });

    for (const network of ['testnet', 'mainnet', undefined]) {
        it('ignores every override on ' + (network || 'an unset network'), function() {
            const config = { ...OVERRIDES };
            if (network !== undefined) config.HUB_NETWORK = network;

            const params = withoutLogs(() => resolveDerivationParams(config));
            assert.deepStrictEqual(params, PINNED);
        });
    }

    for (const network of ['regtest', 'testnet', 'mainnet', undefined]) {
        it('returns constants for empty overrides on ' + (network || 'an unset network'), function() {
            const config = network === undefined ? {} : { HUB_NETWORK: network };

            assert.deepStrictEqual(resolveDerivationParams(config), PINNED);
        });
    }

    for (const value of [0, 0.25, '1.5']) {
        it('accepts finite non-negative minimum volume ' + value, function() {
            const params = resolveDerivationParams({
                HUB_NETWORK: 'regtest',
                XCHAIN_PRICE_MIN_BTC_VOLUME: value
            });

            assert.strictEqual(params.minBtcVolume, String(value));
        });
    }

    for (const value of [-1, '-0.5', Infinity, NaN, 'not-a-number']) {
        it('rejects invalid minimum volume ' + value, function() {
            const params = resolveDerivationParams({
                HUB_NETWORK: 'regtest',
                XCHAIN_PRICE_MIN_BTC_VOLUME: value
            });

            assert.strictEqual(params.minBtcVolume, XCHAIN_PRICE_MIN_BTC_VOLUME);
        });
    }
});
