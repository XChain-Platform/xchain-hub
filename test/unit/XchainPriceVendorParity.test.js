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
 * test/unit/XchainPriceVendorParity.test.js
 *
 * The XCHAIN derivation is vendored from xchain-indexer into the hub.
 * The hub COMPUTES the price and the indexer's rows are what it computes from, so a
 * divergence between the two copies is not a tidiness problem: the federation would
 * publish a number the chain's own data does not support, and every validator whose
 * copy differed would land outside the co-sign deviation band.
 *
 * Byte-identity, not value-identity: the rounding mode, the working precision, the
 * winsorization band, the SQL predicates and the fail-closed guards are ALL consensus
 * inputs, and a value-only check would wave through a divergent guard clause.
 */

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const VENDORED = ['xchainPrice.js', 'xchainPriceQuery.js', 'price_pair_activation.js'];

const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-indexer');
const HUB_SRC = path.join(__dirname, '..', '..', 'src');

describe('XCHAIN derivation: vendored-copy parity with xchain-indexer @regression', function () {

    before(function () {
        if (!fs.existsSync(path.join(INDEXER_DIR, 'src'))) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the xchain-indexer sibling was not found at ' + INDEXER_DIR);
            this.skip();
        }
    });

    VENDORED.forEach(function (file) {
        it(file + ' is byte-identical to the indexer twin', function () {
            const twinPath = path.join(INDEXER_DIR, 'src', file);
            // Skip per FILE, not just per sibling-repo. A sibling checkout can exist
            // while a given twin does not: a standalone deploy, or a CI venue serving
            // a sibling from origin while this file is still only local. A
            // hard read there fails the whole suite for a reason that has nothing to
            // do with drift, and the gate would report it as something else entirely.
            if (!fs.existsSync(twinPath)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the twin is missing: ' + twinPath);
                this.skip();
                return;
            }
            const hub  = fs.readFileSync(path.join(HUB_SRC, file), 'utf8');
            const twin = fs.readFileSync(twinPath, 'utf8');
            expect(hub).to.equal(twin,
                file + ' has drifted from xchain-indexer/src/' + file + '; the hub would publish a ' +
                'price the chain data does not support, and this validator would fall outside the ' +
                'co-sign deviation band');
        });
    });

    it('the query module needs nothing from its caller beyond doQuery', function () {
        // What makes the vendoring possible at all. The hub has no indexer Database
        // class, so a stray db.getCoinId()-style call would work in the indexer and
        // throw here - at price-derivation time, in production, on one side only.
        const src = fs.readFileSync(path.join(HUB_SRC, 'xchainPriceQuery.js'), 'utf8');
        // Match call syntax specifically. A bare `db.foo` also matches prose in the
        // module's own comments ("mirrors db.getCoinId's query"), which are not calls.
        const dbCalls = [...src.matchAll(/\bdb\.([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
        expect([...new Set(dbCalls)]).to.deep.equal(['doQuery']);
    });

    it('the formula module takes its bignumber helpers by injection', function () {
        // The hub passes bcmath.js and the indexer passes its Utility; both are
        // verified byte-equivalent. A hard require of either inside the formula would
        // silently bind one implementation into both services.
        const src = fs.readFileSync(path.join(HUB_SRC, 'xchainPrice.js'), 'utf8');
        expect(/require\s*\(/.test(src)).to.equal(false, 'xchainPrice.js must require nothing');
    });
});
