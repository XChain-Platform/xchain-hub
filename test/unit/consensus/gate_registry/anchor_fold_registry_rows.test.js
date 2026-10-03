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

// The cut's arm writer inserts per-chain testnet keys and leaves the bare testnet
// sentinel unarmed, so the publisher's fold check must resolve 'DOGE:testnet'.
describe('anchor fold gate on the writer-produced per-chain testnet table', function () {
    const { registry: core } = require('../../../../src/consensus/gate_registry/core.js');
    const { isAnchorFoldActive } = require('../../../../src/anchor/publisher/canonical_forms.js');
    const DOGE_HEIGHT = 67960786;
    let saved;

    beforeEach(function () {
        if (!registry.has(KEYS[0])) this.skip();
        saved = core.overlay;
        core.overlay = (key, value) => {
            const base = saved ? saved(key, value) : value;
            if (key !== KEYS[0]) return base;
            return Object.assign({}, base, { 'BTC:testnet': 154939, 'LTC:testnet': 4905307, 'DOGE:testnet': DOGE_HEIGHT });
        };
    });
    afterEach(function () { if (saved !== undefined) core.overlay = saved; });

    it('enters the fold era at the DOGE activation height inclusive', function () {
        assert.strictEqual(isAnchorFoldActive(DOGE_HEIGHT - 1, 'testnet'), false);
        assert.strictEqual(isAnchorFoldActive(DOGE_HEIGHT, 'testnet'), true);
    });
});
