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
 * the admission gate carrier is reached by the rules digest ONLY through a
 * computed require, and a module whose one caller is a bin/ script is held by
 * that script and not dead.
 *
 * WHAT THE TESTS ARE REALLY GUARDING. Two of this repo's require edges are
 * built at runtime and swallow their own failures, so the tool declares them by
 * hand (the bridge engine's was a third until W5 retired its computed require). A declaration that silently stopped resolving would turn a live file
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
const os     = require('os');
const path   = require('path');

const reach = require('../reachability.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The declared edge for one source file, or a failed assertion naming it. */
function edgeFrom(rel) {
    const edge = reach.DYNAMIC_EDGES.find((e) => e.from === rel);
    assert.ok(edge, `the ${rel} edge must be declared`);
    return edge;
}

/**
 * A throwaway checkout holding exactly `files`, so an edge can be measured against
 * a db home of a shape this repo does not currently have. Written to a temp dir
 * rather than under the repo: a fixture inside src/ would itself be swept.
 *
 * @param {object} files repo-relative path to file body
 * @returns {string} the fixture root
 */
function makeFixtureRoot(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-reach-'));
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    }
    return root;
}

/** Measure `fn` against a fixture checkout, restoring the real root either way. */
function withFixture(files, fn) {
    const before = reach.repoRoot();
    const root = makeFixtureRoot(files);
    try {
        reach.setRepoRoot(root);
        return fn(root);
    } finally {
        reach.setRepoRoot(before);
        fs.rmSync(root, { recursive: true, force: true });
    }
}

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
});

// The blocks below carry the same suite title on purpose: the readability limit is
// per callback, so one long body becomes several same-titled blocks and every full
// test title stays exactly what it was.
describe('bin/reachability.js', function () {
    this.timeout(120000);

    describe('the declared dynamic edges', () => {
        it('resolves every SHARED_GATES stem to its gate module under src/consensus/gates/', () => {
            // loadGateValue computes src/consensus/gates/<stem>_gate.js for a
            // SHARED_GATES name with no registry row (W5). A stem whose predicate-only
            // shim retired has no file there and drops out of the graph; every gate
            // module that IS there must be on the list, or the digest stops holding it.
            const edge = reach.DYNAMIC_EDGES.find((e) => e.from === 'src/consensus_rules_digest.js');
            assert.ok(edge, 'the rules-digest edge must be declared');
            const targets = edge.toList();
            // The carriers named without an _activation stem map under gates/ too (the
            // loader would look there on a miss); they are rows, so nothing is ever opened.
            for (const rel of targets) {
                assert.ok(rel.startsWith('src/consensus/gates/'), `${rel} is not where the W5 loader looks`);
            }
            const { SHARED_GATES } = require(path.join(REPO_ROOT, 'src/consensus_rules_digest.js'));
            const stems = new Set(SHARED_GATES.map(([mod]) => mod.replace(/_activation$/, '')));
            const present = fs.readdirSync(path.join(REPO_ROOT, 'src/consensus/gates'))
                .filter((f) => f.endsWith('_gate.js') && stems.has(f.replace(/_gate\.js$/, '')))
                .map((f) => `src/consensus/gates/${f}`);
            assert.ok(present.length >= 6, `expected the W5 gate twins SHARED_GATES names on disk, got ${present.length}`);
            for (const rel of present) assert.ok(targets.includes(rel), `${rel} is on disk but not on the digest edge`);
            assert.ok(targets.includes('src/consensus/gates/mirror_admission_gate.js'),
                'the one carrier the digest opens today for its function-valued names');
        });

        it('declares no edge for the bridge engine, which reads its gates from the registry since W5', () => {
            const edge = reach.DYNAMIC_EDGES.find((e) => e.from === 'src/cross_chain/bridge_engine.js');
            assert.strictEqual(edge, undefined, 'the bridge engine builds no require at run time any more');
            const engine = fs.readFileSync(path.join(REPO_ROOT, 'src/cross_chain/bridge_engine.js'), 'utf8');
            assert.ok(!/require\s*\(\s*path\s*\./.test(engine) && !/require\s*\(\s*['"][^'"]*['"]\s*\+/.test(engine),
                'a computed require is back in the engine: declare its edge or the static walk misses it');
        });

    });
});

describe('bin/reachability.js', function () {
    this.timeout(120000);

    describe('the declared dynamic edges', () => {
        it('reads the db home mixins out of the index requires, and nothing else', () => {
            // The shape this repo has today. A file sitting in the home that the
            // index does not load is NOT an edge: it is a candidate, and an edge
            // that swept the directory wholesale would hide it.
            const targets = withFixture({
                'src/db/index.js': [
                    "const mariadb = require('mariadb');",
                    "const ark = require('../anchor/anchor_reward_key.js');",
                    "const MIXINS = [require('./anchor.js'), require('./configs.js')];",
                    'module.exports = MIXINS;',
                ].join('\n'),
                'src/db/anchor.js': 'module.exports = {};\n',
                'src/db/configs.js': 'module.exports = {};\n',
                'src/db/orphan.js': 'module.exports = {};\n',
                'src/anchor/anchor_reward_key.js': 'module.exports = {};\n',
            }, () => edgeFrom('src/db/index.js').toList());

            assert.deepStrictEqual(targets, ['src/db/anchor.js', 'src/db/configs.js'],
                'the two mixins the index requires, without the orphan beside them '
                + 'and without the module it requires from outside the home');
        });

        it('sweeps the whole db home when the index builds its list at runtime', () => {
            // The shape the edge exists for: not one literal names a mixin, so
            // without the sweep every file in the home reads dead at once.
            const targets = withFixture({
                'src/db/index.js': [
                    "const fs = require('fs');",
                    "const path = require('path');",
                    'const MIXINS = fs.readdirSync(__dirname)',
                    "    .filter((f) => f !== 'index.js' && f.endsWith('.js'))",
                    '    .map((f) => require(path.join(__dirname, f)));',
                    'module.exports = MIXINS;',
                ].join('\n'),
                'src/db/anchor.js': 'module.exports = {};\n',
                'src/db/configs.js': 'module.exports = {};\n',
                'src/db/notes.md': 'not a module\n',
            }, () => edgeFrom('src/db/index.js').toList());

            assert.deepStrictEqual(targets, ['src/db/anchor.js', 'src/db/configs.js'],
                'every .js beside the index, and only the .js files');
        });

    });
});

describe('bin/reachability.js', function () {
    this.timeout(120000);

    describe('the declared dynamic edges', () => {
        it('reports no mixin edge, rather than throwing, when the home has none', () => {
            // A home whose index loads no mixin, and a checkout with no db home at
            // all. Neither may throw an exception that stops the sweep outright,
            // which is how a restructure loses its only deletion verdict.
            const noMixins = withFixture({
                'src/db/index.js': [
                    "const mariadb = require('mariadb');",
                    "const ark = require('../anchor/anchor_reward_key.js');",
                    'module.exports = class Database {};',
                ].join('\n'),
                'src/anchor/anchor_reward_key.js': 'module.exports = {};\n',
            }, () => edgeFrom('src/db/index.js').toList());
            assert.deepStrictEqual(noMixins, [], 'a db home with no mixins is zero edges');

            const noHome = withFixture(
                { 'src/api.js': 'module.exports = {};\n' },
                () => edgeFrom('src/db/index.js').toList(),
            );
            assert.deepStrictEqual(noHome, [], 'a checkout with no db home is zero edges');
        });

        it('holds the admission gate carrier from the digest through that edge alone', () => {
            // The point of the whole mechanism: no literal in the digest names
            // mirror_admission_gate.js (loadGateValue builds the path from the
            // SHARED_GATES row), so withdrawing the declared edge drops the digest
            // from the carrier's holders and a sweep could read a consensus carrier dead.
            const report = reach.analyse({ siblings: false });
            const carrier = report.files['src/consensus/gates/mirror_admission_gate.js'];
            assert.ok(carrier, 'the carrier must be in the verdict');
            assert.strictEqual(carrier.reachableFromHubRuntime, true,
                'the rules digest holds it, by computed require');
            assert.ok(carrier.requiredByInRepo.includes('src/consensus_rules_digest.js'),
                'the digest is one of its holders through the edge; holders: ' + carrier.requiredByInRepo.join(', '));

            const literal = fs.readFileSync(path.join(REPO_ROOT, 'src/consensus_rules_digest.js'), 'utf8');
            assert.ok(!/require\(['"][^'"]*mirror_admission_gate\.js['"]\)/.test(literal),
                'if a literal require appears, this test has stopped proving the edge does the work');
        });
    });
});

describe('bin/reachability.js', function () {
    this.timeout(120000);

    describe('the verdict', () => {
        it('keeps a module whose only caller is a bin/ script, and names the caller', () => {
            const report = reach.analyse({ siblings: false });
            const held = report.files['src/validators/capability_snapshot_prune.js'];
            assert.ok(held, 'the module must be in the verdict');
            assert.strictEqual(held.reachableFromHubRuntime, false,
                'no runtime path reaches it, which is what makes it a candidate');
            assert.strictEqual(held.reachableFromTooling, true, 'a bin/ script requires it');
            assert.ok(held.requiredByInRepo.includes('bin/prune-stale-capability-snapshots.js'),
                'the referrer has to be named, or "keep it" is an assertion rather than a finding');
            assert.strictEqual(held.unreferencedAcrossPlatform, false,
                'a held file must never be reported deletable');
        });

        it('reaches every db mixin in this tree through the db home index', () => {
            // The whole db home is production code: the API requires the index and the
            // index installs each mixin on Database.prototype. One of them reading
            // unreachable means the edge stopped resolving, and the file is one sweep
            // away from being deleted out from under every query that uses it.
            const report = reach.analyse({ siblings: false });
            const home = Object.keys(report.files).filter((f) => f.startsWith('src/db/')).sort();
            assert.ok(home.length > 1, 'the db home must be in the verdict');
            const dead = home.filter((f) => !report.files[f].reachableFromHubRuntime);
            assert.deepStrictEqual(dead, [], 'every file in the db home must be runtime-reachable');
        });

        it('resolves an extensionless relative require', () => {
            assert.strictEqual(
                reach.resolveRequire('src/api.js', './hub_schema_version'),
                'src/hub_schema_version.js',
            );
            assert.strictEqual(reach.resolveRequire('src/api.js', 'crypto'), null,
                'a bare package specifier is not a repo-local edge');
        });
    });
});

describe('bin/reachability.js', function () {
    this.timeout(120000);

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
