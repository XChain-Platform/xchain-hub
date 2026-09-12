/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * ATTEST_RELAY_REJECT_SLOT: the hub copy of the reject-slot flag day.
 *
 * The two halves of this rule must move together. Above the threshold the indexer
 * persists no `attests` row for a refused ATTEST v3, so the id it named stays free;
 * the hub then has to stop treating a refused row as proof the request is already
 * materialized, or the honest relay is never proposed. Below it the refusal still
 * occupies the id in every indexer's DB, so the hub must keep suppressing the
 * broadcast: a v3 sent into a slot the fleet still considers taken is dropped on
 * arrival, once per poll and once per fee.
 *
 * So the gate has to read the SAME arming state on both sides, which is what the
 * byte-identity case below enforces, and the driver-side behaviour on both sides of
 * the arm is pinned in AttestationRelay.test.js.
 *
 * The plane is a consensus TIMESTAMP, not a height, so the cases here are seconds.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const local = require('../../src/attest_relay_reject_slot_activation.js');

// Sibling checkout, same resolution convention as attest_relay_activation.test.js:
// an explicit env path for CI, falling back to the dev sibling layout. Absent ->
// skip, unless XCHAIN_REQUIRE_SIBLINGS=1 demands it.
const INDEXER_DIR = process.env.XCHAIN_INDEXER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-indexer');
const TWIN_PATH  = path.join(INDEXER_DIR, 'src', 'attest_relay_reject_slot_activation.js');
const LOCAL_PATH = path.join(__dirname, '..', '..', 'src', 'attest_relay_reject_slot_activation.js');

describe('ATTEST relay reject-slot flag-day: hub copy @regression', function () {

    describe('byte-identity with the xchain-indexer twin', function () {
        before(function () {
            if (!fs.existsSync(TWIN_PATH)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the indexer twin was not found at ' + TWIN_PATH);
                this.skip();
            }
        });

        // Byte-identity, not value-identity: the module header names BOTH copies
        // rather than referring to itself, precisely so this comparison can admit no
        // exceptions and comment drift counts as drift.
        it('is byte-identical to xchain-indexer/src/attest_relay_reject_slot_activation.js', function () {
            expect(fs.readFileSync(LOCAL_PATH, 'utf8'))
                .to.equal(fs.readFileSync(TWIN_PATH, 'utf8'),
                    'the hub copy has drifted from the indexer twin; one side then counts a ' +
                    'refused row the other side no longer stores, and the honest relay is ' +
                    'either never proposed or broadcast into a slot the fleet still holds');
        });

        it('agrees with the twin predicate across the boundary and the failure cases', function () {
            const twin = require(TWIN_PATH);
            expect(local.ATTEST_RELAY_REJECT_SLOT_ACTIVATION)
                .to.deep.equal(twin.ATTEST_RELAY_REJECT_SLOT_ACTIVATION);
            for (const [time, network] of
                [[0, 'mainnet'], [1786060800, 'mainnet'], [0, 'testnet'], [0, 'regtest'],
                 [1786060800, 'bogusnet'], ['not-a-number', 'mainnet']]) {
                expect(local.isAttestRelayRejectSlotActive(time, network),
                    'predicate disagreed at ' + network + ':' + time)
                    .to.equal(twin.isAttestRelayRejectSlotActive(time, network));
            }
        });
    });

    describe('the arming state this hub reads', function () {
        it('is armed at genesis on every network', function () {
            expect(local.ATTEST_RELAY_REJECT_SLOT_ACTIVATION.mainnet).to.equal(0);
            expect(local.ATTEST_RELAY_REJECT_SLOT_ACTIVATION.testnet).to.equal(0);
            expect(local.ATTEST_RELAY_REJECT_SLOT_ACTIVATION.regtest).to.equal(0);
        });

        it('is live at the threshold and inert one second below it', function () {
            // Driven against a threshold rather than the armed maps, so the boundary is
            // pinned independently of where the networks happen to be armed today.
            const map = local.ATTEST_RELAY_REJECT_SLOT_ACTIVATION;
            const saved = map.mainnet;
            try {
                map.mainnet = 1786060800;
                expect(local.isAttestRelayRejectSlotActive(1786060799, 'mainnet')).to.equal(false);
                expect(local.isAttestRelayRejectSlotActive(1786060800, 'mainnet')).to.equal(true);
                expect(local.isAttestRelayRejectSlotActive(1786060801, 'mainnet')).to.equal(true);
            } finally {
                map.mainnet = saved;
            }
        });

        // Off is the pre-arm behaviour, and the pre-arm behaviour never spends a fee on
        // a v3 the fleet drops. An un-evaluatable plane must therefore land OFF.
        it('fails closed on anything it cannot evaluate', function () {
            expect(local.isAttestRelayRejectSlotActive(1786060800, 'bogusnet')).to.equal(false);
            expect(local.isAttestRelayRejectSlotActive('not-a-number', 'mainnet')).to.equal(false);
            expect(local.isAttestRelayRejectSlotActive(null, 'mainnet')).to.equal(false);
            expect(local.isAttestRelayRejectSlotActive(undefined, 'mainnet')).to.equal(false);
            expect(local.isAttestRelayRejectSlotActive(NaN, 'mainnet')).to.equal(false);
        });
    });
});
