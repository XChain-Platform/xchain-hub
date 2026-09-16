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
 * Every hub `src/` path that a sibling repo names, and who names it.
 *
 * WHY THIS EXISTS. Moving or renaming a file under src/ is a cross-repo edit
 * whenever another service reaches into this checkout for it, and several do:
 * sibling suites require hub modules by relative path, build DDL paths by
 * hand, and quote module paths inside assertions. A grep run by hand finds the
 * requires and misses the string literals, so the restructure needs ONE
 * mechanical sweep whose output can be diffed before and after a move. A path
 * that leaves this map without a matching edit in the referring repo is a
 * broken sibling, and that break surfaces at the referrer's next CI run rather
 * than at the commit that caused it.
 *
 * WHAT COUNTS AS A REFERENCE. Six shapes, reported as each site's `form`,
 * because a rename tool has to find every one of them:
 *
 *   text       any literal run of `xchain-hub/src/<path>` in any text file:
 *              a relative require, a comment, a shell script, a markdown runbook.
 *   join       a path built segment by segment, the shape
 *              path.join(root, 'xchain-hub', 'src', 'foo.js'). When every
 *              segment after `src` is a literal the path is resolved; when one is
 *              a variable the site is reported under `dynamicReferences` instead,
 *              because a rename must be checked there by a human.
 *   root-var   the checkout held in a variable and the file joined onto it:
 *              `const R = path.resolve(__dirname, '../../xchain-hub')` then
 *              path.join(R, 'src', 'foo.js'), path.join(R, 'src/foo.js') or
 *              `${R}/src/foo.js`. The root may equally be
 *              process.env.XCHAIN_HUB_PATH, a candidate array filtered to its
 *              first live entry, or a variable that points at `<root>/src`.
 *   helper     a closure that takes a repo-relative path and returns a file in
 *              this checkout, `hubFile('src/db.js')`. A call over a
 *              literal array, `hubFile('src/' + twin)`, is emitted once per
 *              element of that array.
 *   shell-var  the same root-in-a-variable idea in bash, `"$VAR/src/foo.js"`.
 *   shell-arg  the repo name passed as its own word with the path beside it,
 *              `copy_twin xchain-hub "src/$f"`, resolved against the literal
 *              `for f in ...` list above it. The twin-copier script in the
 *              platform's tooling directories, reconcile-twins.sh, is built
 *              entirely out of this one and is wired into no CI.
 *
 * AND TWO THAT ARE NEVER A PATH. src/consensus_rules_digest.js loads its shared
 * gate carriers with `require('./' + mod + '.js')` over a literal list, so no
 * string names the file and a missed move reports the gate ABSENT instead of
 * throwing; src/cross_chain/bridge_engine.js loads its three bridge gates the same
 * way inside a try/catch that returns null, so a missed move idles the bridge
 * with nothing thrown and nothing logged. Those sites are listed under
 * `dynamicReferences` with the file list they resolve to, form
 * `computed-require`.
 *
 * SCOPE. Sibling repos are the `xchain-*` directories beside this checkout
 * (`--siblings <dir>` overrides the search root), listed in `siblingRepos`. That
 * default scope is everything this repo publishes and everything a pin carries.
 *
 * WHICH CHECKOUT IS MEASURED. `--root <dir>` names the hub checkout whose src/
 * paths are resolved and whose computed requires are read; with no flag it is
 * the repo this script lives in. A restructure runs several lanes at once, each
 * in its own worktree, and one lane has to be able to drive another lane's tool
 * against its OWN tree without copying the tool first.
 *
 * The surrounding tree may also hold platform tooling that is not a shipped
 * service and still reaches in just as hard: the twin-copier script
 * reconcile-twins.sh alone byte-copies about thirty of this repo's src/ files
 * outward and no CI job runs it, so a sweep that ignores those directories reads
 * safer than the tree is. Sweeping them is OPT-IN, because their paths belong to
 * the tree around this checkout rather than to this repo: pass
 * --include-platform-tooling and name the directories, relative to the siblings
 * root and comma-separated, in SIBLING_MAP_EXTRA_DIRS. Their hits land under the
 * referrer label `platform-tooling` and the directories swept are echoed in
 * `platformToolingSwept`, so a map that used them says so. With the flag off,
 * `platformToolingSwept` is empty and only the `xchain-*` siblings are swept.
 *
 * USAGE
 *   node bin/sibling-reference-map.js            human summary
 *   node bin/sibling-reference-map.js --json     the full map on stdout
 *   node bin/sibling-reference-map.js --root /path/to/a/hub/checkout
 *   node bin/sibling-reference-map.js --siblings /path/to/platform
 *   node bin/sibling-reference-map.js --pin bin/pins/at1-sibling-reference-map.json \
 *        --base-sha <sha> --note "<what tree this saw>"
 *   node bin/sibling-reference-map.js --census bin/pins/at1-siblings.json
 *                                              the per-repo count a wave is
 *                                              scheduled from: executable sites
 *                                              against mentions, and which repos
 *                                              gate a push
 *   SIBLING_MAP_EXTRA_DIRS=<dir>,<dir> node bin/sibling-reference-map.js \
 *        --include-platform-tooling --json
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const { REPO_NAME, getRepoRoot, setRepoRoot, resolveInRepo } = require('./lib/sibling_reference_map/repo_root.js');
const {
    PLATFORM_TOOLING_LABEL, PLATFORM_TOOLING_ENV, platformToolingDirs, siblingRepos,
} = require('./lib/sibling_reference_map/walk.js');
const { literalJoinTail, trimPath, arrayLiteralItems } = require('./lib/sibling_reference_map/source_text.js');
const { collectLoopLists, collectStringConsts } = require('./lib/sibling_reference_map/loops.js');
const { rootPrefix, collectRootVars, rootVarReferences, collectHelpers } = require('./lib/sibling_reference_map/roots.js');
const {
    helperReferences, shellReferences, computedRequireSites, scanIndirectIdioms, isShellFile,
} = require('./lib/sibling_reference_map/idioms.js');
const { buildReferenceMap } = require('./lib/sibling_reference_map/scan.js');
const { referenceCensus, writeCensus, writePin, printSummary } = require('./lib/sibling_reference_map/report.js');

function parseArgs(argv) {
    const opts = { json: false, siblings: null, includePlatformTooling: false };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--json') opts.json = true;
        else if (argv[i] === '--root') { opts.root = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--include-platform-tooling') opts.includePlatformTooling = true;
        else if (argv[i] === '--siblings') { opts.siblings = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--pin') { opts.pin = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--census') { opts.census = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--base-sha') { opts.baseSha = argv[i + 1]; i += 1; }
        else if (argv[i] === '--note') { opts.note = argv[i + 1]; i += 1; }
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
    // --root first, because the default siblings root is the directory the
    // measured checkout sits in and not the one this script sits in.
    if (opts.root) setRepoRoot(opts.root);
    if (!opts.siblings) opts.siblings = path.resolve(getRepoRoot(), '..');
    if (opts.includePlatformTooling && !platformToolingDirs().length) {
        console.error(`--include-platform-tooling with no ${PLATFORM_TOOLING_ENV}: `
            + 'name the directories to sweep, relative to the siblings root and comma-separated.');
        process.exitCode = 2;
        return;
    }
    const map = buildReferenceMap(opts.siblings, { includePlatformTooling: opts.includePlatformTooling });
    if (opts.census) {
        writeCensus(map, opts);
        return;
    }
    if (opts.pin) {
        writePin(map, opts);
        return;
    }
    if (opts.json) {
        console.log(JSON.stringify(map, null, 2));
        return;
    }
    printSummary(map);
}

if (require.main === module) main();

module.exports = {
    buildReferenceMap,
    referenceCensus,
    setRepoRoot,
    // The measured checkout, as a call rather than a binding: a consumer that
    // captured the value at require time would keep reading the default after
    // --root moved it.
    repoRoot: getRepoRoot,
    REPO_NAME,
    siblingRepos,
    platformToolingDirs,
    PLATFORM_TOOLING_LABEL,
    PLATFORM_TOOLING_ENV,
    resolveInRepo,
    literalJoinTail,
    trimPath,
    // The indirect matchers, exported so a fixture string drives exactly what
    // the sweep drives rather than a re-implementation of it.
    rootPrefix,
    collectRootVars,
    rootVarReferences,
    collectHelpers,
    helperReferences,
    collectLoopLists,
    collectStringConsts,
    arrayLiteralItems,
    shellReferences,
    computedRequireSites,
    scanIndirectIdioms,
    isShellFile,
};
