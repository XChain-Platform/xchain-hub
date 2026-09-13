/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The four identity values, and the one failure they exist to catch.
 *
 * The hashes themselves are not asserted against literals: a literal here is a
 * second copy of the pin under bin/pins/, and the day the two disagree the one
 * nobody looks at wins. What is asserted is the RELATIONSHIP each value has to
 * the code it is derived from, which a restructure can break and a copied
 * constant cannot see: the gates field is the joined key list, the coin pins are
 * per pair rather than per network, and an unresolved carrier is reported by
 * name instead of being folded into a moved digest.
 *
 *   npx mocha --no-config --timeout 60000 bin/test/consensus_identity.test.js
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path   = require('path');

const identity = require('../consensus-identity.js');
const digest   = require('../../src/consensus_rules_digest.js');
const coins    = require('../../src/coins/index.js');
const schema   = require('../../src/hub-schema-version.js');

describe('bin/consensus-identity.js', function () {
    this.timeout(60000);

    let value;
    before(() => { value = identity.codeIdentity(); });

    it('reports the digest the hub itself computes', () => {
        assert.strictEqual(value.consensus_rules_digest, digest.computeConsensusRulesDigest().digest);
    });

    it('carries the whole gates map, because a digest alone cannot tell unchanged from all absent', () => {
        const gates = digest.computeConsensusRulesDigest().gates;
        assert.deepStrictEqual(Object.keys(value.consensus_rules_gates).sort(), Object.keys(gates).sort());
        assert.strictEqual(value.gate_key_count, Object.keys(gates).length);
    });

    it('finds no absent gate in a tree where nothing has moved', () => {
        assert.deepStrictEqual(value.absent_gates, [],
            'an absent gate here means a carrier has already left the top level of src/');
    });

    it('hashes the GATES field the roll call actually signs', () => {
        const field = digest.knownGateKeys().join(',');
        assert.strictEqual(value.gates_field, field);
        assert.strictEqual(
            value.gates_field_hash,
            crypto.createHash('sha256').update(field, 'utf8').digest('hex'),
        );
    });

    it('pins the coin hash per (coin, network) PAIR and not once per network', () => {
        const expected = coins.ALLOWED_COINS.length * coins.NETWORKS.length;
        assert.strictEqual(Object.keys(value.coin_consensus_pins).length, expected,
            'one number per network would average over three chains and hide a single moved one');
        for (const network of coins.NETWORKS) {
            for (const tick of coins.ALLOWED_COINS) {
                assert.strictEqual(
                    value.coin_consensus_pins[`${tick}:${network}`],
                    coins.consensusHash(tick, network),
                );
            }
        }
    });

    it('records mainnet as a deliberate skip rather than as a missing pin', () => {
        assert.ok(value.coin_pin_skipped_networks.includes('mainnet'),
            'CONSENSUS_CONFIG_PIN.mainnet is null until a coordinated release arms it');
        assert.ok(value.coin_pin_armed_networks.includes('regtest'));
        assert.ok(value.coin_pin_armed_networks.includes('testnet'));
    });

    it('reports the schema version every reader checks for strict equality', () => {
        assert.strictEqual(value.hub_schema_version, schema.HUB_SCHEMA_VERSION);
    });

    describe('compare', () => {
        it('names the gate that stopped resolving, not just the moved digest', () => {
            const after = JSON.parse(JSON.stringify(value));
            const key = Object.keys(after.consensus_rules_gates)[0];
            after.consensus_rules_gates[key] = '<absent>';
            after.consensus_rules_digest = 'a-different-digest';

            const differences = identity.compare(value, after);
            const named = differences.find((d) => d.field === key);
            assert.ok(named, 'the gate has to be named by key');
            assert.strictEqual(named.kind, 'gate_value');
            assert.strictEqual(named.after, '<absent>');
        });

        it('reports a dropped gate rather than silently comparing the keys they share', () => {
            const after = JSON.parse(JSON.stringify(value));
            const key = Object.keys(after.consensus_rules_gates)[0];
            delete after.consensus_rules_gates[key];

            const differences = identity.compare(value, after);
            assert.ok(differences.some((d) => d.kind === 'gate_dropped' && d.field === key));
        });

        it('reports no difference between a tree and itself', () => {
            assert.deepStrictEqual(identity.compare(value, JSON.parse(JSON.stringify(value))), []);
        });

        it('catches a moved coin pin', () => {
            const after = JSON.parse(JSON.stringify(value));
            after.coin_consensus_pins['BTC:regtest'] = 'f'.repeat(64);
            const differences = identity.compare(value, after);
            assert.ok(differences.some((d) => d.kind === 'coin_pin' && d.field === 'BTC:regtest'));
        });
    });

    describe('--root', () => {
        it('measures the checkout it is given, not the one it lives in', () => {
            const before = identity.repoRoot();
            const other = path.resolve(__dirname, '../..');
            try {
                identity.setRepoRoot(other);
                assert.strictEqual(identity.repoRoot(), path.resolve(other));
            } finally {
                identity.setRepoRoot(before);
            }
            assert.strictEqual(identity.repoRoot(), before, 'the root must be restorable');
        });
    });
});
