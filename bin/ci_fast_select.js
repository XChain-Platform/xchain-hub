#!/usr/bin/env node
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

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONSENSUS = [
    'src/consensus/', 'src/consensus_rules_digest.js', 'src/coins/', 'src/lib/',
    'src/anchor/', 'src/oracle/', 'src/attestation/', 'src/cross_chain/',
    'src/validators/', 'src/rollcall/', 'src/sql/', 'src/db/', 'src/constants.js',
    'src/bcmath.js', 'src/price_batch_compression.js', 'src/xchainPrice.js',
    'src/xchainPriceQuery.js', 'src/chain-registry.json', 'src/hub_schema_version.js',
    'src/XChainHub.js', 'src/observability/', 'bin/pins/', 'bin/lib/',
    'bin/consensus-identity.js', 'bin/check-frozen-set.js',
];
const WIDEN = ['test/setup/', 'test/helpers/', 'test/fixtures/'];
const ALWAYS = [];
const GROUPS = [
    { name: 'unit', prefix: 'test/unit/' },
    { name: 'security', prefix: 'test/security/' },
    { name: 'regression', prefix: 'test/regression/' },
];
const GROUP_ARGS = [
    '--require', './test/setup/index.js', '--timeout', '5000', '--recursive', '--exit',
];

function outputText(value) {
    if (value && typeof value === 'object' && 'stdout' in value) return String(value.stdout).trim();
    return value === undefined || value === null ? '' : String(value).trim();
}

function callGit(git, args) {
    return git.length === 1 ? git(args) : git(...args);
}

function resolveBase({ env, git }) {
    const promised = env.PROM_CI_BASE_SHA;
    if (promised) {
        try {
            callGit(git, ['cat-file', '-e', `${promised}^{commit}`]);
            return promised;
        } catch (_) {
            // Fall through to the repository merge base when the venue SHA is stale.
        }
    }
    try {
        return outputText(callGit(git, ['merge-base', 'HEAD', 'origin/develop'])) || null;
    } catch (_) {
        return null;
    }
}

function groupFor(file) {
    return GROUPS.find((group) => file.startsWith(group.prefix) && file.endsWith('.test.js'));
}

function isConsensusPath(file) {
    return CONSENSUS.some((prefix) => file.startsWith(prefix))
        || /^src\/[^/]+_activation\.js$/.test(file);
}

function lines(value) {
    if (Array.isArray(value)) return value;
    return outputText(value).split('\n').filter(Boolean);
}

function resolvedRelativeRequires(file) {
    let source;
    try {
        source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    } catch (_) {
        return [];
    }
    const resolved = [];
    const requirePattern = /require\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
    for (const match of source.matchAll(requirePattern)) {
        const target = path.resolve(REPO_ROOT, path.dirname(file), match[1]);
        resolved.push(path.extname(target) ? target : `${target}.js`);
        resolved.push(path.join(target, 'index.js'));
    }
    return resolved;
}

function consensusDependencyReasons(changedFiles, findRequirers) {
    const reasons = [];
    for (const changed of changedFiles.filter((file) => file.startsWith('src/'))) {
        const absolute = path.resolve(REPO_ROOT, changed);
        const basename = path.basename(changed, path.extname(changed));
        const needles = basename === 'index' ? [basename, path.basename(path.dirname(changed))] : [basename];
        const candidates = [...new Set(needles.flatMap((needle) => lines(findRequirers(needle))))];
        for (const candidate of candidates.filter(isConsensusPath)) {
            if (resolvedRelativeRequires(candidate).includes(absolute)) {
                reasons.push(`consensus dependency: ${candidate} -> ${changed}`);
            }
        }
    }
    return reasons;
}

function addNamedTests(selected, source, tests) {
    const relative = source.slice('src/'.length).replace(/\.js$/, '');
    const name = path.posix.basename(relative);
    const sourceDir = path.posix.dirname(relative);
    for (const test of tests) {
        const testDir = path.posix.dirname(test.slice('test/'.length).replace(/^[^/]+\//, ''));
        const basenameMatch = name !== 'index' && path.posix.basename(test) === `${name}.test.js`;
        const directoryMatch = test.includes(`/${name}.test/`);
        const sameDirectory = testDir === (sourceDir === '.' ? '.' : sourceDir);
        if (basenameMatch || directoryMatch || sameDirectory) selected.add(test);
    }
}

function addGrepTests(selected, source, tests, findRequirers) {
    const moduleTail = source.replace(/\.js$/, '');
    const matches = lines(findRequirers(moduleTail));
    const available = new Set(tests);
    for (const file of matches) {
        if (available.has(file) && groupFor(file)) selected.add(file);
    }
}

function mappedTests(changedFiles, tests, findRequirers) {
    const selected = new Set(ALWAYS);
    for (const changed of changedFiles) {
        if (groupFor(changed)) selected.add(changed);
        if (!changed.startsWith('src/')) continue;
        addNamedTests(selected, changed, tests);
        addGrepTests(selected, changed, tests, findRequirers);
    }
    return [...selected].filter((file) => tests.includes(file)).sort();
}

function selectFastTests(changedFiles, { listTests, findRequirers }) {
    const changed = [...new Set(changedFiles)].sort();
    const tests = lines(listTests()).filter((file) => groupFor(file));
    const reasons = [];
    for (const file of changed) {
        if (isConsensusPath(file)) reasons.push(`consensus: ${file}`);
        if (WIDEN.some((prefix) => file.startsWith(prefix))) reasons.push(`widen: ${file}`);
        if (file === 'package.json') reasons.push(`widen: ${file}`);
        if (file.startsWith('test/') && file.endsWith('.test.js') && !groupFor(file)) {
            reasons.push(`deferred: ${file}`);
        }
    }
    reasons.push(...consensusDependencyReasons(changed, findRequirers));
    const uniqueReasons = [...new Set(reasons)].sort();
    const consensus = uniqueReasons.some((reason) => !reason.startsWith('deferred:'));
    const selected = consensus ? [] : mappedTests(changed, tests, findRequirers);
    return {
        consensus,
        reasons: uniqueReasons,
        tests: selected.map((file) => ({ group: groupFor(file).name, file })),
    };
}

function git(args) {
    const result = childProcess.spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
    if (result.status !== 0) {
        const error = new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
        error.status = result.status;
        throw error;
    }
    return result.stdout.trim();
}

function listTests() {
    return lines(git(['ls-files'])).filter((file) => groupFor(file));
}

function findRequirers(needle) {
    try {
        return lines(git(['grep', '-l', '-F', '-e', needle, '--', '*.js']));
    } catch (error) {
        if (error.status === 1) return [];
        throw error;
    }
}

function buildPlan() {
    const base = resolveBase({ env: process.env, git });
    if (!base) {
        return { error: 'no valid PROM_CI_BASE_SHA and no origin/develop merge base', noBase: true };
    }
    let changed;
    try {
        changed = lines(git(['diff', '--name-only', `${base}...HEAD`]));
        return { plan: selectFastTests(changed, { listTests, findRequirers }) };
    } catch (error) {
        return { error: error.message };
    }
}

function printPlan(plan) {
    console.log(`consensus ${plan.consensus ? 1 : 0}`);
    for (const reason of plan.reasons) console.log(`reason ${reason}`);
    for (const test of plan.tests) console.log(`test ${test.group} ${test.file}`);
}

function runPlan(plan) {
    if (plan.tests.length === 0) {
        console.log('ci:fast: no test maps to this push');
        return 0;
    }
    let failed = false;
    for (const group of GROUPS) {
        const files = plan.tests.filter((test) => test.group === group.name).map((test) => test.file);
        if (files.length === 0) continue;
        const mocha = path.join(REPO_ROOT, 'node_modules', '.bin', 'mocha');
        const result = childProcess.spawnSync(mocha, ['--no-config', ...GROUP_ARGS, ...files], {
            cwd: REPO_ROOT,
            stdio: 'inherit',
        });
        if (result.status !== 0) failed = true;
    }
    return failed ? 1 : 0;
}

function main() {
    if (!['--plan', '--run'].includes(process.argv[2])) {
        console.error('usage: node bin/ci_fast_select.js --plan|--run');
        return 2;
    }
    const built = buildPlan();
    if (built.error) {
        console.log(`${built.noBase ? 'no-base' : 'selector-error'} ${built.error}`);
        return built.noBase ? 3 : 2;
    }
    if (process.argv[2] === '--plan') {
        printPlan(built.plan);
        return 0;
    }
    return runPlan(built.plan);
}

module.exports = { resolveBase, selectFastTests };

if (require.main === module) process.exitCode = main();
