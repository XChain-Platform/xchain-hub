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
 * test/unit/price_sig_tally_activation.test.js
 *
 * PRICE v0 signature-tally ordering flag-day , hub side.
 *
 * The hub does not trust the pushing indexer: it re-verifies every round's
 * signatures before storing it as finalized. That makes its tally the indexer's
 * twin, and the two must agree on WHERE a pubkey enters the dedupe set. If the
 * hub flipped first it would finalize rounds the chain rejects; if it flipped
 * last it would withhold on rounds the chain accepts. Either way the federation
 * and the ledger disagree, so this file guards the vendored copy against the
 * indexer's byte for byte, and pins the predicate's fail-closed edges.
 */

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const local = require('../../src/price_sig_tally_activation.js');

// Sibling checkout, same resolution convention as price_pair_activation.test.js:
// an explicit env path for CI (actions/checkout cannot write above the workspace),
// falling back to the dev sibling layout. Absent -> skip, unless CI demands it.
const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-indexer');
const TWIN_PATH  = path.join(INDEXER_DIR, 'src', 'price_sig_tally_activation.js');
const LOCAL_PATH = path.join(__dirname, '..', '..', 'src', 'price_sig_tally_activation.js');

describe('PRICE v0 signature-tally flag-day : hub copy @regression', function () {

    describe('byte-identity with the xchain-indexer twin', function () {
        before(function () {
            if (!fs.existsSync(TWIN_PATH)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the indexer twin was not found at ' + TWIN_PATH);
                this.skip();
            }
        });

        it('is byte-identical to xchain-indexer/src/price_sig_tally_activation.js', function () {
            // Byte-identity rather than value-identity: the activation map AND the
            // fail-closed edge cases all decide which tally rule a round is judged
            // under, and a value-only check would miss a divergent guard clause.
            expect(fs.readFileSync(LOCAL_PATH, 'utf8'))
                .to.equal(fs.readFileSync(TWIN_PATH, 'utf8'),
                    'the hub copy has drifted from the indexer twin; the hub would tally ' +
                    'PRICE rounds under a different rule than the chain that carries them');
        });
    });

    describe('predicate', function () {
        it('is inactive below the mainnet anchor and active at/above it', function () {
            expect(local.PRICE_SIG_TALLY_ACTIVATION.mainnet).to.equal(969500);
            expect(local.isPriceSigTallyVerifyFirstActive(969499, 'mainnet')).to.equal(false);
            expect(local.isPriceSigTallyVerifyFirstActive(969500, 'mainnet')).to.equal(true);
        });

        it('is active from genesis on testnet and regtest', function () {
            expect(local.isPriceSigTallyVerifyFirstActive(0, 'testnet')).to.equal(true);
            expect(local.isPriceSigTallyVerifyFirstActive(0, 'regtest')).to.equal(true);
        });

        it('fails closed when the hub cannot resolve its network or the round anchor', function () {
            // A hub whose `network` is unset must not be the single node in the
            // federation tallying under the new rule.
            expect(local.isPriceSigTallyVerifyFirstActive(999999999, undefined)).to.equal(false);
            for (const bad of [null, undefined, '', false, 'abc']) {
                expect(local.isPriceSigTallyVerifyFirstActive(bad, 'regtest')).to.equal(false);
            }
        });
    });
});
