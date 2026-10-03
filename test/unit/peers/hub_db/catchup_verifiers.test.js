'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');

const MODULE_PATH = require.resolve('../../../../src/peers/hub_db/catchup_verifiers.js');
const EXPECTED_TABLES = [
    'price_snapshots',
    'oracle_prices',
    'cross_chain_matches',
    'capability_snapshots',
    'cross_chain_calls',
    'state_checkpoints',
    'anchor_reward_attestations',
    'attestation_responses',
    'bridge_transfers',
    'policy_snapshots',
    'list_snapshots'
];

describe('catch-up verifier registry', function () {
    let registry;

    beforeEach(function () {
        delete require.cache[MODULE_PATH];
        registry = require(MODULE_PATH);
    });

    afterEach(function () {
        delete require.cache[MODULE_PATH];
    });

    it('exports the immutable set of eleven mirrored table names', function () {
        expect(registry.MIRRORED_TABLES).to.deep.equal(EXPECTED_TABLES);
        expect(Object.isFrozen(registry.MIRRORED_TABLES)).to.equal(true);
    });

    it('registers and returns a verifier for every mirrored table', function () {
        for (const table of EXPECTED_TABLES) {
            if (!registry.getCatchupVerifier(table)) {
                const verifier = () => table;
                registry.registerCatchupVerifier(table, verifier);
                expect(registry.getCatchupVerifier(table)).to.equal(verifier);
            } else {
                expect(registry.getCatchupVerifier(table)).to.be.a('function');
            }
        }
    });

    it('refuses an unknown table name', function () {
        expect(() => registry.registerCatchupVerifier('unknown_table', () => true))
            .to.throw('Unknown mirrored table: unknown_table');
        expect(registry.getCatchupVerifier('unknown_table')).to.equal(undefined);
    });

    it('refuses a second registration and preserves the first verifier', function () {
        const first = () => true;
        registry.registerCatchupVerifier('oracle_prices', first);

        expect(() => registry.registerCatchupVerifier('oracle_prices', () => false))
            .to.throw('Catch-up verifier already registered for table: oracle_prices');
        expect(registry.getCatchupVerifier('oracle_prices')).to.equal(first);
    });

    it('refuses a non-function verifier without reserving the table', function () {
        expect(() => registry.registerCatchupVerifier('attestation_responses', null))
            .to.throw(TypeError, 'Catch-up verifier must be a function');

        const verifier = () => true;
        registry.registerCatchupVerifier('attestation_responses', verifier);
        expect(registry.getCatchupVerifier('attestation_responses')).to.equal(verifier);
    });
});
