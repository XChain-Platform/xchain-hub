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
 * The five identity values, and the one failure they exist to catch.
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
const schema   = require('../../src/hub_schema_version.js');

// The identity values under test, read once per block. A block recomputes them
// rather than sharing one hook across blocks: the reading is pure, so a second
// read is the same read.
let value;

describe('bin/consensus-identity.js', function () {
    this.timeout(60000);

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

});

// The blocks below carry the same suite title on purpose: the readability limit is
// per callback, so one long body becomes several same-titled blocks and every full
// test title stays exactly what it was.
describe('bin/consensus-identity.js', function () {
    this.timeout(60000);

    before(() => { value = identity.codeIdentity(); });

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
});

describe('bin/consensus-identity.js', function () {
    this.timeout(60000);

    before(() => { value = identity.codeIdentity(); });

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
});

// A function canonicalizes to undefined, which JSON drops and a comparer reads as equal.
describe('bin/consensus-identity.js', function () {
    this.timeout(60000);

    before(() => { value = identity.codeIdentity(); });

    describe('function-valued gate rows', () => {
        const FUNCTION_KEYS = ['encodeAdmitBlocks', 'decodeAdmitBlocks', 'isAdmissionEra', 'admissionCanonicalField']
            .map((name) => `mirror_admission_activation.${name}`);

        it('serializes one row per gate key, naming a function gate by presence', () => {
            const printed = JSON.parse(JSON.stringify(value));
            assert.strictEqual(Object.keys(printed.consensus_rules_gates).length, printed.gate_key_count,
                'the printed map must hold every gate the count names');
            for (const key of FUNCTION_KEYS) assert.strictEqual(printed.consensus_rules_gates[key], '<function>', key);
        });

        it('reports a pin that lacks a function gate row as a difference', () => {
            const pin = JSON.parse(JSON.stringify(value));
            delete pin.consensus_rules_gates[FUNCTION_KEYS[0]];
            const differences = identity.compare(pin, value);
            assert.ok(differences.some((d) => d.kind === 'gate_added' && d.field === FUNCTION_KEYS[0]),
                'a row the pin lacks must not read as unchanged');
        });
    });
});

describe('bin/consensus-identity.js', function () {
    this.timeout(60000);

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

// The exit code is the contract the seam's identity re-read relies on: a digest that
// cannot be computed must read as a failure to a shell, never as a passing run with
// an error line above it. Driven through the real CLI on a scratch tree whose
// admission carrier is gone, which is exactly the W5 sequencing hole (the digest
// twin lands before the gate file) an operator would hit.
describe('bin/consensus-identity.js', function () {
    this.timeout(60000);

    describe('the exit code', () => {
        const fs = require('fs');
        const os = require('os');
        const { spawnSync } = require('child_process');
        const REPO_ROOT = path.resolve(__dirname, '../..');

        function scratchHub() {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consensus-identity-'));
            for (const rel of ['src', 'bin']) fs.cpSync(path.join(REPO_ROOT, rel), path.join(dir, rel), { recursive: true });
            fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(dir, 'package.json'));
            fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(dir, 'node_modules'));
            return dir;
        }

        function run(root, args) {
            return spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin/consensus-identity.js'), '--root', root, ...args],
                { encoding: 'utf8' });
        }

        it('exits non-zero, naming the key, when the digest cannot be computed', () => {
            const root = scratchHub();
            fs.unlinkSync(path.join(root, 'src/consensus/gates/mirror_admission_gate.js'));
            for (const args of [['--json'], ['--compare', path.join(REPO_ROOT, 'bin/pins/at1-consensus-identity.json')], ['--json', '--assert-no-absent']]) {
                const r = run(root, args);
                assert.notStrictEqual(r.status, 0, `${args.join(' ')} read as a passing run with the digest uncomputable`);
                assert.strictEqual(r.status, 2, `${args.join(' ')}: a thrown digest is the exit-2 contract, got ${r.status}`);
                assert.ok(/mirror_admission_activation\.encodeAdmitBlocks/.test(r.stderr),
                    `${args.join(' ')} must name the gate on stderr; got: ${r.stderr}`);
                assert.strictEqual(r.stdout, '', `${args.join(' ')} printed an identity it could not compute`);
            }
        });

        it('exits 0 on the same scratch tree with the carrier in place', () => {
            const r = run(scratchHub(), ['--json']);
            assert.strictEqual(r.status, 0, r.stderr);
            assert.strictEqual(JSON.parse(r.stdout).absent_gates.length, 0);
        });
    });
});
