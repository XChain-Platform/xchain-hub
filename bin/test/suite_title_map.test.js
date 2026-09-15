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
 * How a script's command line is read, which is where this pin can go wrong
 * quietly. Collecting mocha is the easy half; the half that matters is that
 * every script and every segment of every chained script is answered for, so a
 * suite cannot stop being collected and leave the pin looking complete.
 *
 * The command strings are this repo's real ones, taken from package.json rather
 * than retyped, because a retyped copy stops being the thing under test the
 * first time a script is edited.
 *
 *   npx mocha --no-config --timeout 60000 bin/test/suite_title_map.test.js
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');

const titles = require('../suite-title-map.js');
const pkg    = require('../../package.json');

const SCRIPT_NAMES = Object.keys(pkg.scripts).filter((n) => n.startsWith('test') || n.startsWith('ci'));

// One script's pin, one file, two titles: the smallest shape that can show a
// declared rename, a file that stopped being collected and a title that vanished.
const PIN = {
    titleSets: { aaa: ['suite one', 'suite two'] },
    scripts: { test: { files: { 'test/unit/old_name.test.js': 'aaa' } } },
};

describe('bin/suite-title-map.js', function () {
    this.timeout(60000);

    describe('which scripts are in scope', () => {
        it('takes the ci tiers as well as the test tiers', () => {
            assert.ok(SCRIPT_NAMES.includes('ci'));
            assert.ok(SCRIPT_NAMES.includes('ci:security'));
            assert.ok(SCRIPT_NAMES.includes('ci:regression'),
                'the venue runs these, so a glob that stopped collecting here must be visible');
        });
    });
});

// The blocks below carry the same suite title on purpose: the readability limit is
// per callback, so one long body becomes several same-titled blocks and every full
// test title stays exactly what it was.
describe('bin/suite-title-map.js', function () {
    this.timeout(60000);

    describe('reading a command line', () => {
        it('keeps a quoted glob whole', () => {
            const tokens = titles.splitCommand("mocha 'test/unit/**/*.test.js' --timeout 5000");
            assert.deepStrictEqual(tokens.map((t) => t.value),
                ['mocha', 'test/unit/**/*.test.js', '--timeout', '5000']);
            assert.strictEqual(tokens[1].quoted, true);
        });

        it('answers for every segment of a chained script, inline mocha included', () => {
            // `ci` is a mocha command AND two npm members. Recording only the
            // member names would drop the unit glob spelled inline in the chain,
            // which is exactly the silent loss this pin exists to catch.
            const parsed = titles.mochaArgsFor(pkg.scripts.ci);
            const mocha = parsed.segments.filter((s) => s.args);
            const members = parsed.segments.filter((s) => s.npm).map((s) => s.npm);
            assert.strictEqual(mocha.length, 1, 'the inline mocha segment must be collected');
            assert.deepStrictEqual(members, ['ci:guards', 'ci:security', 'ci:regression']);
            assert.ok(mocha[0].args.some((a) => a.includes('test/unit/')),
                'and it must carry the glob the chain actually runs');
        });

        it('records a script that is not mocha with its reason instead of dropping it', () => {
            for (const name of ['ci:full', 'test:mutate', 'test:mutate:pilot']) {
                const parsed = titles.mochaArgsFor(pkg.scripts[name]);
                assert.strictEqual(parsed.segments.length, 1);
                assert.ok(parsed.segments[0].skip,
                    `${name} runs no mocha, and the pin has to say so in as many words`);
                assert.match(parsed.segments[0].skip, /not a mocha command \(runs \w+\)/);
            }
        });

        it('sets a leading environment assignment on the child rather than dropping it', () => {
            const parsed = titles.mochaArgsFor("FUZZ_RUNS=1000 mocha 'test/fuzz/**/*.js'");
            assert.strictEqual(parsed.segments[0].env.FUZZ_RUNS, '1000');
            assert.deepStrictEqual(parsed.segments[0].args, ['test/fuzz/**/*.js']);
        });

        it('keeps a --grep, because the filtered set is the script\'s identity', () => {
            const parsed = titles.mochaArgsFor(pkg.scripts['test:regression:p0']);
            assert.ok(parsed.segments[0].args.includes('--grep'));
            assert.ok(parsed.segments[0].args.includes('@regression-p0'));
        });

        it('does not mistake a pipe inside a quoted grep pattern for a shell operator', () => {
            const parsed = titles.mochaArgsFor(pkg.scripts['test:regression:p0p1']);
            assert.strictEqual(parsed.segments.length, 1,
                'the pattern carries a pipe and the script is still one command');
            assert.ok(parsed.segments[0].args.includes('@regression-p[01]'));
        });
    });
});

describe('bin/suite-title-map.js', function () {
    this.timeout(60000);

    describe('comparing a tree against a pin', () => {
        it('reports no difference when a rename is declared', () => {
            const fresh = {
                titleSets: { aaa: ['suite one', 'suite two'] },
                scripts: { test: { files: { 'test/unit/new_name.test.js': 'aaa' } } },
            };
            const renames = { 'test/unit/old_name.test.js': 'test/unit/new_name.test.js' };
            assert.deepStrictEqual(titles.compare(PIN, fresh, renames), []);
        });

        it('reports a file that quietly stopped being collected', () => {
            const fresh = { titleSets: {}, scripts: { test: { files: {} } } };
            const differences = titles.compare(PIN, fresh, {});
            assert.strictEqual(differences.length, 1);
            assert.strictEqual(differences[0].kind, 'file_dropped');
            assert.strictEqual(differences[0].file, 'test/unit/old_name.test.js');
        });

        it('reports a title that disappeared from a file that is still collected', () => {
            const fresh = {
                titleSets: { bbb: ['suite one'] },
                scripts: { test: { files: { 'test/unit/old_name.test.js': 'bbb' } } },
            };
            const differences = titles.compare(PIN, fresh, {});
            assert.deepStrictEqual(differences, [{
                script: 'test',
                kind: 'title_dropped',
                file: 'test/unit/old_name.test.js',
                title: 'suite two',
            }]);
        });

    });
});

describe('bin/suite-title-map.js', function () {
    this.timeout(60000);

    describe('comparing a tree against a pin', () => {
        it('reads a pin that stores title digests exactly as one that stores the text', () => {
            const hashed = titles.toPin(PIN);
            assert.strictEqual(hashed.titleEncoding, 'sha256');
            assert.ok(hashed.titleSets.aaa.every((d) => /^[0-9a-f]{64}$/.test(d)),
                'the committed pin carries digests, never title text');
            assert.deepStrictEqual(titles.compare(hashed, PIN, {}), []);
        });

        it('still names the file when one digested title no longer matches', () => {
            const fresh = {
                titleSets: { ccc: ['suite one', 'suite two, retitled'] },
                scripts: { test: { files: { 'test/unit/old_name.test.js': 'ccc' } } },
            };
            const differences = titles.compare(titles.toPin(PIN), fresh, {});
            assert.deepStrictEqual(differences.map((d) => [d.kind, d.file]), [
                ['title_dropped', 'test/unit/old_name.test.js'],
                ['title_added', 'test/unit/old_name.test.js'],
            ]);
            assert.strictEqual(differences[0].title, titles.titleDigest('suite two'));
            assert.strictEqual(differences[1].title, 'suite two, retitled',
                'a title the tree still carries prints as text');
        });
    });

    describe('--root', () => {
        it('collects the checkout it is given, not the one it lives in', () => {
            const before = titles.repoRoot();
            const other = path.resolve(__dirname, '../..');
            try {
                titles.setRepoRoot(other);
                assert.strictEqual(titles.repoRoot(), path.resolve(other));
            } finally {
                titles.setRepoRoot(before);
            }
            assert.strictEqual(titles.repoRoot(), before, 'the root must be restorable');
        });
    });
});
