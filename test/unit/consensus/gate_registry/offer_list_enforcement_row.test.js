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
    it('ships as an unarmed height gate on every network', function () {
        assert.deepStrictEqual(registry.get(KEY), {
            mainnet: registry.UNARMED,
            testnet: registry.UNARMED,
            regtest: registry.UNARMED,
        });
        for (const network of ['mainnet', 'testnet', 'regtest']) {
            assert.strictEqual(registry.activeAt(KEY, network, null, registry.UNARMED - 1, 0), false, network);
        }
    });

    it('pins the row in the hub-only identity without changing the shared gate set', function () {
        const measured = identity.codeIdentity();
        const expected = '{"mainnet":9999999999,"regtest":9999999999,"testnet":9999999999}';

        assert.strictEqual(measured.hub_only_rules_gates[KEY], expected);
        assert.strictEqual(measured.consensus_rules_gates[KEY], undefined);
        assert.deepStrictEqual(pin.hub_only_rules_gates, measured.hub_only_rules_gates);
        assert.strictEqual(pin.hub_only_rules_digest, measured.hub_only_rules_digest);
        assert.strictEqual(pin.hub_only_gate_key_count, measured.hub_only_gate_key_count);
    });
});
