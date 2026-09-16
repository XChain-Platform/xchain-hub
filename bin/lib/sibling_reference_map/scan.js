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
 * The map itself: every sibling file swept, each site recorded once under the path
 * it resolves to, and the totals a pin or a census is read from.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const { REPO_NAME, getRepoRoot, setRepoRoot, resolveInRepo } = require('./repo_root.js');
const { MAX_FILE_BYTES, PLATFORM_TOOLING_LABEL, platformToolingDirs, walkFiles, siblingRepos } = require('./walk.js');
const { trimPath, literalJoinTail, lineAt, lineTextAt, referenceKind } = require('./source_text.js');
const { computedRequireSites, scanIndirectIdioms, isShellFile } = require('./idioms.js');

// `xchain-hub/src/<path>`, however it was spelled: a relative require
// (`../../xchain-hub/src/coins/index.js`), a prose mention, a shell path.
const TEXT_REFERENCE = /xchain-hub\/(src\/[A-Za-z0-9_@.\-/]+)/g;

// path.join(..., 'xchain-hub', 'src', ...): the tail is captured raw and
// parsed for literal segments afterwards.
const JOIN_REFERENCE = /['"`]xchain-hub['"`]\s*,\s*['"`]src['"`]\s*,([^)\]]*)/g;

/**
 * The map itself. `opts.includePlatformTooling` adds the opt-in sweep of the
 * directories SIBLING_MAP_EXTRA_DIRS names (see SCOPE in the header); with it off
 * the map covers the `xchain-*` siblings and this repo's own computed requires.
 *
 * @param {string} root the directory the sibling checkouts sit in
 * @param {{includePlatformTooling?: boolean, extraDirs?: string[], repoRoot?: string}} [opts]
 * @returns {{siblingRepos: string[], paths: object, dynamicReferences: object[],
 *            distinctPathCount: number, referenceCount: number}}
 */
function buildReferenceMap(root, opts = {}) {
    if (opts.repoRoot) setRepoRoot(opts.repoRoot);
    const repos = siblingRepos(root);
    const sweep = createSweep();

    for (const repo of repos) {
        const repoRoot = path.join(root, repo);
        for (const file of walkFiles(repoRoot, [])) scanFile(sweep, file, repo, repoRoot);
    }

    // The platform's own tooling: not a shipped service, but it reaches into this
    // repo just as hard, since the twin-copier script alone byte-copies about thirty
    // src/ files outward through the bash idioms above and no CI job runs it. OPT-IN
    // (see SCOPE in the header), because the directories live in the tree around this
    // checkout: the caller that wants them names them, and the default map is the
    // `xchain-*` siblings only. Swept under one label so `siblingRepos` still means
    // exactly the sibling checkouts a downstream reader already knows.
    const toolingSwept = [];
    const extraDirs = opts.includePlatformTooling
        ? (opts.extraDirs || platformToolingDirs())
        : [];
    for (const dir of extraDirs) {
        const abs = path.join(root, dir);
        if (!fs.existsSync(abs)) continue;
        toolingSwept.push(dir);
        for (const file of walkFiles(abs, [])) scanFile(sweep, file, PLATFORM_TOOLING_LABEL, root);
    }

    // This repo's own computed requires. They name no sibling, but they are the
    // other half of what a move has to be checked against, and nothing else in
    // the toolchain reports them.
    recordOwnComputedRequires(sweep.dynamic);

    return summarizeMap(repos, toolingSwept, sweep.paths, sweep.dynamic);
}

/**
 * What one build fills: every path with its referrers, the dynamic sites, and the
 * `record` that keeps one site seen by two matchers from counting twice.
 */
function createSweep() {
    const paths = new Map();
    const dynamic = [];

    // One site can be spelled so that two matchers see it (a comment beside a
    // join that quotes the same path). The literal matchers run first and own
    // the site; an indirect matcher that lands on the same file, line and path
    // is the same reference seen twice, not a second one.
    const seen = new Set();

    const record = (rel, ref) => {
        const key = resolveInRepo(rel) || rel;
        const fingerprint = `${ref.file}|${ref.line}|${key}`;
        if (ref.form !== 'text' && ref.form !== 'join' && seen.has(fingerprint)) return;
        seen.add(fingerprint);
        if (!paths.has(key)) paths.set(key, { exists: resolveInRepo(rel) !== null, referrers: [] });
        paths.get(key).referrers.push(ref);
    };
    return { paths, dynamic, record };
}

/** One file of one sibling, through every matcher. */
function scanFile(sweep, file, repo, scanRoot) {
    let stat;
    try { stat = fs.statSync(file); } catch (e) { return; }
    if (stat.size > MAX_FILE_BYTES) return;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    // The env-variable form never spells the repo name, so the cheap
    // pre-filter has to admit it too or the whole idiom stays invisible.
    if (!text.includes(REPO_NAME) && !text.includes('XCHAIN_HUB')) return;
    const rel = `${repo}/${path.relative(scanRoot, file)}`;

    recordTextReferences(sweep, text, repo, rel);
    recordJoinReferences(sweep, text, repo, rel);
    recordIndirectReferences(sweep, file, text, repo, rel);
}

/** The literal `xchain-hub/src/<path>` runs. */
function recordTextReferences(sweep, text, repo, rel) {
    TEXT_REFERENCE.lastIndex = 0;
    let m;
    while ((m = TEXT_REFERENCE.exec(text)) !== null) {
        const captured = trimPath(m[1]);
        if (captured === 'src' || captured === 'src/') continue;
        sweep.record(captured, {
            repo,
            file: rel,
            line: lineAt(text, m.index),
            kind: referenceKind(lineTextAt(text, m.index)),
            form: 'text',
            raw: captured,
        });
    }
}

/** The path.join(..., 'xchain-hub', 'src', ...) sites, resolved or handed to a human. */
function recordJoinReferences(sweep, text, repo, rel) {
    JOIN_REFERENCE.lastIndex = 0;
    let m;
    while ((m = JOIN_REFERENCE.exec(text)) !== null) {
        const tail = literalJoinTail(m[1]);
        const line = lineAt(text, m.index);
        if (tail === null) {
            sweep.dynamic.push({ repo, file: rel, line, form: 'join', expression: m[1].trim().slice(0, 120) });
            continue;
        }
        sweep.record(`src/${tail}`, { repo, file: rel, line, kind: 'join', form: 'join', raw: `src/${tail}` });
    }
}

/** The root-variable, helper and bash idioms. */
function recordIndirectReferences(sweep, file, text, repo, rel) {
    const indirect = scanIndirectIdioms(text, { shell: isShellFile(file, text) });
    for (const hit of indirect.found) {
        sweep.record(hit.path, {
            repo,
            file: rel,
            line: lineAt(text, hit.index),
            kind: referenceKind(lineTextAt(text, hit.index)),
            form: hit.form,
            raw: hit.path,
            via: hit.root || hit.helper || hit.loopVar,
        });
    }
    for (const hit of indirect.dynamic) {
        sweep.dynamic.push({
            repo,
            file: rel,
            line: lineAt(text, hit.index),
            form: hit.form,
            expression: hit.expression,
            via: hit.root || hit.helper,
        });
    }
}

/** This repo's own computed requires, appended to the dynamic sites. */
function recordOwnComputedRequires(dynamic) {
    const repoRoot = getRepoRoot();
    for (const file of walkFiles(path.join(repoRoot, 'src'), [])) {
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
        const relFile = path.relative(repoRoot, file);
        for (const hit of computedRequireSites(text, path.posix.dirname(relFile))) {
            dynamic.push({
                repo: REPO_NAME,
                file: `${REPO_NAME}/${relFile}`,
                line: lineAt(text, hit.index),
                form: hit.form,
                expression: hit.expression,
                via: hit.listVariable,
                listCandidates: hit.listCandidates,
            });
        }
    }
}

/** The sorted map and its totals, in the shape buildReferenceMap returns. */
function summarizeMap(repos, toolingSwept, paths, dynamic) {
    const sortedPaths = {};
    let referenceCount = 0;
    const byKind = { require: 0, join: 0, text: 0 };
    // Which matcher found a site, kept beside the load/mention split rather than
    // folded into it: the two answer different questions, and a downstream reader
    // that only knows about `kind` must keep reading the same numbers it did.
    const byForm = { text: 0, join: 0, 'root-var': 0, helper: 0, 'shell-var': 0, 'shell-arg': 0 };
    for (const key of Array.from(paths.keys()).sort()) {
        const entry = paths.get(key);
        entry.referrers.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
        referenceCount += entry.referrers.length;
        for (const ref of entry.referrers) {
            byKind[ref.kind] += 1;
            byForm[ref.form] = (byForm[ref.form] || 0) + 1;
        }
        sortedPaths[key] = {
            exists: entry.exists,
            referenceCount: entry.referrers.length,
            referringRepos: Array.from(new Set(entry.referrers.map((r) => r.repo))).sort(),
            referrers: entry.referrers,
        };
    }
    dynamic.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

    return {
        siblingRepos: repos,
        platformToolingSwept: toolingSwept,
        distinctPathCount: Object.keys(sortedPaths).length,
        // The subset that resolves to a file in the tree. The rest are
        // directory prefixes (`src/sql/`) and stale paths, which still matter
        // on a move but are not files anyone can repoint one-for-one.
        existingPathCount: Object.values(sortedPaths).filter((p) => p.exists).length,
        referenceCount,
        referenceCountByKind: byKind,
        referenceCountByForm: byForm,
        dynamicReferenceCount: dynamic.length,
        dynamicReferenceCountByForm: dynamic.reduce((acc, d) => {
            acc[d.form || 'join'] = (acc[d.form || 'join'] || 0) + 1;
            return acc;
        }, {}),
        paths: sortedPaths,
        dynamicReferences: dynamic,
    };
}

module.exports = { buildReferenceMap };
