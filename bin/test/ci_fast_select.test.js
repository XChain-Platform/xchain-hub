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
 *********************************************************************/

'use strict';

const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const selector = require('../ci_fast_select.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function git(args) {
    const result = childProcess.spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
    if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim().split('\n').filter(Boolean);
}

function listTests() {
    return git(['ls-files']).filter((file) => /^test\/(unit|security|regression)\//.test(file)
        && file.endsWith('.test.js'));
}

function findRequirers(needle) {
    return git(['grep', '-l', '-F', '-e', needle, '--', '*.js']);
}

function plan(changedFiles) {
    return selector.selectFastTests(changedFiles, { listTests, findRequirers });
}

function scratchGit(cwd, args) {
    return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function writeScratchFile(cwd, file, source) {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
}

function scratchCommit(cwd, message, files) {
    scratchGit(cwd, ['add', '--', ...files]);
    scratchGit(cwd, [
        '-c', 'user.name=Selector Test',
        '-c', 'user.email=selector-test',
        'commit', '-m', message,
    ]);
}

describe('bin/ci_fast_select.js', function () {
    it('maps changed API and provider modules to their unit tests', () => {
        const cors = plan(['src/api/cors_origin.js']);
        assert.strictEqual(cors.consensus, false);
        assert.ok(cors.tests.some((test) => test.file === 'test/unit/api/cors_origin.test.js'));

        const claude = plan(['src/providers/llm/claude_spawn.js']);
        assert.strictEqual(claude.consensus, false);
        assert.ok(claude.tests.some((test) => test.file === 'test/unit/providers/llm/claude_spawn.test.js'));
    });

    it('widens consensus, oracle, and package changes to the full tier', () => {
        for (const file of ['src/consensus/rules.js', 'src/oracle/price.js', 'package.json']) {
            const result = plan([file]);
            assert.strictEqual(result.consensus, true, file);
            assert.ok(result.reasons.some((reason) => reason.includes(file)), file);
            assert.deepStrictEqual(result.tests, []);
        }
    });

    it('maps documentation changes to no tests', () => {
        assert.deepStrictEqual(plan(['README.md']), { consensus: false, reasons: [], tests: [] });
    });

    it('defers tracked test tiers that have no fast runner group', () => {
        const integration = git(['ls-files', 'test/integration']).find((file) => file.endsWith('.test.js'));
        assert.ok(integration, 'the real tree must retain an integration test for this pin');
        const result = plan([integration]);
        assert.strictEqual(result.consensus, false);
        assert.deepStrictEqual(result.tests, []);
        assert.ok(result.reasons.includes(`deferred: ${integration}`));
    });

    it('rejects an unknown venue base when merge-base also fails', () => {
        const failingGit = () => { throw new Error('unknown revision'); };
        assert.strictEqual(selector.resolveBase({
            env: { PROM_CI_BASE_SHA: 'not-a-commit' },
            git: failingGit,
        }), null);
    });

    it('accepts a venue base that git recognizes as a commit', () => {
        const calls = [];
        const acceptingGit = (args) => { calls.push(args); return ''; };
        const sha = '0123456789abcdef';
        assert.strictEqual(selector.resolveBase({
            env: { PROM_CI_BASE_SHA: sha },
            git: acceptingGit,
        }), sha);
        assert.deepStrictEqual(calls, [['cat-file', '-e', `${sha}^{commit}`]]);
    });

    it('keeps the fast selector behind the fast tier guard', () => {
        const script = fs.readFileSync(path.join(REPO_ROOT, 'bin/ci-full.sh'), 'utf8');
        assert.ok(script.includes('ci_fast_select.js --plan'));
        assert.match(script, /if \[ "\$\{CI_TIER:-full\}" = "fast" \][\s\S]*ci_fast_select\.js --plan/);
        assert.ok(script.includes('run_tier "ci" env XCHAIN_REQUIRE_SIBLINGS=1 npm run ci'));
    });

    it('replays develop history, compares narrowing, and checks required selections', () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-fast-select-replay-'));
        try {
            scratchGit(cwd, ['init', '--initial-branch=develop']);
            const initial = {
                'src/consensus/rule.js': "module.exports = 'rule';\n",
                'src/feature/plain.js': "module.exports = 'plain';\n",
                'test/unit/consensus/rule.test.js':
                    "require('../../../src/consensus/rule');\n",
                'test/unit/feature/plain.test.js': "require('../../../src/feature/plain');\n",
                'test/unit/only.test.js': "module.exports = 'only';\n",
                'test/unit/other/unrelated.test.js': "module.exports = 'unrelated';\n",
            };
            for (const [file, source] of Object.entries(initial)) {
                writeScratchFile(cwd, file, source);
            }
            scratchCommit(cwd, 'initial files', Object.keys(initial));

            const consensusFile = 'src/consensus/rule.js';
            fs.appendFileSync(path.join(cwd, consensusFile), "module.exports += ' changed';\n");
            scratchCommit(cwd, 'consensus change', [consensusFile]);

            const plainFile = 'src/feature/plain.js';
            fs.appendFileSync(path.join(cwd, plainFile), "module.exports += ' changed';\n");
            scratchCommit(cwd, 'plain source change', [plainFile]);

            const testFile = 'test/unit/only.test.js';
            fs.appendFileSync(path.join(cwd, testFile), "module.exports += ' changed';\n");
            scratchCommit(cwd, 'test only change', [testFile]);
            scratchGit(cwd, ['update-ref', 'refs/remotes/origin/develop', 'HEAD']);

            const selectorPath = path.resolve(__dirname, '../ci_fast_select.js');
            const mustSelect = [
                'src/consensus/rule.js:test/unit/consensus/rule.test.js',
                'src/feature/plain.js:test/unit/other/unrelated.test.js',
            ].join(',');
            const result = childProcess.spawnSync(process.execPath, [
                selectorPath,
                '--replay', '3',
                '--narrow', 'src/consensus/',
                '--must-select', mustSelect,
            ], { cwd, encoding: 'utf8' });

            assert.strictEqual(result.status, 1, result.stderr);
            const output = result.stdout.trim().split(/\r?\n/);
            assert.ok(output.includes('plan commits consensus-1 changed-tests test-only no-tests'));
            assert.ok(output.includes('current 3 1/3 1/3 1/3 0/3'));
            assert.ok(output.includes('narrowed 3 0/3 2/3 1/3 0/3'));
            assert.ok(output.includes(
                'must-select PASS src/consensus/rule.js:test/unit/consensus/rule.test.js',
            ));
            assert.ok(output.includes(
                'must-select FAIL src/feature/plain.js:test/unit/other/unrelated.test.js',
            ));
        } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });
});
