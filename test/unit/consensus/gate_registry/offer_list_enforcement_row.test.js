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
const identity = require('../../../../bin/consensus-identity.js');
const pin = require('../../../../bin/pins/at1-consensus-identity.json');

const KEY = 'cross_chain/dex/offer_lists.CROSS_CHAIN_OFFER_LIST_ENFORCEMENT';

describe('cross-chain offer list enforcement registry row', function () {
    // The testnet heights are read off the registry, so a re-slide of the cut
    // height needs no edit here.
    it('ships as a height gate armed on testnet and unarmed on mainnet and regtest', function () {
        const row = registry.get(KEY);
        assert.strictEqual(row.mainnet, registry.UNARMED);
        assert.strictEqual(row.regtest, registry.UNARMED);
        for (const network of ['mainnet', 'regtest']) {
            assert.strictEqual(registry.activeAt(KEY, network, null, registry.UNARMED - 1, 0), false, network);
        }
        for (const coin of [null, 'BTC', 'LTC', 'DOGE']) {
            const armed = coin === null ? row.testnet : row[coin + ':testnet'];
            assert.ok(Number.isSafeInteger(armed) && armed > 1 && armed < registry.UNARMED, `${coin} testnet armed height`);
            assert.strictEqual(registry.activeAt(KEY, 'testnet', coin, 1, 0), false, `${coin} at 1`);
            assert.strictEqual(registry.activeAt(KEY, 'testnet', coin, armed - 1, 0), false, `${coin} below`);
            assert.strictEqual(registry.activeAt(KEY, 'testnet', coin, armed, 0), true, `${coin} at armed`);
        }
    });

    it('pins the row in the hub-only identity without changing the shared gate set', function () {
        const measured = identity.codeIdentity();

        assert.deepStrictEqual(JSON.parse(measured.hub_only_rules_gates[KEY]), registry.get(KEY));
        assert.strictEqual(measured.consensus_rules_gates[KEY], undefined);
        assert.deepStrictEqual(pin.hub_only_rules_gates, measured.hub_only_rules_gates);
        assert.strictEqual(pin.hub_only_rules_digest, measured.hub_only_rules_digest);
        assert.strictEqual(pin.hub_only_gate_key_count, measured.hub_only_gate_key_count);
    });
});
