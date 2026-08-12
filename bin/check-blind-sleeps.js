#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Blind-sleep ratchet for the test tree .
 *
 * A BLIND SLEEP is a fixed-duration wait standing in for a poll on an
 * observable condition: `await sleep(200)` between "make it happen" and
 * "assert it happened". It passes or fails on how busy the box is, which is
 * why it is the shape that reddens first on a loaded CI runner. The whole
 * tree was converted to `test/helpers/waitUntil.js` (and, in the e2e tree,
 * `test/e2e/helpers/waitFor.js`'s `poll`); this gate keeps it at zero.
 *
 * NOT counted, because neither is a timing assumption about someone else's work:
 *   - a sleep inside a bounded, condition-checking loop (a poll INTERVAL),
 *   - a `setTimeout` whose executor rejects (a deadline, normally one arm of a
 *     `Promise.race`),
 *   - a yield of 0-1ms (draining the microtask queue: nothing to poll for),
 *   - a wait helper's own DEFINITION (the call sites are the wait sites),
 *   - a file with no test cases (a fixture or mock cannot flake; a latency
 *     model's setTimeout IS the behavior under test).
 *
 * The predicate mirrors the platform review monitor's `sleep-flake` check, so
 * a clean run here is a clean run there.
 *
 * Usage:  node bin/check-blind-sleeps.js [--list]
 * Exit:   0 when the tree is clean, 1 when any site is found.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT     = path.join(__dirname, '..');
const SCAN_DIR = path.join(ROOT, 'test');

const SLEEP_RE = /new Promise\s*\(\s*(?:\(?\s*\w+\s*\)?|resolve)\s*=>\s*setTimeout|setTimeout\s*\(\s*(?:done|resolve)/;
// A wait helper factored out of the raw setTimeout Promise: capture the NAME so
// its call sites are counted while the definition itself is not.
const SLEEP_DEF_RES = [
    /\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/
];
// Bare call only: `sdk.sleep({...})` is somebody's business method, not a wait.
const SLEEP_CALL_RE    = /(?<![.\w$])sleep\s*\(/;
const TIMEOUT_GUARD_RE = /setTimeout\s*\(\s*\(?[^)]*\)?\s*=>\s*(?:reject|[\w$]+\.reject)\b/;
const SHORT_YIELD_RE   = /setTimeout\s*\(\s*(?:[\w$]+|\([^)]*\)\s*=>[^,]*)\s*,\s*(\d+)\s*\)/;
const YIELD_MAX_MS     = 1;
const LOOP_HEADER_RE   = /\b(?:while|for)\s*\(/;
const CASE_RE          = /(?<![.\w$])(?:it|test|specify)\s*\(\s*['"`]/g;
const DEF_BODY_LINES   = 3;

// Line with its string literals emptied and its line comment cut, so a wait
// spelled inside a STRING (or braces inside one) never reads as code.
function stripLiterals(line) {
    return line
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/`(?:\\.|[^`\\])*`/g, '``')
        .replace(/\/\/.*$/, '');
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function isExemptWait(line) {
    if (TIMEOUT_GUARD_RE.test(line)) return true;
    const m = SHORT_YIELD_RE.exec(line);
    return !!m && Number(m[1]) <= YIELD_MAX_MS;
}

// A declaration is a wait helper only when a setTimeout wait sits within a few
// lines of it, so an ordinary function is never mistaken for one.
function sleepHelperAt(lines, i) {
    let name = null;
    for (const re of SLEEP_DEF_RES) {
        const m = re.exec(lines[i]);
        if (m) { name = m[1]; break; }
    }
    if (!name) return null;
    const last = Math.min(lines.length - 1, i + DEF_BODY_LINES);
    for (let j = i; j <= last; j++) {
        if (SLEEP_RE.test(lines[j])) return { name, through: j };
    }
    return null;
}

/**
 * Every blind-sleep site in one file's source.
 *
 * Pass 1 finds the wait helpers and the lines their definitions occupy; pass 2
 * walks forward tracking block nesting, so "inside a bounded loop" is a lexical
 * fact rather than a guess from the previous few lines.
 *
 * @param {string} body file source
 * @returns {Array<{line: number, text: string}>}
 */
function blindSleepSites(body) {
    const lines = body.split('\n').map(stripLiterals);
    const helperNames = new Set();
    const defLines    = new Set();
    for (let i = 0; i < lines.length; i++) {
        const def = sleepHelperAt(lines, i);
        if (!def) continue;
        helperNames.add(def.name);
        for (let j = i; j <= def.through; j++) defLines.add(j);
    }
    helperNames.add('sleep');                                   // imported helpers have no local definition
    const callRe = new RegExp('(?<![.\\w$])(?:' + [...helperNames].map(escapeRe).join('|') + ')\\s*\\(');

    const openLoops = [];
    const sites = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isWaitSite = !defLines.has(i)
            && !isExemptWait(line)
            && (SLEEP_RE.test(line) || SLEEP_CALL_RE.test(line) || callRe.test(line));
        // Judged before this line's braces close, so a wait on the same line as
        // its own loop header counts as a poll interval too.
        if (isWaitSite && !openLoops.some(Boolean) && !LOOP_HEADER_RE.test(line)) {
            sites.push({ line: i + 1, text: line.trim() });
        }
        const loopHere = LOOP_HEADER_RE.test(line);
        for (const ch of line) {
            if (ch === '{') openLoops.push(loopHere);
            else if (ch === '}') openLoops.pop();
        }
    }
    return sites;
}

function walk(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules') continue;
            walk(p, out);
        } else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

/**
 * Scan the test tree.
 * @param {string} [scanDir]
 * @returns {Array<{file: string, sites: Array<{line: number, text: string}>}>}
 */
function scan(scanDir) {
    const dir = scanDir || SCAN_DIR;
    const findings = [];
    for (const file of walk(dir, [])) {
        const body = fs.readFileSync(file, 'utf8');
        const code = body.split('\n').map(stripLiterals).join('\n');
        const cases = (code.match(CASE_RE) || []).length;
        if (cases === 0) continue;                              // fixtures and helpers cannot flake
        const sites = blindSleepSites(body);
        if (sites.length) findings.push({ file: path.relative(ROOT, file), sites });
    }
    return findings;
}

module.exports = { scan, blindSleepSites };

if (require.main === module) {
    const findings = scan();
    const total = findings.reduce((n, f) => n + f.sites.length, 0);
    for (const f of findings) {
        console.log(f.file + '  (' + f.sites.length + ')');
        for (const s of f.sites) console.log('    ' + s.line + ': ' + s.text);
    }
    if (total === 0) {
        console.log('blind-sleep ratchet: 0 sites in ' + path.relative(ROOT, SCAN_DIR) + '/');
        process.exit(0);
    }
    console.error('blind-sleep ratchet: ' + total + ' site(s) in ' + findings.length + ' file(s). ' +
                  'Poll the condition with test/helpers/waitUntil.js instead of sleeping.');
    process.exit(1);
}
