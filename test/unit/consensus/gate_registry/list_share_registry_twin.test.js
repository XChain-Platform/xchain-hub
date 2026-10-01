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
const eq = require('../../../../src/consensus/equivocation_header.js');

const PRODUCER_KEY = 'list_share_producer_activation.LIST_SHARE_PRODUCER_ACTIVATION';

describe('list-share registry twin', function () {
    it('registers the producer activation as a network-only height map', function () {
        assert.deepStrictEqual(registry.get(PRODUCER_KEY), {
            mainnet: 9999999999,
            testnet: 154777,
            regtest: 0,
        });
        assert.strictEqual(registry.activeAt(PRODUCER_KEY, 'mainnet', 'BTC', 9999999998), false);
        assert.strictEqual(registry.activeAt(PRODUCER_KEY, 'testnet', 'BTC', 154776), false);
        assert.strictEqual(registry.activeAt(PRODUCER_KEY, 'testnet', 'BTC', 154777), true);
        assert.strictEqual(registry.activeAt(PRODUCER_KEY, 'regtest', 'BTC', 0), true);
    });

    it('exports the dedicated list-share equivocation tag', function () {
        assert.strictEqual(eq.ENGINE_TAGS.LIST_SHARE, 'XLISTSHARE');
    });
});
