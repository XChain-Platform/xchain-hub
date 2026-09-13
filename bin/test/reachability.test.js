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
 * The reachability sweep, driven against the real tree rather than a fixture.
 * This verdict decides what a restructure deletes, so every assertion is about a
 * file whose status is independently known: src/api.js is the container command,
 * the gate carriers are reached ONLY through a computed require, and a module
 * whose one caller is a bin/ script is held by that script and not dead.
 *
 * WHAT THE TESTS ARE REALLY GUARDING. Three of this repo's require edges are
 * built at runtime and swallow their own failures, so the tool declares them by
 * hand. A declaration that silently stopped resolving would turn a live file
 * into a deletion candidate, and nothing else in the toolchain would notice. The
 * assertions below are therefore about the EDGES, not about the totals: a total
 * moves every time a file is added.
 *
 * This suite is outside test/ on purpose: every npm test script globs from
 * test/, and the pass pins those scripts' collected titles. Run it directly:
 *
 *   npx mocha --no-config --timeout 120000 bin/test/reachability.test.js
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const reach = require('../reachability.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('bin/reachability.js', function () {
    this.timeout(120000);

    describe('entry points', () => {
        it('takes the container command out of the Dockerfile', () => {
            const report = reach.analyse({ siblings: false });
            assert.ok(report.summary.runtimeEntryPoints.includes('src/api.js'),
                'the Dockerfile CMD names src/api.js, so it must be a runtime entry point');
        });

        it('does not admit a test or ci script as a runtime entry point', () => {
            // ci:full shells out to bin/ci-full.sh and the mutation tiers run
            // stryker. Admitting any of them would fold the whole test closure
            // into the runtime closure and report every file as production code.
            const report = reach.analyse({ siblings: false });
            for (const entry of report.summary.runtimeEntryPoints) {
                assert.ok(!entry.startsWith('test/'),
                    `${entry} is a test file and must not be a runtime entry point`);
            }
        });
    });

    describe('the declared dynamic edges', () => {
        it('resolves every SHARED_GATES carrier to a file that exists', () => {
            const edge = reach.DYNAMIC_EDGES.find((e) => e.from === 'src/consensus_rules_digest.js');
            assert.ok(edge, 'the rules-digest edge must be declared');
            const targets = edge.toList();
            assert.ok(targets.length >= 15, `expected the full gate list, got ${targets.length}`);
            for (const rel of targets) {
                assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)),
                    `${rel} is resolved by a computed require that catches its own failure, so it must exist`);
            }
        });

        it('resolves all three bridge gates out of the engine itself', () => {
            const edge = reach.DYNAMIC_EDGES.find((e) => e.from === 'src/CrossChainBridgeEngine.js');
            assert.ok(edge, 'the bridge edge must be declared');
            const targets = edge.toList();
            assert.deepStrictEqual(targets.slice().sort(), [
                'src/token_bridge_activation.js',
                'src/token_policy_activation.js',
                'src/xchain_bridge_activation.js',
            ], 'the three gates the constructor loads, read from its loadActivation calls');
            for (const rel of targets) {
                assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} must exist`);
            }
        });

        it('holds every gate carrier in the runtime closure ONLY through that edge', () => {
            // The point of the whole mechanism: no literal anywhere names
            // rollcall_activation.js, so without the declared edge it reads dead
            // and a sweep would delete a consensus carrier.
            const report = reach.analyse({ siblings: false });
            const carrier = report.files['src/rollcall_activation.js'];
            assert.ok(carrier, 'the carrier must be in the verdict');
            assert.strictEqual(carrier.reachableFromHubRuntime, true,
                'the rules digest holds it, by computed require');

            const literal = fs.readFileSync(path.join(REPO_ROOT, 'src/consensus_rules_digest.js'), 'utf8');
            assert.ok(!literal.includes("require('./rollcall_activation.js')"),
                'if a literal require appears, this test has stopped proving the edge does the work');
        });
    });

    describe('the verdict', () => {
        it('keeps a module whose only caller is a bin/ script, and names the caller', () => {
            const report = reach.analyse({ siblings: false });
            const held = report.files['src/lib/capability_snapshot_prune.js'];
            assert.ok(held, 'the module must be in the verdict');
            assert.strictEqual(held.reachableFromHubRuntime, false,
                'no runtime path reaches it, which is what makes it a candidate');
            assert.strictEqual(held.reachableFromTooling, true, 'a bin/ script requires it');
            assert.ok(held.requiredByInRepo.includes('bin/prune-stale-capability-snapshots.js'),
                'the referrer has to be named, or "keep it" is an assertion rather than a finding');
            assert.strictEqual(held.unreferencedAcrossPlatform, false,
                'a held file must never be reported deletable');
        });

        it('resolves an extensionless relative require', () => {
            assert.strictEqual(
                reach.resolveRequire('src/api.js', './hub-schema-version'),
                'src/hub-schema-version.js',
            );
            assert.strictEqual(reach.resolveRequire('src/api.js', 'crypto'), null,
                'a bare package specifier is not a repo-local edge');
        });
    });

    describe('--root', () => {
        it('measures the checkout it is given, not the one it lives in', () => {
            const before = reach.repoRoot();
            try {
                const other = fs.realpathSync(REPO_ROOT);
                assert.strictEqual(reach.setRepoRoot(other), other);
                assert.strictEqual(reach.repoRoot(), other);
            } finally {
                reach.setRepoRoot(before);
            }
            assert.strictEqual(reach.repoRoot(), before, 'the root must be restorable');
        });
    });
});
