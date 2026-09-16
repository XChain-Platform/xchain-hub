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
 * The frozen-set check, driven by actually moving a file and deleting a row.
 *
 * A check that refuses a move is worth exactly what its refusal is worth, so
 * every test here builds a tree, breaks it in one specific way, and asserts the
 * check names the file or the key. The halves are exercised separately, because
 * each one catches a break the others cannot: a registry row deleted from under
 * a gate the digest or the bridge engine names, a function-valued carrier moved
 * away from where the loader computes it, an activation module written below the
 * top level or a twin gate written outside src/consensus/gates/, and a frozen
 * file renamed away from every glob. The fourth half, pinned, is driven the same
 * way: a carrier whose logic changed in place, which none of the path halves
 * can see.
 *
 * The scratch tree carries a stub registry (the same keys(), has() and get()
 * surface the real entry exports, over a JSON row file a test can edit) and a
 * digest module whose loadGateValue is the real loader's fallback shape, so the
 * check reads both exactly as it reads the checkout's.
 *
 *   npx mocha --no-config --timeout 60000 bin/test/check_frozen_set.test.js
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const frozen = require('../check-frozen-set.js');
const logicPin = require('../lib/carrier_logic_pin.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The scratch registry's rows, '<module>.<EXPORT>': one per gate the scratch
// digest and bridge engine name, plus the zero-conf row that makes
// attest_zero_conf_gate.js read as a twin gate by stem (the D106 exception).
const ROWS = {
    'rollcall_activation.ROLLCALL_ACTIVATION': { regtest: 1 },
    'equivocation_header.EQUIV_HEADER_ACTIVATION': { regtest: 1 },
    'mirror_admission_activation.MIRROR_ADMISSION_ACTIVATION': { regtest: 1 },
    'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION': { regtest: 1 },
    'token_bridge_activation.TOKEN_BRIDGE_ACTIVATION': { regtest: 1 },
    'attest_zero_conf_activation.ATTEST_ZERO_CONF_ACTIVATION': { regtest: 1 },
};
const ROWS_REL = 'src/consensus/gate_registry/rows.json';

// The scratch tree's pinned carriers: id to path, the W5 layout.
const PINNED = {
    rollcall_gate: 'src/consensus/gates/rollcall_gate.js',
    equivocation_header: 'src/consensus/equivocation_header.js',
    mirror_admission_gate: 'src/consensus/gates/mirror_admission_gate.js',
};

function write(root, rel, lines) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), Array.isArray(lines) ? `${lines.join('\n')}\n` : lines);
}

/**
 * A minimal tree with the shape the check cares about, in the W5 layout: a
 * rules-digest module declaring three gates (one with a function-valued name)
 * and carrying the real loader's fallback shape, a registry stub over ROWS, the
 * twin gates under src/consensus/gates/, a carrier under src/consensus/, a
 * hub-only activation at the top level, a bridge engine spelling two keys (one
 * per shape the engine has had), and a carrier-logic pin over the three.
 */
function buildTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-'));
    fs.mkdirSync(path.join(root, 'bin', 'pins'), { recursive: true });
    write(root, 'src/consensus_rules_digest.js', [
        "'use strict';",
        "const fs = require('fs');",
        "const path = require('path');",
        'const SHARED_GATES = [',
        "    ['rollcall_activation', ['ROLLCALL_ACTIVATION']],",
        "    ['equivocation_header', ['EQUIV_HEADER_ACTIVATION']],",
        "    // ['commented_out_activation', ['NOT_DECLARED']],",
        "    ['mirror_admission_activation', ['MIRROR_ADMISSION_ACTIVATION',",
        "                                     'encodeAdmitBlocks']],",
        '];',
        "const registry = require('./consensus/gate_registry');",
        'function loadGateValue(mod, name){',
        "    const key = mod + '.' + name;",
        '    try {',
        '        return registry.get(key);',
        '    } catch (miss) {',
        "        if (!miss || miss.name !== 'RegistryMissError') throw miss;",
        "        const rel = path.join('consensus', 'gates', mod.replace(/_activation$/, '_gate') + '.js');",
        '        const file = path.join(__dirname, rel);',
        "        if (!fs.existsSync(file)) throw new Error('no carrier at src/' + rel);",
        '        return require(file)[name];',
        '    }',
        '}',
        'module.exports = { SHARED_GATES, loadGateValue };',
    ]);
    write(root, 'src/consensus/gate_registry.js', [
        "'use strict';",
        "const rows = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'gate_registry', 'rows.json'), 'utf8'));",
        "class RegistryMissError extends Error { constructor(k) { super('no row ' + k); this.name = 'RegistryMissError'; } }",
        'module.exports = {',
        '    keys: () => Object.keys(rows),',
        '    has: (k) => Object.prototype.hasOwnProperty.call(rows, k),',
        '    get: (k) => { if (!Object.prototype.hasOwnProperty.call(rows, k)) throw new RegistryMissError(k); return rows[k]; },',
        '    RegistryMissError,',
        '};',
    ]);
    write(root, ROWS_REL, `${JSON.stringify(ROWS, null, 2)}\n`);
    write(root, 'src/cross_chain/bridge_engine.js', [
        "'use strict';",
        "const registry = require('../consensus/gate_registry');",
        "const token  = loadActivation('token_bridge_activation', 'TOKEN_BRIDGE_ACTIVATION', 'isTokenBridgeActive');",
        "const bridge = registry.get('xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION');",
    ]);
    write(root, PINNED.rollcall_gate, ['module.exports = {};']);
    write(root, PINNED.equivocation_header, ['module.exports = {};']);
    write(root, PINNED.mirror_admission_gate, ['module.exports = { encodeAdmitBlocks: function () { return 1; } };']);
    write(root, 'src/xchain_price_activation.js', ['module.exports = {};']);
    writeLogicPin(root);
    return root;
}

/** Pin the tree's three carriers by token hash, the way --init would. */
function writeLogicPin(root) {
    const entries = {};
    for (const [id, rel] of Object.entries(PINNED)) {
        entries[id] = { path: rel, hash: logicPin.tokenHash(fs.readFileSync(path.join(root, rel), 'utf8')), twins: [] };
    }
    logicPin.writePin(root, { version: 1, entries, repins: [] });
}

/** Rewrite the scratch registry's rows with `keys` removed. */
function dropRows(root, keys) {
    const rows = { ...ROWS };
    for (const k of keys) delete rows[k];
    write(root, ROWS_REL, `${JSON.stringify(rows, null, 2)}\n`);
}

/** Call `fn` with the check aimed at `root`, and aim it back whatever happens. */
function withRoot(root, fn) {
    const before = frozen.repoRoot();
    try {
        frozen.setRepoRoot(root);
        return fn();
    } finally {
        frozen.setRepoRoot(before);
    }
}

function run(root) { return withRoot(root, () => frozen.check()); }

function writeManifest(root) {
    return withRoot(root, () => {
        const measured = frozen.measure();
        fs.writeFileSync(path.join(root, frozen.MANIFEST_REL),
            `${JSON.stringify({ fileCount: measured.files.length, files: measured.files }, null, 2)}\n`);
        return measured.files;
    });
}

describe('bin/check-frozen-set.js', function () {
    this.timeout(60000);

    describe('against a tree where nothing has moved', () => {
        it('reads clean on this checkout', () => {
            const report = frozen.check();
            assert.deepStrictEqual(report.violations, [],
                'a red here means a carrier has already left the top level of src/');
        });

        it('reads the gate keys out of the module rather than from a restated copy', () => {
            const live = require('../../src/consensus_rules_digest.js').SHARED_GATES;
            const liveKeys = Array.from(new Set(live.flatMap(([mod, names]) => names.map((n) => `${mod}.${n}`))));
            assert.deepStrictEqual(frozen.sharedGateKeys(), liveKeys,
                'a restated list is a second registry, and the day it drifts the check blesses the move');
            assert.deepStrictEqual(frozen.sharedGateModules(), Array.from(new Set(live.map(([mod]) => mod))));
        });

        it('reads all three bridge keys out of the engine', () => {
            assert.deepStrictEqual(frozen.bridgeGateKeys().slice().sort(), [
                'token_bridge_activation.TOKEN_BRIDGE_ACTIVATION',
                'token_policy_activation.TOKEN_POLICY_INHERITANCE_ACTIVATION',
                'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION',
            ]);
        });

        it('reads the registry keys from the checkout in a process of their own', () => {
            const got = frozen.registryKeys();
            assert.strictEqual(got.error, undefined, got.error);
            assert.deepStrictEqual(got.value.slice().sort(),
                require('../../src/consensus/gate_registry.js').keys().slice().sort(),
                'the probe must read the same registry this process requires');
        });
    });
});

describe('bin/check-frozen-set.js', function () {
    this.timeout(60000);

    describe('the loader path, read out of the loader itself', () => {
        let root;
        before(() => { root = buildTree(); });
        after(() => { fs.rmSync(root, { recursive: true, force: true }); });

        function withLoader(line) {
            const rel = 'src/consensus_rules_digest.js';
            write(root, rel, [
                'function loadGateValue(mod, name){',
                '    try { return registry.get(mod); } catch (miss) {',
                `        ${line}`,
                '        if (!fs.existsSync(file)) throw new Error(file);',
                '        return require(file)[name];',
                '    }',
                '}',
            ]);
            return withRoot(root, () => frozen.carrierFallbackPath('mirror_admission_activation'));
        }

        it('follows the pre-W5 shape to the top of src/', () => {
            assert.strictEqual(withLoader("const file = path.join(__dirname, mod + '.js');"),
                'src/mirror_admission_activation.js');
        });

        it('follows the W5 shape to src/consensus/gates/<stem>_gate.js', () => {
            assert.strictEqual(withLoader(
                "const file = path.join(__dirname, 'consensus', 'gates', mod.replace(/_activation$/, '_gate') + '.js');"),
            'src/consensus/gates/mirror_admission_gate.js');
        });

        it('answers null when the loader asks for no file', () => {
            assert.strictEqual(withLoader('throw miss;'), null,
                'a loader with no carrier fallback gives a rowless name nowhere to resolve');
        });
    });
});

// The blocks below carry the same suite title on purpose: the readability limit is
// per callback, so one long body becomes several same-titled blocks and every full
// test title stays exactly what it was.
describe('bin/check-frozen-set.js', function () {
    this.timeout(60000);

    describe('a registry row deleted from under a gate the digest names', () => {
        let root;
        before(() => { root = buildTree(); writeManifest(root); });
        after(() => { fs.rmSync(root, { recursive: true, force: true }); });

        it('is clean before the deletion', () => {
            assert.deepStrictEqual(run(root).violations, []);
        });

        it('names the key when the carrier is where the loader looks but holds no such function', () => {
            dropRows(root, ['rollcall_activation.ROLLCALL_ACTIVATION']);
            const v = run(root).violations;
            assert.deepStrictEqual(v.map((x) => x.kind), ['carrier_export_missing'],
                'nothing moved, so the path halves and the pin stay silent');
            assert.strictEqual(v[0].key, 'rollcall_activation.ROLLCALL_ACTIVATION');
            assert.strictEqual(v[0].file, 'src/consensus/gates/rollcall_gate.js',
                'the file the loader computes for the rowless name, so the repair is named');
        });

        it('names the key and where the carrier went when the loader computes a path that is not there', () => {
            dropRows(root, ['equivocation_header.EQUIV_HEADER_ACTIVATION']);
            const v = run(root).violations;
            assert.deepStrictEqual(v.map((x) => x.kind), ['carrier_not_resolvable']);
            assert.strictEqual(v[0].key, 'equivocation_header.EQUIV_HEADER_ACTIVATION');
            assert.strictEqual(v[0].file, 'src/consensus/gates/equivocation_header.js');
            assert.deepStrictEqual(v[0].foundAt, ['src/consensus/equivocation_header.js'],
                'saying where it went is the difference between a finding and a puzzle');
        });

        it('is clean again once the row is back', () => {
            dropRows(root, []);
            assert.deepStrictEqual(run(root).violations, [],
                'a check that stays red after the repair is a check nobody can act on');
        });
    });

    describe('a registry row deleted from under a key the bridge engine spells', () => {
        let root;
        before(() => { root = buildTree(); writeManifest(root); });
        after(() => { fs.rmSync(root, { recursive: true, force: true }); });

        it('names the key, in either spelling the engine has used', () => {
            dropRows(root, ['xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION', 'token_bridge_activation.TOKEN_BRIDGE_ACTIVATION']);
            const v = run(root).violations;
            assert.deepStrictEqual(v.map((x) => x.kind), ['bridge_row_missing', 'bridge_row_missing']);
            assert.deepStrictEqual(v.map((x) => x.key).sort(), [
                'token_bridge_activation.TOKEN_BRIDGE_ACTIVATION', 'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION',
            ], 'the loadActivation call and the literal key are read alike');
        });
    });
});

describe('bin/check-frozen-set.js', function () {
    this.timeout(60000);

    describe('a function-valued carrier moved away from where the loader looks', () => {
        let root;
        before(() => { root = buildTree(); writeManifest(root); });
        after(() => { fs.rmSync(root, { recursive: true, force: true }); });

        it('names the file, where it went, and the key that cannot be reached', () => {
            fs.renameSync(path.join(root, 'src', 'consensus', 'gates', 'mirror_admission_gate.js'),
                path.join(root, 'src', 'mirror_admission_gate.js'));

            const v = run(root).violations;
            const carrier = v.find((x) => x.kind === 'carrier_not_resolvable');
            assert.ok(carrier, 'the derived half must fire');
            assert.strictEqual(carrier.file, 'src/consensus/gates/mirror_admission_gate.js');
            assert.strictEqual(carrier.key, 'mirror_admission_activation.encodeAdmitBlocks');
            assert.deepStrictEqual(carrier.foundAt, ['src/mirror_admission_gate.js']);
            assert.ok(v.some((x) => x.kind === 'gate_outside_gates_dir' && x.file === 'src/mirror_admission_gate.js'),
                'the shape half must fire too: a twin gate lives only under src/consensus/gates/');
            assert.ok(v.some((x) => x.kind === 'frozen_file_gone' && x.file === 'src/consensus/gates/mirror_admission_gate.js'),
                'and so must the manifest half');
        });

        it('is clean again once the file is put back', () => {
            fs.renameSync(path.join(root, 'src', 'mirror_admission_gate.js'),
                path.join(root, 'src', 'consensus', 'gates', 'mirror_admission_gate.js'));
            assert.deepStrictEqual(run(root).violations, []);
        });

        it('names the key when the carrier is there but exports no such function', () => {
            write(root, 'src/consensus/gates/mirror_admission_gate.js', ['module.exports = { encodeAdmitBlocks: 1 };']);
            const v = run(root).violations;
            const missing = v.find((x) => x.kind === 'carrier_export_missing');
            assert.ok(missing, 'a value where the loader wants a function is the miss the digest rethrows');
            assert.strictEqual(missing.key, 'mirror_admission_activation.encodeAdmitBlocks');
            assert.ok(v.some((x) => x.kind === 'carrier_logic_moved'), 'and the pin sees the body change');
        });
    });
});

describe('bin/check-frozen-set.js', function () {
    this.timeout(60000);

    describe('a carrier the gate list does not name yet', () => {
        let root;
        before(() => { root = buildTree(); writeManifest(root); });
        after(() => { fs.rmSync(root, { recursive: true, force: true }); });

        it('is caught by shape alone, because a file is frozen when it is written', () => {
            write(root, 'src/gates/brand_new_activation.js', ['module.exports = {};']);
            assert.ok(run(root).violations.some((v) => v.kind === 'activation_below_top_level'
                && v.file === 'src/gates/brand_new_activation.js'),
            'no SHARED_GATES row names it and no manifest entry covers it, so shape is the only half left');
        });

        it('catches a twin gate written outside src/consensus/gates/ by its stem alone', () => {
            write(root, 'src/rollcall/token_bridge_gate.js', ['module.exports = {};']);
            assert.ok(run(root).violations.some((v) => v.kind === 'gate_outside_gates_dir'
                && v.file === 'src/rollcall/token_bridge_gate.js'),
            'the registry holds token_bridge_activation rows, so the stem names a twin');
        });

        it('leaves a _gate.js whose stem has no registry rows alone', () => {
            write(root, 'src/api/auth_gate.js', ['module.exports = {};']);
            assert.ok(!run(root).violations.some((v) => v.file === 'src/api/auth_gate.js'),
                'the hub has gates of its own that are not flag days');
        });

        it('forgives the hub-owned zero-conf gate beside its first requirer (D106)', () => {
            write(root, 'src/attestation/attest_zero_conf_gate.js', ['module.exports = {};']);
            assert.ok(!run(root).violations.some((v) => v.file === 'src/attestation/attest_zero_conf_gate.js'),
                'its stem has rows, so only the declared exception keeps it off the list');
        });
    });

    describe('a frozen file renamed away from every glob', () => {
        let root;
        before(() => { root = buildTree(); writeManifest(root); });
        after(() => { fs.rmSync(root, { recursive: true, force: true }); });

        it('is caught by the manifest, which is the only half that can see a rename', () => {
            fs.renameSync(path.join(root, 'src', 'consensus', 'equivocation_header.js'),
                path.join(root, 'src', 'consensus', 'equivocationHeader.js'));

            const violations = run(root).violations;
            assert.ok(violations.some((v) => v.kind === 'frozen_file_gone'
                && v.file === 'src/consensus/equivocation_header.js'),
            'a glob over the tree always agrees with the tree, so only a recorded list sees this');
        });
    });

    describe('a tree whose registry cannot be read', () => {
        let root;
        before(() => { root = buildTree(); writeManifest(root); fs.rmSync(path.join(root, ROWS_REL)); });
        after(() => { fs.rmSync(root, { recursive: true, force: true }); });

        it('refuses rather than treating every key as a miss or none as one', () => {
            const v = run(root).violations;
            assert.ok(v.some((x) => x.kind === 'registry_unreadable'), 'the derived half must say it could not answer');
            assert.ok(!v.some((x) => /_row_missing$|^carrier_/.test(x.kind)),
                'an unreadable registry must not be read as an empty one');
        });
    });

    describe('a tree with no manifest', () => {
        let root;
        before(() => { root = buildTree(); });
        after(() => { fs.rmSync(root, { recursive: true, force: true }); });

        it('refuses rather than passing on an absent comparand', () => {
            const violations = run(root).violations;
            assert.ok(violations.some((v) => v.kind === 'manifest_missing'),
                'a missing baseline read as clean is how a gate quietly stops gating');
        });
    });

    describe('--root', () => {
        it('checks the checkout it is given, not the one it lives in', () => {
            assert.strictEqual(frozen.repoRoot(), REPO_ROOT);
        });
    });
});

describe('bin/check-frozen-set.js', function () {
    this.timeout(60000);

    describe('a carrier whose logic changed in place', () => {
        let root;
        before(() => { root = buildTree(); writeManifest(root); });
        after(() => { fs.rmSync(root, { recursive: true, force: true }); });

        it('is caught by the pinned half alone, because no path moved', () => {
            write(root, PINNED.equivocation_header, ['module.exports = { changed: true };']);

            const violations = run(root).violations;
            assert.deepStrictEqual(violations.map((v) => v.kind), ['carrier_logic_moved'],
                'the three path halves must stay silent: nothing moved, the logic did');
            assert.strictEqual(violations[0].file, PINNED.equivocation_header);
            assert.strictEqual(violations[0].id, 'equivocation_header');
        });

        it('is not repaired by --write, which regenerates the manifest only', () => {
            const before = fs.readFileSync(path.join(root, logicPin.PIN_REL));
            assert.strictEqual(frozen.main(['--root', root, '--write']), 0);
            frozen.setRepoRoot(REPO_ROOT);
            assert.ok(before.equals(fs.readFileSync(path.join(root, logicPin.PIN_REL))),
                'only bin/lib/carrier_logic_pin.js --write --reason may move the pin');
            assert.ok(run(root).violations.some((v) => v.kind === 'carrier_logic_moved'));
        });

        it('is clean again once the pin module records the re-pin', () => {
            assert.strictEqual(logicPin.main(['--root', root, '--write', '--id', 'equivocation_header', '--reason', 'test']), 0);
            assert.deepStrictEqual(run(root).violations, []);
            assert.strictEqual(logicPin.readPin(root).repins.length, 1, 'the re-pin carries its record');
        });
    });

    describe('a tree with no carrier-logic pin', () => {
        let root;
        before(() => { root = buildTree(); writeManifest(root); fs.rmSync(path.join(root, logicPin.PIN_REL)); });
        after(() => { fs.rmSync(root, { recursive: true, force: true }); });

        it('refuses rather than passing on an absent comparand', () => {
            assert.ok(run(root).violations.some((v) => v.kind === 'carrier_logic_pin_missing'),
                'a missing pin read as clean is how the fourth half would quietly stop gating');
        });
    });
});
