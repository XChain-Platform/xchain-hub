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
 * test/unit/price_pair_activation.test.js
 *
 * PRICE v0 pair-name widening flag-day, hub side.
 *
 * The hub and the chain must agree on which pair names are well-formed. The hub
 * decides twice per round - once when a follower co-signs a PROPOSE, once when a
 * validated round is ingested - and the indexer decides a third time when the
 * round lands on chain. If the hub's bound is wider than the chain's it co-signs
 * and finalizes rounds the chain will reject; if narrower, it withholds on rounds
 * the chain would accept. Either way the federation and the ledger disagree, so
 * this file guards the vendored copy against the indexer's byte for byte.
 */

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const local = require('../../src/price_pair_activation.js');

// Sibling checkout, same resolution convention as ConsensusPrimitiveConformance:
// an explicit env path for CI (actions/checkout cannot write above the workspace),
// falling back to the dev sibling layout. Absent -> skip, unless CI demands it.
const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-indexer');
const TWIN_PATH  = path.join(INDEXER_DIR, 'src', 'price_pair_activation.js');
const LOCAL_PATH = path.join(__dirname, '..', '..', 'src', 'price_pair_activation.js');

describe('PRICE v0 pair-name widening flag-day: hub copy @regression', function () {

    describe('byte-identity with the xchain-indexer twin', function () {
        before(function () {
            if (!fs.existsSync(TWIN_PATH)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the indexer twin was not found at ' + TWIN_PATH);
                this.skip();
            }
        });

        it('is byte-identical to xchain-indexer/src/price_pair_activation.js', function () {
            // Byte-identity rather than value-identity: the activation map, the two
            // bounds AND the fail-closed edge cases all have to match, and a
            // value-only check would miss a divergent guard clause.
            expect(fs.readFileSync(LOCAL_PATH, 'utf8'))
                .to.equal(fs.readFileSync(TWIN_PATH, 'utf8'),
                    'the hub copy has drifted from the indexer twin; the hub would co-sign ' +
                    'and finalize rounds the chain rejects, or withhold on rounds it accepts');
        });
    });

    describe('the bound this hub will enforce', function () {
        it('is still UNARMED on mainnet, so nothing changes there yet', function () {
            expect(local.PRICE_PAIR_WIDEN_ACTIVATION.mainnet).to.equal(9999999999);
            expect(local.isPricePairWideningActive(Math.floor(Date.now() / 1000), 'mainnet')).to.equal(false);
            expect(local.isValidPricePair('XCHAIN/USD', Math.floor(Date.now() / 1000), 'mainnet')).to.equal(false);
        });

        it('admits XCHAIN/USD on regtest and testnet, where it is genesis-on', function () {
            expect(local.isValidPricePair('XCHAIN/USD', 0, 'regtest')).to.equal(true);
            expect(local.isValidPricePair('XCHAIN/USD', 0, 'testnet')).to.equal(true);
        });

        it('leaves every existing pair valid under both bounds', function () {
            for (const pair of ['BTC/USD', 'LTC/EUR', 'DOGE/KRW']) {
                expect(local.PRICE_PAIR_RE_LEGACY.test(pair), pair).to.equal(true);
                expect(local.PRICE_PAIR_RE_WIDE.test(pair), pair).to.equal(true);
            }
        });

        it('fails closed on an unknown network or missing block time', function () {
            // The hub sees rounds from peers; an un-evaluatable gate must land on the
            // legacy bound the rest of the fleet is enforcing, never on the wider one.
            expect(local.isPricePairWideningActive(0, 'not-a-network')).to.equal(false);
            expect(local.isPricePairWideningActive(null, 'regtest')).to.equal(false);
            expect(local.isPricePairWideningActive(undefined, 'regtest')).to.equal(false);
        });
    });
});
