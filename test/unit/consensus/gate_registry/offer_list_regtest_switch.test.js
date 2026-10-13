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

// A regtest venue arms CROSS_CHAIN_OFFER_LIST_ENFORCEMENT from
// XC_OFFER_LIST_REGTEST_ACTIVATION when the row is read, with no module purge.

const assert = require('assert');
const registry = require('../../../../src/consensus/gate_registry.js');

const KEY = 'cross_chain/dex/offer_lists.CROSS_CHAIN_OFFER_LIST_ENFORCEMENT';
const ENV = 'XC_OFFER_LIST_REGTEST_ACTIVATION';

function withEnv(value, fn) {
    const saved = process.env[ENV];
    if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
    try { return fn(); } finally {
        if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
    }
}

describe('offer list enforcement regtest switch', function () {
    it('stays unarmed on regtest when the variable is unset or off', function () {
        for (const v of [undefined, '', 'off']) {
            withEnv(v, () => {
                assert.strictEqual(registry.get(KEY).regtest, registry.UNARMED, String(v));
                assert.strictEqual(registry.activeAt(KEY, 'regtest', null, 1000, 0), false);
            });
        }
    });

    it('arms regtest from genesis or a named height at the next read', function () {
        withEnv('armed', () => {
            assert.strictEqual(registry.get(KEY).regtest, 0);
            assert.strictEqual(registry.activeAt(KEY, 'regtest', null, 0, 0), true);
        });
        withEnv('250', () => {
            assert.strictEqual(registry.activeAt(KEY, 'regtest', null, 249, 0), false);
            assert.strictEqual(registry.activeAt(KEY, 'regtest', null, 250, 0), true);
        });
        withEnv(undefined, () => assert.strictEqual(registry.get(KEY).regtest, registry.UNARMED));
    });

    it('leaves every other network and the committed row untouched', function () {
        const bare = withEnv(undefined, () => registry.copy(KEY));
        withEnv('armed', () => {
            const row = registry.get(KEY);
            for (const k of Object.keys(bare)) if (k !== 'regtest') assert.strictEqual(row[k], bare[k], k);
            assert.strictEqual(registry.activeAt(KEY, 'mainnet', null, 1e6, 0), false);
        });
    });

    it('fails closed on a refused value', function () {
        withEnv('bogus', () => assert.strictEqual(registry.get(KEY).regtest, registry.UNARMED));
    });

    it('does not arm any other row', function () {
        withEnv('armed', () => {
            assert.strictEqual(registry.get('validators/governance/rules.GOV_TALLY_FAILOVER_ACTIVATION').mainnet, registry.UNPINNED);
            assert.strictEqual(registry.get('anchor/reorg_handler/snapshot_lock.REORG_SNAPSHOT_ACTIVATION').mainnet, registry.UNARMED);
        });
    });
});
