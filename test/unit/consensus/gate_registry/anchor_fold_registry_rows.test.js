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

// The hub publisher fold gates on these two rows, so they are read here through
// the hub's own registry entry rather than the indexer canonical they twin.

const assert = require('assert');

const registry = require('../../../../src/consensus/gate_registry.js');

const ENV = 'XC_ANCHOR_FOLD_REGTEST_ACTIVATION';
const KEYS = [
    'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION',
    'archive_section_verdict_activation.ARCHIVE_SECTION_VERDICT_STATE_HASH_ACTIVATION',
];
const present = KEYS.filter((key) => registry.has(key));

function withEnv(value, fn) {
    const saved = process.env[ENV];
    try {
        if (value === undefined) delete process.env[ENV];
        else process.env[ENV] = value;
        return fn();
    } finally {
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
    }
}

describe('gate_registry: anchor fold rows', function () {
    it('copies both shared rows together or neither row', function () {
        assert.ok(present.length === 0 || present.length === 2);
    });

    it('ships both activation maps inert on every network', function () {
        // These cases wait for this repo's SHARED-block twin to carry the pair.
        if (present.length !== 2) this.skip();
        withEnv(undefined, () => {
            for (const key of KEYS) {
                assert.deepStrictEqual(registry.get(key), {
                    mainnet: 9999999999,
                    testnet: 9999999999,
                    regtest: null,
                });
            }
        });
    });

    it('arms both regtest entries at height 0 from the shared venue variable', function () {
        // These cases wait for this repo's SHARED-block twin to carry the pair.
        if (present.length !== 2) this.skip();
        withEnv('armed', () => {
            for (const key of KEYS) assert.strictEqual(registry.get(key).regtest, 0);
        });
    });

    it('keeps both rows inactive on public networks before their sentinel height', function () {
        // These cases wait for this repo's SHARED-block twin to carry the pair.
        if (present.length !== 2) this.skip();
        withEnv(undefined, () => {
            for (const key of KEYS) {
                assert.strictEqual(registry.activeAt(key, 'mainnet', null, 99999999, null), false);
                assert.strictEqual(registry.activeAt(key, 'testnet', null, 99999999, null), false);
            }
        });
    });
});
