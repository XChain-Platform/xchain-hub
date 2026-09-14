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
const { execFileSync } = require('child_process');

const {
    buildReferenceMap,
    platformToolingDirs,
    setRepoRoot: setMapRepoRoot,
} = require('./sibling-reference-map.js');

// The checkout under measurement, a binding rather than a constant so `--root`
// can aim the whole walk at another hub worktree. See WHICH CHECKOUT IS MEASURED.
let REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Walk `dir` instead of the checkout this script lives in.
 * @param {string} dir a hub checkout
 * @returns {string} the resolved root
 */
function setRepoRoot(dir) {
    REPO_ROOT = path.resolve(dir);
    setMapRepoRoot(REPO_ROOT);
    return REPO_ROOT;
}

// The twin-copier script, by name only. Which directory of the surrounding tree
// holds the platform's tooling is that tree's business, so the sweep finds the
// tooling parent by looking for this script instead of carrying its path.
const TWIN_COPIER = 'reconcile-twins.sh';

// Tooling that sits at the top of the surrounding tree rather than inside the
// tooling parent. Swept when present, skipped silently when this checkout
// stands alone, which is every consumer outside the platform tree.
const TOP_LEVEL_TOOLING = ['bin', 'tools'];

// Subdirectories of the tooling parent that hold executables. Its other
// subdirectories are prose (specs, reports, runbooks), and a document naming a
// module is a mention, not a holder: sweeping them would clear a dead file.
const TOOLING_PARENT_SUBDIRS = ['bin', 'scripts'];

/**
 * The platform tooling directories to sweep, relative to the siblings root.
 * SIBLING_MAP_EXTRA_DIRS wins when the caller named them; otherwise they are
 * probed for, so a verdict taken on a fresh checkout is the same verdict.
 *
 * @param {string} siblingsRoot the tree this checkout sits in
 * @returns {string[]} directories, relative to that root, possibly empty
 */
function toolingSweepDirs(siblingsRoot) {
    const named = platformToolingDirs();
    if (named.length) return named;

    const dirs = [];
    const present = (rel) => fs.existsSync(path.join(siblingsRoot, rel));
    for (const rel of TOP_LEVEL_TOOLING) if (present(rel)) dirs.push(rel);

    let entries;
    try { entries = fs.readdirSync(siblingsRoot, { withFileTypes: true }); } catch (e) { return dirs; }
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('xchain-')) continue;
        if (!present(path.join(entry.name, 'bin', TWIN_COPIER))) continue;
        for (const sub of TOOLING_PARENT_SUBDIRS) {
            const rel = path.join(entry.name, sub);
            if (present(rel)) dirs.push(rel);
        }
    }
    return dirs;
}

/**
 * Requires this repo builds at runtime, which no static walk can follow.
 * Each entry names the site that builds the path and what it resolves to, so a
 * reader can check the claim instead of trusting the table.
 */
const DYNAMIC_EDGES = [
    {
        from: 'src/consensus_rules_digest.js',
        // loadGateValues requires './<module>.js' for every SHARED_GATES row, so
        // the gate carriers are held by the digest and not by any literal. The
        // list is read from the module rather than restated, because a restated
        // copy is a second registry that drifts.
        toList: () => {
            const { SHARED_GATES } = require(path.join(REPO_ROOT, 'src/consensus_rules_digest.js'));
            return SHARED_GATES.map(([mod]) => `src/${mod}.js`);
        },
        why: 'the consensus-rules digest requires every SHARED_GATES module by computed path',
    },
    {
        from: 'src/cross_chain/bridge_engine.js',
        // loadActivation(name, predicate) requires src/<name>.js from the engine's
        // feature directory inside a try/catch that returns null, and the
        // constructor calls it for three gates. Read out
        // of the call sites rather than restated, so a fourth gate added tomorrow
        // is an edge this tool already knows about. A missed move here is the
        // quietest failure in the repo: the engine idles and nothing throws.
        toList: () => {
            const src = fs.readFileSync(path.join(REPO_ROOT, 'src/cross_chain/bridge_engine.js'), 'utf8');
            const rows = Array.from(src.matchAll(/loadActivation\(\s*'([^']+)'/g))
                .map((m) => `src/${m[1]}.js`);
            if (!rows.length) {
                throw new Error('src/cross_chain/bridge_engine.js declares no loadActivation call: the bridge edge is stale');
            }
            return rows;
        },
        why: 'the cross-chain bridge engine requires each of its three activation gates by computed path',
    },
    {
        from: 'src/ProviderRegistry.js',
        // getModule requires './providers/<id>.js' where the id comes from a
        // database row, so no literal in the repo names a provider module and both
        // of them read unreachable without this edge. A failed load returns null
        // and the provider is simply unavailable, which is the same silent shape
        // the two gates above have.
        toList: () => {
            const dir = path.join(REPO_ROOT, 'src/providers');
            if (!fs.existsSync(dir)) return [];
            return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => `src/providers/${f}`);
        },
        why: 'the provider registry requires every src/providers module by an id read from the database',
    },
    {
        from: 'src/db/index.js',
        // The db home installs one mixin per table family onto Database.prototype, and
        // the edge is derived from what that index really does rather than from a name
        // list this file carries (see dbHomeMixins). Declared even though today's index
        // names every mixin in a literal require, which the ordinary walk already
        // follows: the install list is the kind of thing that becomes computed, and the
        // day it does, eighteen live files would otherwise start reading dead.
        toList: () => dbHomeMixins(),
        why: 'the db home installs the mixin files beside its index onto Database.prototype',
    },
];

const SOURCE_EXT = ['.js'];

/** Tracked files only: an untracked scratch copy under src/ is not the tree. */
function trackedFiles() {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
    return out.toString('utf8').split('\0').filter(Boolean);
}

/** Node's own resolution for a relative require, restricted to this repo. */
function resolveRequire(fromRel, spec) {
    if (!spec.startsWith('.')) return null;
    const base = path.posix.join(path.posix.dirname(fromRel), spec);
    const candidates = [base];
    for (const ext of SOURCE_EXT) candidates.push(base + ext);
    for (const ext of SOURCE_EXT) candidates.push(path.posix.join(base, `index${ext}`));
    for (const c of candidates) {
        const abs = path.join(REPO_ROOT, c);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile() && c.endsWith('.js')) return c;
    }
    return null;
}

const REQUIRE_LITERAL = /require\(\s*(['"])([^'"]+)\1\s*\)/g;

// The db home: an index that installs one mixin per table family onto
// Database.prototype, with the mixin files beside it.
const DB_HOME = 'src/db';

// A require whose argument is not a string literal, which is what an install loop
// looks like from the outside: require(file), require(path.join(__dirname, file)).
const REQUIRE_COMPUTED = /require\(\s*[^'")\s]/;

// A read of the home's own directory, the other half of that same shape.
const HOME_READDIR = /readdir(?:Sync)?\(\s*__dirname/;

/**
 * The mixin files the db home installs, derived from what the home does rather than
 * from a list of names kept here.
 *
 * TWO SHAPES, BOTH REAL. The index may name each mixin in a literal require, which
 * the ordinary require walk follows on its own, or build the list at runtime from
 * its own directory, which no static walk can see. The literals are read first; a
 * computed require or a read of __dirname then adds every other .js in the home,
 * because under that shape no literal names a single mixin.
 *
 * IT NEVER THROWS. The first cut of this edge insisted on a MIXIN_FILES literal and
 * died when the split landed with a different one, stopping the whole sweep instead
 * of measuring the tree. An unfamiliar home, or one with no mixins at all, is zero
 * edges: a file the home does not load is a candidate, which is the verdict this
 * tool exists to produce.
 *
 * @returns {string[]} repo-relative mixin paths, sorted, possibly empty
 */
function dbHomeMixins() {
    const indexRel = `${DB_HOME}/index.js`;
    let text;
    try { text = fs.readFileSync(path.join(REPO_ROOT, indexRel), 'utf8'); } catch (e) { return []; }

    const out = new Set();
    // A fresh matcher rather than REQUIRE_LITERAL itself: the shared one carries a
    // lastIndex, and two walks sharing it would each start where the other stopped.
    const literals = new RegExp(REQUIRE_LITERAL.source, 'g');
    let m;
    while ((m = literals.exec(text)) !== null) {
        const target = resolveRequire(indexRel, m[2]);
        if (target && target !== indexRel && target.startsWith(`${DB_HOME}/`)) out.add(target);
    }

    if (REQUIRE_COMPUTED.test(text) || HOME_READDIR.test(text)) {
        let entries = [];
        try { entries = fs.readdirSync(path.join(REPO_ROOT, DB_HOME)); } catch (e) { entries = []; }
        for (const name of entries) {
            const rel = `${DB_HOME}/${name}`;
            if (name.endsWith('.js') && rel !== indexRel) out.add(rel);
        }
    }
    return Array.from(out).sort();
}

/** Every repo-local file `rel` requires by a literal path, plus its declared dynamic edges. */
function edgesFrom(rel, fileSet) {
    const abs = path.join(REPO_ROOT, rel);
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

    const dockerfile = path.join(REPO_ROOT, 'Dockerfile');
    if (fs.existsSync(dockerfile)) {
        for (const line of fs.readFileSync(dockerfile, 'utf8').split('\n')) {
            if (!/^\s*(CMD|ENTRYPOINT)\b/.test(line)) continue;
            for (const m of line.matchAll(/["']([^"']+\.js)["']/g)) {
                const rel = m[1].replace(/^\.\//, '');
                if (fileSet.has(rel)) entries.add(rel);
            }
        }
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
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

/**
 * Sibling repos carrying a file at the SAME repo-relative path. A vendored twin
 * is a reference no text sweep can see: the sibling requires its own copy, and
 * the two are kept equal by a sync script, so deleting or moving the original
 * silently orphans a live file in another service. `byteIdentical` separates a
 * maintained twin from two files that merely share a name.
 */
function twinCopies(sources, siblingsRoot) {
    const out = {};
    let repos = [];
    try {
        repos = fs.readdirSync(siblingsRoot, { withFileTypes: true })
            .filter((e) => e.name.startsWith('xchain-') && e.name !== 'xchain-hub')
            .map((e) => e.name)
            .sort();
    } catch (e) {
        return out;
    }
    for (const rel of sources) {
        const mine = path.join(REPO_ROOT, rel);
        let mineText = null;
        try { mineText = fs.readFileSync(mine, 'utf8'); } catch (e) { mineText = null; }
        const found = [];
        for (const repo of repos) {
            const other = path.join(siblingsRoot, repo, rel);
            let otherText;
            try { otherText = fs.readFileSync(other, 'utf8'); } catch (e) { continue; }
            found.push({ path: `${repo}/${rel}`, byteIdentical: mineText !== null && otherText === mineText });
        }
        if (found.length) out[rel] = found;
    }
    return out;
}

/** Every .js directly under a directory tree, as entry points in their own right. */
function entriesUnder(prefixes, fileSet) {
    return Array.from(fileSet).filter((f) => prefixes.some((p) => f.startsWith(p)) && f.endsWith('.js')).sort();
}

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

    let siblings = { paths: {}, siblingRepos: [], distinctPathCount: 0 };
    let twins = {};
    if (opts.siblings !== false) {
        siblings = buildReferenceMap(opts.siblingsRoot, {
            includePlatformTooling: true,
            extraDirs: toolingSweepDirs(opts.siblingsRoot),
            repoRoot: REPO_ROOT,
        });
        twins = twinCopies(sources, opts.siblingsRoot);
    }

    const back = reverseEdges(fileSet);

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
    if (!opts.siblingsRoot) opts.siblingsRoot = path.resolve(REPO_ROOT, '..');
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
    repoRoot: () => REPO_ROOT,
    DYNAMIC_EDGES,
};
