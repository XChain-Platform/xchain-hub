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
 * The require graph: the edges out of each file, who requires each file, the
 * closure of a set of entry points, and the entry points the service starts.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const { getRepoRoot } = require('./root.js');
const { REQUIRE_LITERAL, resolveRequire } = require('./resolve.js');
const { DYNAMIC_EDGES } = require('./dynamic_edges.js');

/** Every repo-local file `rel` requires by a literal path, plus its declared dynamic edges. */
function edgesFrom(rel, fileSet) {
    const abs = path.join(getRepoRoot(), rel);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return []; }
    const out = new Set();
    REQUIRE_LITERAL.lastIndex = 0;
    let m;
    while ((m = REQUIRE_LITERAL.exec(text)) !== null) {
        const target = resolveRequire(rel, m[2]);
        if (target && fileSet.has(target)) out.add(target);
    }
    for (const edge of DYNAMIC_EDGES) {
        if (edge.from !== rel) continue;
        // A declared edge that no longer resolves is louder as a thrown error
        // than as a file that quietly starts reading unreachable.
        for (const target of edge.toList()) if (fileSet.has(target)) out.add(target);
    }
    return Array.from(out);
}

/**
 * Who requires each file, counting only non-test callers. Reachability alone
 * calls a module dead when its one caller is itself unreached, which is the
 * wrong verdict whenever that caller is being kept (a tool about to be promoted
 * into bin/, for instance). The reverse edge is what separates the two.
 */
function reverseEdges(fileSet) {
    const back = {};
    for (const rel of fileSet) {
        if (rel.startsWith('test/')) continue;
        for (const target of edgesFrom(rel, fileSet)) {
            if (!back[target]) back[target] = [];
            back[target].push(rel);
        }
    }
    for (const key of Object.keys(back)) back[key] = Array.from(new Set(back[key])).sort();
    return back;
}

/** Transitive closure of `entries` over the require graph. */
function closure(entries, fileSet) {
    const seen = new Set();
    const stack = entries.filter((e) => fileSet.has(e));
    while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const next of edgesFrom(cur, fileSet)) if (!seen.has(next)) stack.push(next);
    }
    return seen;
}

/**
 * What the service starts. Two sources, both read rather than assumed: the
 * Dockerfile's exec-form CMD or ENTRYPOINT, and every `node <file>` in an npm
 * script (`npm run migrate` is as much a production path as the API server).
 */
function runtimeEntries(fileSet) {
    const entries = new Set();

    const dockerfile = path.join(getRepoRoot(), 'Dockerfile');
    if (fs.existsSync(dockerfile)) {
        for (const line of fs.readFileSync(dockerfile, 'utf8').split('\n')) {
            if (!/^\s*(CMD|ENTRYPOINT)\b/.test(line)) continue;
            for (const m of line.matchAll(/["']([^"']+\.js)["']/g)) {
                const rel = m[1].replace(/^\.\//, '');
                if (fileSet.has(rel)) entries.add(rel);
            }
        }
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(getRepoRoot(), 'package.json'), 'utf8'));
    for (const [name, script] of Object.entries(pkg.scripts || {})) {
        // Every test and coverage tier is excluded by PREFIX, not by an exact
        // name: the hub carries `ci`, `ci:full`, `ci:security`, `ci:regression`
        // and `coverage:check` beside the plain ones, and a test runner admitted
        // here would fold the whole test closure into the runtime closure and
        // report every file in the repo as production-reachable.
        if (name.startsWith('test') || name.startsWith('ci') || name.startsWith('coverage')) continue;
        // Token walk rather than one regex: the argument between `node` and the
        // script can be a flag (`--no-node-snapshot`) or nothing at all, and a
        // pattern loose enough for both is loose enough to capture half a path.
        const tokens = script.split(/\s+/);
        for (let i = 0; i < tokens.length; i += 1) {
            if (tokens[i] !== 'node') continue;
            for (let j = i + 1; j < tokens.length; j += 1) {
                if (tokens[j].startsWith('-')) continue;
                if (tokens[j].endsWith('.js')) {
                    const rel = tokens[j].replace(/^\.\//, '');
                    if (fileSet.has(rel)) entries.add(rel);
                }
                break;
            }
        }
    }
    return Array.from(entries).sort();
}

/** Every .js directly under a directory tree, as entry points in their own right. */
function entriesUnder(prefixes, fileSet) {
    return Array.from(fileSet).filter((f) => prefixes.some((p) => f.startsWith(p)) && f.endsWith('.js')).sort();
}

module.exports = { edgesFrom, reverseEdges, closure, runtimeEntries, entriesUnder };
