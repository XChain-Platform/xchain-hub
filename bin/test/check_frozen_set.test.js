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
 * The frozen-set check, driven by actually moving a file.
 *
 * A check that refuses a move is worth exactly what its refusal is worth, so
 * every test here builds a tree, breaks it in one specific way, and asserts the
 * check names the file. The three halves are exercised separately, because each
 * one catches a break the other two cannot: a carrier moved into a subdirectory,
 * an activation module written below the top level, and a frozen file renamed
 * away from every glob.
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

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * A minimal tree with the shape the check cares about: a rules-digest module
 * declaring two carriers, the carriers themselves, a bridge engine loading a
 * third, and a manifest recording all of it.
 */
function buildTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'bin', 'pins'), { recursive: true });

    fs.writeFileSync(path.join(root, 'src', 'consensus_rules_digest.js'), [
        "'use strict';",
        'const SHARED_GATES = [',
        "    ['rollcall_activation', ['ROLLCALL_ACTIVATION']],",
        "    ['equivocation_header', ['EQUIV_HEADER_ACTIVATION']],",
        '];',
        'module.exports = { SHARED_GATES };',
        '',
    ].join('\n'));
    fs.mkdirSync(path.join(root, 'src', 'cross_chain'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'cross_chain', 'bridge_engine.js'), [
        "'use strict';",
        "const bridge = loadActivation('xchain_bridge_activation', 'isXchainBridgeActive');",
        '',
    ].join('\n'));
    for (const name of ['rollcall_activation.js', 'equivocation_header.js', 'xchain_bridge_activation.js']) {
        fs.writeFileSync(path.join(root, 'src', name), "module.exports = {};\n");
    }
    return root;
}

function run(root) {
    const before = frozen.repoRoot();
    try {
        frozen.setRepoRoot(root);
        return frozen.check();
    } finally {
        frozen.setRepoRoot(before);
    }
}

function writeManifest(root) {
    const before = frozen.repoRoot();
    try {
        frozen.setRepoRoot(root);
        const measured = frozen.measure();
        fs.writeFileSync(path.join(root, frozen.MANIFEST_REL),
            `${JSON.stringify({ fileCount: measured.files.length, files: measured.files }, null, 2)}\n`);
        return measured.files;
    } finally {
        frozen.setRepoRoot(before);
    }
}

describe('bin/check-frozen-set.js', function () {
    this.timeout(60000);

    describe('against a tree where nothing has moved', () => {
        it('reads clean on this checkout', () => {
            const report = frozen.check();
            assert.deepStrictEqual(report.violations, [],
                'a red here means a carrier has already left the top level of src/');
        });

        it('reads the gate list out of the module rather than from a restated copy', () => {
            const declared = frozen.sharedGateModules();
            const live = require('../../src/consensus_rules_digest.js').SHARED_GATES
                .map(([mod]) => mod);
            assert.deepStrictEqual(declared.slice().sort(), Array.from(new Set(live)).sort(),
                'a restated list is a second registry, and the day it drifts the check blesses the move');
        });

        it('reads all three bridge gates out of the engine', () => {
            assert.deepStrictEqual(frozen.bridgeGateModules().slice().sort(), [
                'token_bridge_activation', 'token_policy_activation', 'xchain_bridge_activation',
            ]);
        });
    });

    describe('a carrier moved into a subdirectory', () => {
        let root;
        before(() => { root = buildTree(); writeManifest(root); });
        after(() => { fs.rmSync(root, { recursive: true, force: true }); });

        it('is clean before the move', () => {
            assert.deepStrictEqual(run(root).violations, []);
        });

        it('names the file, where it went, and why it cannot be reached', () => {
            fs.mkdirSync(path.join(root, 'src', 'rollcall'), { recursive: true });
            fs.renameSync(path.join(root, 'src', 'rollcall_activation.js'),
                path.join(root, 'src', 'rollcall', 'rollcall_activation.js'));

            const kinds = run(root).violations;
            const carrier = kinds.find((v) => v.kind === 'carrier_not_resolvable');
            assert.ok(carrier, 'the derived half must fire');
            assert.strictEqual(carrier.file, 'src/rollcall_activation.js');
            assert.deepStrictEqual(carrier.foundAt, ['src/rollcall/rollcall_activation.js'],
                'saying where it went is the difference between a finding and a puzzle');

            assert.ok(kinds.some((v) => v.kind === 'activation_below_top_level'
                && v.file === 'src/rollcall/rollcall_activation.js'), 'the shape half must fire too');
            assert.ok(kinds.some((v) => v.kind === 'frozen_file_gone'
                && v.file === 'src/rollcall_activation.js'), 'and so must the manifest half');
        });

        it('is clean again once the file is put back', () => {
            fs.renameSync(path.join(root, 'src', 'rollcall', 'rollcall_activation.js'),
                path.join(root, 'src', 'rollcall_activation.js'));
            fs.rmdirSync(path.join(root, 'src', 'rollcall'));
            assert.deepStrictEqual(run(root).violations, [],
                'a check that stays red after the repair is a check nobody can act on');
        });
    });

    describe('a carrier the gate list does not name yet', () => {
        let root;
        before(() => { root = buildTree(); writeManifest(root); });
        after(() => { fs.rmSync(root, { recursive: true, force: true }); });

        it('is caught by shape alone, because a file is frozen when it is written', () => {
            fs.mkdirSync(path.join(root, 'src', 'gates'), { recursive: true });
            fs.writeFileSync(path.join(root, 'src', 'gates', 'brand_new_activation.js'),
                'module.exports = {};\n');

            const violations = run(root).violations;
            assert.ok(violations.some((v) => v.kind === 'activation_below_top_level'
                && v.file === 'src/gates/brand_new_activation.js'),
            'no SHARED_GATES row names it and no manifest entry covers it, so shape is the only half left');
        });
    });

    describe('a frozen file renamed away from every glob', () => {
        let root;
        before(() => { root = buildTree(); writeManifest(root); });
        after(() => { fs.rmSync(root, { recursive: true, force: true }); });

        it('is caught by the manifest, which is the only half that can see a rename', () => {
            fs.renameSync(path.join(root, 'src', 'equivocation_header.js'),
                path.join(root, 'src', 'equivocationHeader.js'));

            const violations = run(root).violations;
            assert.ok(violations.some((v) => v.kind === 'frozen_file_gone'
                && v.file === 'src/equivocation_header.js'),
            'a glob over the tree always agrees with the tree, so only a recorded list sees this');
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
