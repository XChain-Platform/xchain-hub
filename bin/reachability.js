#!/usr/bin/env node
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
 * Can anything still reach this file? Asked of every src/*.js, across the
 * platform rather than inside this repo alone.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A REPO-LOCAL QUESTION. A restructure that
 * deletes a file because no runtime path inside the repo reaches it will delete
 * a module another service requires by relative path out of this checkout, and
 * nothing here fails: the break lands in the sibling's CI, later, attributed to
 * the sibling. Several hub modules are exactly that shape. A file with no
 * caller in this repo is therefore a CANDIDATE for deletion, and the sibling
 * sweep is what turns a candidate into a verdict.
 *
 * THE FOUR REACHES, kept apart because they carry different weight:
 *
 *   runtime   the require closure of what the service actually starts:
 *             the Dockerfile CMD, and every `node <file>` an npm script runs.
 *             A file outside this closure cannot execute in production.
 *   tooling   the closure of bin/, scripts/ and tools/: operator commands,
 *             verifiers, benchmarks. Real callers, not production ones.
 *   test      the closure of test/. A file reached only from here exists to
 *             be tested and nothing else, which CODE-STYLE calls a signal that
 *             the file is dead rather than a reason to keep it.
 *   siblings  any other repo naming the path, from bin/sibling-reference-map.js
 *             so the two tools can never disagree about what a reference is.
 *
 * A file outside all four is unreferenced across the platform and is the only
 * shape this pass deletes outright.
 *
 * THE SIBLING REACH INCLUDES THE PLATFORM TOOLING, and it has to. The map tool
 * sweeps the `xchain-*` siblings by default and treats the surrounding tree's
 * tooling directories as OPT-IN, because those paths belong to the tree around
 * this checkout rather than to this repo. A deletion verdict cannot take that
 * option: the twin-copier script alone byte-copies about thirty of this repo's
 * src/ files outward and no CI job runs it, so a module held only from there
 * reads deletable with the sweep off and takes the tooling down with it when
 * deleted. This tool therefore turns the sweep ON and names the directories
 * itself, from SIBLING_MAP_EXTRA_DIRS when the caller set it and otherwise from
 * a probe of the tree beside this checkout (see toolingSweepDirs).
 *
 * DYNAMIC EDGES. A static walk cannot see a require built at runtime, so every
 * such edge is declared in DYNAMIC_EDGES below with the site that builds it.
 * The walk reports how many it applied, so a new computed require that nobody
 * declared shows up as a file that suddenly reads unreachable.
 *
 * THE HUB HAS THREE OF THEM AND TWO OF THE THREE FAIL SILENTLY. The rules digest
 * reports a carrier it cannot load as ABSENT, and the bridge engine's
 * loadActivation returns null and idles the engine, so a move that misses either
 * one throws nothing, logs nothing and fails no test. They are declared below
 * with the site that builds them, and the declaration is read out of the source
 * rather than restated, because a restated list is a second registry that drifts.
 *
 * WHICH CHECKOUT IS MEASURED. `--root <dir>` names the hub checkout to walk, so
 * one lane of a restructure can drive this tool out of its own worktree against
 * ANOTHER lane's tree. With no flag it measures the repo it lives in.
 *
 * USAGE
 *   node bin/reachability.js                    human summary plus the candidates
 *   node bin/reachability.js --root <dir>       measure another hub checkout
 *   node bin/reachability.js --json             the full per-file verdict
 *   node bin/reachability.js --siblings <dir>   sweep root for the sibling half
 *   node bin/reachability.js --no-siblings      repo-local reaches only, fast
 *   SIBLING_MAP_EXTRA_DIRS=<dir>,<dir> node bin/reachability.js
 *                                               name the tooling directories
 *                                               instead of probing for them
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const { buildReferenceMap } = require('./lib/sibling_reference_map/scan.js');
const { getRepoRoot, setRepoRoot } = require('./lib/reachability/root.js');
const { trackedFiles, resolveRequire } = require('./lib/reachability/resolve.js');
const { DYNAMIC_EDGES } = require('./lib/reachability/dynamic_edges.js');
const { reverseEdges, closure, runtimeEntries, entriesUnder } = require('./lib/reachability/graph.js');
const { toolingSweepDirs, twinCopies } = require('./lib/reachability/siblings.js');

/**
 * The verdict for every src/*.js.
 * @returns {{summary: object, files: object}}
 */
function analyse(opts) {
    if (opts.root) setRepoRoot(opts.root);
    const all = trackedFiles();
    const fileSet = new Set(all.filter((f) => f.endsWith('.js')));
    const sources = Array.from(fileSet).filter((f) => f.startsWith('src/')).sort();

    const runtimeEntryList = runtimeEntries(fileSet);
    const toolingEntryList = entriesUnder(['bin/', 'scripts/', 'tools/'], fileSet);
    const testEntryList = entriesUnder(['test/'], fileSet);

    const runtime = closure(runtimeEntryList, fileSet);
    const tooling = closure(toolingEntryList, fileSet);
    const tested = closure(testEntryList, fileSet);

    const { siblings, twins } = siblingHalf(opts, sources);
    const back = reverseEdges(fileSet);
    const files = fileVerdicts(sources, { runtime, tooling, tested }, siblings, twins, back);

    const notRuntime = sources.filter((f) => !files[f].reachableFromHubRuntime);
    return {
        summary: {
            sourceFiles: sources.length,
            runtimeEntryPoints: runtimeEntryList,
            toolingEntryPoints: toolingEntryList.length,
            testEntryPoints: testEntryList.length,
            dynamicEdgesDeclared: DYNAMIC_EDGES.length,
            reachableFromHubRuntime: sources.length - notRuntime.length,
            notReachableFromHubRuntime: notRuntime.length,
            testOnly: sources.filter((f) => files[f].testOnly).length,
            unreferencedAcrossPlatform: sources.filter((f) => files[f].unreferencedAcrossPlatform).length,
            siblingRepos: siblings.siblingRepos,
        },
        candidates: notRuntime,
        files,
    };
}

/** The sibling map and the twin copies, or empty stand-ins when the sweep is off. */
function siblingHalf(opts, sources) {
    let siblings = { paths: {}, siblingRepos: [], distinctPathCount: 0 };
    let twins = {};
    if (opts.siblings !== false) {
        siblings = buildReferenceMap(opts.siblingsRoot, {
            includePlatformTooling: true,
            extraDirs: toolingSweepDirs(opts.siblingsRoot),
            repoRoot: getRepoRoot(),
        });
        twins = twinCopies(sources, opts.siblingsRoot);
    }
    return { siblings, twins };
}

/** One verdict per source file, from the three closures and the sibling half. */
function fileVerdicts(sources, reach, siblings, twins, back) {
    const { runtime, tooling, tested } = reach;
    const files = {};
    for (const rel of sources) {
        const sibling = siblings.paths[rel];
        const reachableFromHubRuntime = runtime.has(rel);
        const reachableFromTooling = tooling.has(rel);
        const reachableFromTests = tested.has(rel);
        files[rel] = {
            reachableFromHubRuntime,
            reachableFromTooling,
            reachableFromTests,
            referencedBySiblings: sibling ? sibling.referrers.map((r) => `${r.file}:${r.line} (${r.kind})`) : [],
            siblingLoadCount: sibling ? sibling.referrers.filter((r) => r.kind !== 'text').length : 0,
            twinCopies: twins[rel] || [],
            requiredByInRepo: back[rel] || [],
            testOnly: !reachableFromHubRuntime && !reachableFromTooling && reachableFromTests,
            // Tests are deliberately not a reason to keep a file: CODE-STYLE
            // reads a suite over an otherwise unreachable module as evidence the
            // module is dead, and the suite is deleted with it. Everything else
            // that can hold a file counts.
            unreferencedAcrossPlatform: !reachableFromHubRuntime && !reachableFromTooling
                && !sibling && !twins[rel] && !(back[rel] || []).length,
        };
    }
    return files;
}

function parseArgs(argv) {
    const opts = { json: false, siblings: true, siblingsRoot: null };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--json') opts.json = true;
        else if (argv[i] === '--root') { opts.root = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--no-siblings') opts.siblings = false;
        else if (argv[i] === '--siblings') { opts.siblingsRoot = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        return;
    }
    // --root before the siblings default, because the tree a checkout sits in is
    // the checkout's own business and not this script's.
    if (opts.root) setRepoRoot(opts.root);
    if (!opts.siblingsRoot) opts.siblingsRoot = path.resolve(getRepoRoot(), '..');
    const report = analyse(opts);
    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    const s = report.summary;
    console.log(`src/*.js tracked:                    ${s.sourceFiles}`);
    console.log(`runtime entry points:                ${s.runtimeEntryPoints.join(', ')}`);
    console.log(`tooling entry points:                ${s.toolingEntryPoints}`);
    console.log(`test entry points:                   ${s.testEntryPoints}`);
    console.log(`declared dynamic edges:              ${s.dynamicEdgesDeclared}`);
    console.log(`reachable from hub runtime:          ${s.reachableFromHubRuntime}`);
    console.log(`NOT reachable from hub runtime:      ${s.notReachableFromHubRuntime}`);
    console.log(`test-only:                           ${s.testOnly}`);
    console.log(`unreferenced across the platform:    ${s.unreferencedAcrossPlatform}`);
    console.log('');
    if (!report.candidates.length) return;
    console.log('files no runtime path in this repo reaches, and what else holds them:');
    for (const rel of report.candidates) {
        const f = report.files[rel];
        const holds = [];
        if (f.reachableFromTooling) holds.push('bin/scripts');
        if (f.reachableFromTests) holds.push('tests');
        if (f.referencedBySiblings.length) {
            holds.push(`siblings x${f.referencedBySiblings.length} (${f.siblingLoadCount} load)`);
        }
        if (f.twinCopies.length) {
            holds.push(`twin in ${f.twinCopies.map((t) => t.path.split('/')[0]).join('+')}`);
        }
        if (f.requiredByInRepo.length) holds.push(`required by ${f.requiredByInRepo.join(', ')}`);
        console.log(`  ${rel.padEnd(48)} ${holds.length ? holds.join(', ') : 'NOTHING: unreferenced across the platform'}`);
    }
}

if (require.main === module) main();

module.exports = {
    analyse,
    closure,
    runtimeEntries,
    resolveRequire,
    toolingSweepDirs,
    setRepoRoot,
    // The measured checkout, as a call rather than a binding: a consumer that
    // captured the value at require time would keep reading the default after
    // --root moved it.
    repoRoot: getRepoRoot,
    DYNAMIC_EDGES,
};
