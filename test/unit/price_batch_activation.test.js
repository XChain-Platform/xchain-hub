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
 **********************************************************************
 * test/unit/price_batch_activation.test.js
 *
 * PRICE v2 batching flag-day, hub side.
 *
 * The hub and the chain must agree on when a PRICE|2 batch is even admissible.
 * The hub decides when it runs the post-window batch-signing round, and the
 * indexer decides again when the batch lands on chain. If the hub signs before
 * the chain would accept, or the chain accepts before the hub would sign, the
 * federation and the ledger disagree, so this file guards the vendored copy
 * against the indexer's byte for byte.
 */

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const local = require('../../src/price_batch_activation.js');

// Sibling checkout, same resolution convention as price_pair_activation.test.js:
// an explicit env path for CI (actions/checkout cannot write above the workspace),
// falling back to the dev sibling layout. Absent -> skip, unless CI demands it.
const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-indexer');
const TWIN_PATH  = path.join(INDEXER_DIR, 'src', 'price_batch_activation.js');
const LOCAL_PATH = path.join(__dirname, '..', '..', 'src', 'price_batch_activation.js');

describe('PRICE v2 batching flag-day: hub copy @regression', function () {

    describe('byte-identity with the xchain-indexer twin', function () {
        before(function () {
            if (!fs.existsSync(TWIN_PATH)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the indexer twin was not found at ' + TWIN_PATH);
                this.skip();
            }
        });

        it('is byte-identical to xchain-indexer/src/price_batch_activation.js', function () {
            // Byte-identity rather than value-identity: the activation map AND the
            // fail-closed edge cases both have to match, and a value-only check
            // would miss a divergent guard clause.
            expect(fs.readFileSync(LOCAL_PATH, 'utf8'))
                .to.equal(fs.readFileSync(TWIN_PATH, 'utf8'),
                    'the hub copy has drifted from the indexer twin; the hub would sign a batch ' +
                    'the chain rejects, or withhold on a batch it would accept');
        });
    });

    describe('the bound this hub will enforce', function () {
        it('is still UNARMED on mainnet, so nothing changes there yet', function () {
            expect(local.PRICE_BATCH_ACTIVATION.mainnet).to.equal(9999999999);
            expect(local.isPriceBatchActive(Math.floor(Date.now() / 1000), 'mainnet')).to.equal(false);
        });

        it('is genesis-on for regtest and testnet', function () {
            expect(local.isPriceBatchActive(0, 'regtest')).to.equal(true);
            expect(local.isPriceBatchActive(0, 'testnet')).to.equal(true);
        });

        it('fails closed on an unknown network or missing block time', function () {
            // The hub decides when to run the batch-signing round; an un-evaluatable
            // gate must land on "not active" the rest of the fleet would also land on,
            // never on "active" early.
            expect(local.isPriceBatchActive(0, 'not-a-network')).to.equal(false);
            expect(local.isPriceBatchActive(null, 'regtest')).to.equal(false);
            expect(local.isPriceBatchActive(undefined, 'regtest')).to.equal(false);
        });
    });
});
