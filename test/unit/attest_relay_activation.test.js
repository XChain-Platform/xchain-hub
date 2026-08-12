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
 * test/unit/attest_relay_activation.test.js
 *
 * ATTEST cross-chain relay flag-day, hub side.
 *
 * The hub decides WHEN to broadcast an ATTEST v3/v4 relay leg; the indexers
 * decide whether to ACCEPT one. A one-sided edit to either copy of the gate
 * either kills the relay (the hub broadcasts legs the fleet rejects) or forks
 * acceptance at the flag-day. The indexer twin already asserts byte-identity
 * from its side, but that assertion only runs in the INDEXER suite, and it
 * skips outright when the hub checkout is absent. This file is the hub-side
 * half so a hub-only CI run cannot ship a divergent gate green (item 3442).
 *
 * The gate is evaluated against the BTC-anchored SNAPSHOT_BLOCK carried in the
 * relay canonical, never a local height; see the module header for why gating
 * on a local LTC/DOGE height would ship the rule live instead of inert.
 */

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const local = require('../../src/attest_relay_activation.js');

// Sibling checkout, same resolution convention as price_pair_activation.test.js:
// an explicit env path for CI (actions/checkout cannot write above the workspace),
// falling back to the dev sibling layout. Absent -> skip, unless CI demands it.
const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-indexer');
const TWIN_PATH  = path.join(INDEXER_DIR, 'src', 'attest_relay_activation.js');
const LOCAL_PATH = path.join(__dirname, '..', '..', 'src', 'attest_relay_activation.js');

describe('ATTEST relay flag-day: hub copy @regression', function () {

    describe('byte-identity with the xchain-indexer twin', function () {
        before(function () {
            if (!fs.existsSync(TWIN_PATH)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the indexer twin was not found at ' + TWIN_PATH);
                this.skip();
            }
        });

        // Byte-identity, not value-identity: these twins carry no per-file
        // self-reference (the module header names BOTH copies precisely so this
        // comparison can admit no exceptions), so comment drift is drift too.
        it('is byte-identical to xchain-indexer/src/attest_relay_activation.js', function () {
            expect(fs.readFileSync(LOCAL_PATH, 'utf8'))
                .to.equal(fs.readFileSync(TWIN_PATH, 'utf8'),
                    'the hub copy has drifted from the indexer twin; a one-sided edit ' +
                    'either kills the relay or forks acceptance at the flag-day');
        });

        it('agrees with the twin predicate across the boundary and the failure cases', function () {
            const twin = require(TWIN_PATH);
            expect(local.ATTEST_RELAY_ACTIVATION).to.deep.equal(twin.ATTEST_RELAY_ACTIVATION);
            for (const [block, network] of
                [[962999, 'mainnet'], [963000, 'mainnet'], [0, 'regtest'], [0, 'testnet'], [7, 'bogusnet']]) {
                expect(local.isAttestRelayActive(block, network),
                    'predicate disagreed at ' + network + ':' + block)
                    .to.equal(twin.isAttestRelayActive(block, network));
            }
        });
    });

    describe('the gate this hub will enforce', function () {
        it('is armed on the ratified BTC anchor, genesis-on off mainnet', function () {
            expect(local.ATTEST_RELAY_ACTIVATION.mainnet).to.equal(963000);
            expect(local.ATTEST_RELAY_ACTIVATION.testnet).to.equal(0);
            expect(local.ATTEST_RELAY_ACTIVATION.regtest).to.equal(0);
        });

        it('is INERT below the anchor and live at it', function () {
            expect(local.isAttestRelayActive(962999, 'mainnet')).to.equal(false);
            expect(local.isAttestRelayActive(963000, 'mainnet')).to.equal(true);
            expect(local.isAttestRelayActive(963001, 'mainnet')).to.equal(true);
        });

        it('is active from genesis on the test networks so regtest exercises the relay', function () {
            expect(local.isAttestRelayActive(0, 'regtest')).to.equal(true);
            expect(local.isAttestRelayActive(0, 'testnet')).to.equal(true);
        });

        // The hub broadcasts on this gate. An un-evaluatable snapshot must land OFF,
        // never on, or the hub emits legs the fleet is still rejecting.
        it('fails closed on anything it cannot evaluate', function () {
            expect(local.isAttestRelayActive(5, 'bogusnet')).to.equal(false);
            expect(local.isAttestRelayActive('not-a-number', 'mainnet')).to.equal(false);
            expect(local.isAttestRelayActive(null, 'mainnet')).to.equal(false);
            expect(local.isAttestRelayActive(undefined, 'mainnet')).to.equal(false);
        });
    });
});
