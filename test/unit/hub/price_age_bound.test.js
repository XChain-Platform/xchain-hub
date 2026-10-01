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

const { pickAdvisoryAgeSeconds } = require('../../../src/hub/price_age_bound.js');

describe('advisory age pick', function () {
    it('keeps the legacy bound while the hourly gate is off', function () {
        assert.strictEqual(pickAdvisoryAgeSeconds({
            hourlyActive: false,
            legacySeconds: 1800,
            hourlySeconds: 4500
        }), 1800);
    });

    it('uses a valid hourly bound while the hourly gate is on', function () {
        assert.strictEqual(pickAdvisoryAgeSeconds({
            hourlyActive: true,
            legacySeconds: 1800,
            hourlySeconds: 4500
        }), 4500);
    });

    it('falls back for a missing, zero, or non-integer hourly bound', function () {
        for (const hourlySeconds of [undefined, 0, 4500.5]) {
            assert.strictEqual(pickAdvisoryAgeSeconds({
                hourlyActive: true,
                legacySeconds: 1800,
                hourlySeconds
            }), 1800);
        }
    });

    it('requires the legacy bound to be a positive safe integer', function () {
        for (const legacySeconds of [undefined, 0, -1, 1800.5, Number.MAX_SAFE_INTEGER + 1]) {
            assert.throws(() => pickAdvisoryAgeSeconds({
                hourlyActive: true,
                legacySeconds,
                hourlySeconds: 4500
            }), TypeError);
        }
    });
});
