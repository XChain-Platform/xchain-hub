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
 * Collecting what each npm script runs: its command line read into mocha
 * invocations and npm members, each invocation run under --dry-run, and the
 * titles folded into one map.
 *
 ********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// The checkout under measurement. A binding rather than a constant so `--root`
// can aim it at another hub worktree: several lanes of a restructure run at once
// in separate trees and each has to be able to take this reading against its own.
let REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Mocha as the measured checkout installs it, not as this one does. */
function mochaBin() { return path.join(REPO_ROOT, 'node_modules', '.bin', 'mocha'); }

/**
 * Collect `dir` instead of the checkout this script lives in.
 * @param {string} dir a hub checkout
 * @returns {string} the resolved root
 */
function setRepoRoot(dir) { REPO_ROOT = path.resolve(dir); return REPO_ROOT; }

/** The checkout under measurement, read at call time so a later --root is seen. */
function getRepoRoot() { return REPO_ROOT; }

/**
 * A shell-ish split that keeps quoted globs whole. The scripts are plain
 * `mocha ...` command lines with quoted glob arguments and the occasional
 * leading VAR=value; nothing here has a pipe, a subshell or a redirect, and a
 * script that grows one is reported as unsupported rather than mis-parsed.
 */
function splitCommand(script) {
    const tokens = [];
    let current = '';
    let quote = null;
    let started = false;
    let quoted = false;
    const push = () => { tokens.push({ value: current, quoted }); current = ''; started = false; quoted = false; };
    for (const ch of script) {
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; started = true; quoted = true; continue; }
        if (/\s/.test(ch)) {
            if (started || current) push();
            continue;
        }
        current += ch;
    }
    if (started || current) push();
    return tokens;
}

// Shell operators, recognised only on an UNQUOTED token: --grep '@x.*(a|b)'
// carries a pipe inside its pattern and is a perfectly ordinary single command.
const SHELL_OPERATOR = /^(?:&&|\|\||[|;]|[<>]+)$/;

/**
 * One `&&`-joined segment of a script, as a mocha invocation or as a reason it
 * is not one. Leading environment assignments (FUZZ_RUNS=1000 mocha ...) are set
 * on the child rather than dropped: a suite may name its title from one.
 *
 * @param {{value: string, quoted: boolean}[]} tokens
 * @returns {{args: string[], env: object}|{npm: string}|{skip: string}}
 */
function segmentCommand(tokens) {
    for (let i = 0; i < tokens.length - 1; i += 1) {
        if (tokens[i].value !== 'npm') continue;
        // `npm test` is the same member as `npm run test` and has to land under
        // the same name, or the union looks short by a suite.
        if (tokens[i + 1].value === 'run' && tokens[i + 2]) return { npm: tokens[i + 2].value };
        if (tokens[i + 1].value === 'test') return { npm: 'test' };
    }
    const env = {};
    let i = 0;
    while (i < tokens.length && !tokens[i].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i].value)) {
        const eq = tokens[i].value.indexOf('=');
        env[tokens[i].value.slice(0, eq)] = tokens[i].value.slice(eq + 1);
        i += 1;
    }
    if (!tokens[i] || tokens[i].value !== 'mocha') {
        return { skip: `not a mocha command (runs ${tokens[i] ? tokens[i].value : 'nothing'})` };
    }
    return { args: tokens.slice(i + 1).map((t) => t.value), env };
}

/**
 * What a test script actually is: one mocha command, a chain of npm members, or
 * a chain that mixes the two. Every segment is answered for; see A CHAIN IS
 * COLLECTED, NOT JUST NAMED in the header for why a chain is not just its names.
 *
 * @returns {{segments: object[]}} one entry per `&&`-joined segment
 */
function mochaArgsFor(script) {
    const tokens = splitCommand(script);
    const segments = [];
    let current = [];
    for (const token of tokens) {
        if (!token.quoted && SHELL_OPERATOR.test(token.value)) {
            if (current.length) segments.push(segmentCommand(current));
            current = [];
            continue;
        }
        current.push(token);
    }
    if (current.length) segments.push(segmentCommand(current));
    return { segments };
}

/**
 * Run one mocha invocation under --dry-run and return {file: [titles]}, or the
 * reason it could not be read.
 *
 * @param {{args: string[], env: object}} invocation
 * @returns {{files: object}|{error: string}}
 */
function runMocha(invocation) {
    const res = spawnSync(mochaBin(), ['--dry-run', '--reporter', 'json', ...invocation.args], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...invocation.env },
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf8',
    });
    if (res.error) return { error: String(res.error.message) };

    let report;
    try {
        // The json reporter writes the report to stdout, but a spec file that
        // logs at load time writes there too; the report is the last JSON
        // object, so parsing starts at the last line that opens one.
        const start = res.stdout.indexOf('{\n  "stats"');
        report = JSON.parse(start === -1 ? res.stdout : res.stdout.slice(start));
    } catch (e) {
        return { error: `unparseable mocha json (exit ${res.status}): ${String(res.stderr || '').slice(0, 400)}` };
    }

    const files = {};
    for (const test of (report.tests || []).concat(report.pending || [])) {
        const rel = test.file ? path.relative(REPO_ROOT, test.file) : '(no file)';
        if (!files[rel]) files[rel] = [];
        files[rel].push(test.fullTitle);
    }
    return { files };
}

/**
 * Titles for one script, keyed by repo-relative test file, with every segment of
 * a chained script answered for.
 *
 * A named npm member is NOT expanded here: it is pinned in its own right under
 * its own name, and restating its titles would pin the same suites twice and
 * make one rename look like two. What is collected is every segment spelled
 * inline, which nothing else in the pin covers.
 */
function collect(scriptName, script) {
    const { segments } = mochaArgsFor(script);
    const members = segments.filter((s) => s.npm).map((s) => s.npm);
    const runnable = segments.filter((s) => s.args);
    const skipped = segments.filter((s) => s.skip).map((s) => s.skip);

    const result = {};
    if (members.length) result.composite = members;
    // The reason is kept even when another segment collected fine, so a chain
    // that is half readable never reads as fully collected.
    if (skipped.length) result.skipped = skipped.join('; ');

    if (!runnable.length) {
        if (!members.length && !skipped.length) result.skipped = 'no command this tool can read';
        return result;
    }

    const files = {};
    for (const invocation of runnable) {
        const run = runMocha(invocation);
        if (run.error) return Object.assign(result, { error: run.error });
        for (const rel of Object.keys(run.files)) {
            if (!files[rel]) files[rel] = [];
            files[rel].push(...run.files[rel]);
        }
    }

    const sorted = {};
    let titles = 0;
    for (const rel of Object.keys(files).sort()) {
        // Sorted and de-duplicated: two segments of one chain can collect the
        // same file, and the invariant is the SET of titles, not how many times
        // the chain happened to load it.
        sorted[rel] = Array.from(new Set(files[rel])).sort();
        titles += sorted[rel].length;
    }
    return Object.assign(result, {
        fileCount: Object.keys(sorted).length,
        titleCount: titles,
        files: sorted,
    });
}

function setKey(titles) {
    return crypto.createHash('sha256').update(titles.join('\n')).digest('hex').slice(0, 16);
}

function buildMap(only) {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    // test* AND ci*: see WHICH SCRIPTS in the header. The ci tiers are the ones
    // the venue runs, so a glob that quietly stopped collecting a file there
    // would be the failure this pin exists to catch.
    const names = Object.keys(pkg.scripts || {})
        .filter((n) => n.startsWith('test') || n.startsWith('ci')).sort();
    const titleSets = {};
    const scripts = {};
    for (const name of names) {
        if (only && name !== only) continue;
        const result = collect(name, pkg.scripts[name]);
        if (result.files) {
            const files = {};
            for (const rel of Object.keys(result.files)) {
                const key = setKey(result.files[rel]);
                titleSets[key] = result.files[rel];
                files[rel] = key;
            }
            result.files = files;
        }
        scripts[name] = result;
    }
    const sortedSets = {};
    for (const key of Object.keys(titleSets).sort()) sortedSets[key] = titleSets[key];
    return { titleSets: sortedSets, scripts };
}

module.exports = {
    getRepoRoot,
    setRepoRoot,
    splitCommand,
    segmentCommand,
    mochaArgsFor,
    runMocha,
    collect,
    setKey,
    buildMap,
};
