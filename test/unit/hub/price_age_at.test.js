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

const { advisoryAgeSecondsAt } = require('../../../src/hub/price_age_at.js');

const LEGACY_SECONDS = 1800;
const HOURLY_SECONDS = 4500;

function ageAt(network, coin, tip, hourlySeconds = HOURLY_SECONDS) {
    return advisoryAgeSecondsAt({
        network,
        coin,
        tip,
        legacySeconds: LEGACY_SECONDS,
        hourlySeconds
    });
}

describe('advisory age at tip', function () {
    it('uses the gated bound on regtest from tip zero for each quoted chain', function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(ageAt('regtest', coin, 0), HOURLY_SECONDS);
        }
    });

    it('keeps the legacy bound on unarmed networks', function () {
        for (const coin of ['BTC', 'LTC', 'DOGE']) {
            assert.strictEqual(ageAt('testnet', coin, 1), LEGACY_SECONDS);
        }
        assert.strictEqual(ageAt('mainnet', 'BTC', 9999999998), LEGACY_SECONDS);
    });

    it('keeps the legacy bound when the tip is unknown or invalid', function () {
        for (const tip of [null, -1]) {
            assert.strictEqual(ageAt('regtest', 'BTC', tip), LEGACY_SECONDS);
        }
    });

    it('keeps the legacy bound when the gated bound is missing', function () {
        assert.strictEqual(advisoryAgeSecondsAt({
            network: 'regtest',
            coin: 'BTC',
            tip: 0,
            legacySeconds: LEGACY_SECONDS,
            hourlySeconds: undefined
        }), LEGACY_SECONDS);
    });

    it('preserves legacy-bound validation', function () {
        assert.throws(() => advisoryAgeSecondsAt({
            network: 'regtest',
            coin: 'BTC',
            tip: 0,
            legacySeconds: 0,
            hourlySeconds: HOURLY_SECONDS
        }), TypeError);
    });
});
