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

const { ADMISSION_READ_SETS } = require('../../../../src/lib/admission_height/read_sets.js');

const EXPECTED_READ_SETS = {
    cross_chain_matches:        { fields: ['a_chain', 'b_chain'] },
    cross_chain_calls:          { fields: ['target_chain', 'source_chain'] },
    bridge_transfers:           { fields: ['dest_chain'] },
    policy_snapshots:           { every: true },
    list_snapshots:             { every: true },
    attestation_responses:      { chains: ['BTC'] },
    anchor_reward_attestations: { chains: ['BTC'] },
    oracle_prices:              { publishingChain: true },
    price_snapshots:            { every: true },
};

const ENTRY_KEYS = ['fields', 'every', 'chains', 'publishingChain'];

describe('admission read sets', function () {
    it('pins every table name and read-set value', function () {
        assert.deepStrictEqual(ADMISSION_READ_SETS, EXPECTED_READ_SETS);
    });

    it('freezes the table and every entry', function () {
        assert.strictEqual(Object.isFrozen(ADMISSION_READ_SETS), true);
        for(const entry of Object.values(ADMISSION_READ_SETS))
            assert.strictEqual(Object.isFrozen(entry), true);
    });

    it('gives every entry exactly one supported property', function () {
        for(const entry of Object.values(ADMISSION_READ_SETS)) {
            const keys = Object.keys(entry);
            assert.strictEqual(keys.length, 1);
            assert.strictEqual(ENTRY_KEYS.includes(keys[0]), true);
        }
    });

    it('freezes every fields and chains array', function () {
        for(const entry of Object.values(ADMISSION_READ_SETS)) {
            const values = entry.fields || entry.chains;
            if(values) assert.strictEqual(Object.isFrozen(values), true);
        }
    });
});
