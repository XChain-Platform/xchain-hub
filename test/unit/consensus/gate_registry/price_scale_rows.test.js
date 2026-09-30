/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const registry = require('../../../../src/consensus/gate_registry.js');
const gate = require('../../../../src/consensus/gates/price_scale_gate.js');

const PREFIX = 'price_scale_activation.';
const REQUIRED = [
    'PRICE_SCALE_MAX_DECIMALS',
    'PRICE_SCALE_ACTIVATION',
    'PRICE_VALUE_RE_LEGACY',
    'PRICE_VALUE_RE_CANONICAL',
];

function assertSameValue(actual, expected, message) {
    if(actual instanceof RegExp || expected instanceof RegExp) {
        assert.ok(actual instanceof RegExp, message + ' gate value is a RegExp');
        assert.ok(expected instanceof RegExp, message + ' registry value is a RegExp');
        assert.deepStrictEqual(
            { source: actual.source, flags: actual.flags },
            { source: expected.source, flags: expected.flags },
            message
        );
        return;
    }
    assert.deepStrictEqual(actual, expected, message);
}

describe('price scale gate registry rows', function () {
    it('registers every price scale key exactly once and includes the required four', function () {
        const keys = registry.keys().filter((key) => key.startsWith(PREFIX));
        assert.strictEqual(keys.length, new Set(keys).size, 'duplicate price scale registry key');
        for(const name of REQUIRED)
            assert.strictEqual(keys.filter((key) => key === PREFIX + name).length, 1, PREFIX + name);
    });

    it('exports the required four with the same values as their registry rows', function () {
        for(const name of REQUIRED) {
            assert.ok(Object.prototype.hasOwnProperty.call(gate, name), name + ' is exported');
            assertSameValue(gate[name], registry.get(PREFIX + name), name);
        }
    });

    it('keeps all uppercase gate exports and all price scale registry rows in lockstep', function () {
        const exports = Object.keys(gate).filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name));
        const rows = registry.keys()
            .filter((key) => key.startsWith(PREFIX))
            .map((key) => key.slice(PREFIX.length));

        assert.deepStrictEqual(exports.slice().sort(), rows.slice().sort());
        for(const name of exports)
            assertSameValue(gate[name], registry.get(PREFIX + name), name);
    });

    it('pins the activation, decimal limit and canonical matcher behavior', function () {
        assert.deepStrictEqual(registry.get(PREFIX + 'PRICE_SCALE_ACTIVATION'), {
            mainnet: 0,
            testnet: 0,
            regtest: 0,
        });
        assert.strictEqual(registry.get(PREFIX + 'PRICE_SCALE_MAX_DECIMALS'), 8);

        const canonical = registry.get(PREFIX + 'PRICE_VALUE_RE_CANONICAL');
        for(const value of ['1.5', '0.12345678', '12345.12345678'])
            assert.strictEqual(canonical.test(value), true, value + ' is canonical');
        for(const value of ['01.5', '00', '1.123456789'])
            assert.strictEqual(canonical.test(value), false, value + ' is not canonical');
    });
});
