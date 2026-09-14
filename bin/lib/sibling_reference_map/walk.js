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
 * Which files the sweep reads: the sibling checkouts, the opt-in tooling
 * directories, and a walk that skips scratch trees and nested clones.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const { REPO_NAME, getRepoRoot } = require('./repo_root.js');

// Directories that hold no first-party source and would otherwise dominate the
// sweep: an installed dependency tree can carry a vendored copy of this repo.
//
// `tmp` is skipped for a sharper reason than noise, and skipping it is what makes
// the per-repo counts mean anything. A sibling's tmp/ holds WORKING COPIES of
// other checkouts: measured 2026-09-13, xchain-node/tmp carried full clones of
// six sibling repos, and sweeping them attributed 92 of another repo's references
// to xchain-node. Lane worktrees are the same shape. Counting those is not a
// conservative over-count, it is a wrong answer: a move is checked against the
// repo that has to be repointed, and nobody repoints a scratch copy.
const SKIP_DIRS = new Set([
    'node_modules', '.git', '.nyc_output', 'coverage', 'dist', 'build', '.cache', '.venv', 'tmp',
]);

// Binary payloads a text scan would only produce noise from. Everything else is
// read as utf8, because a reference can live in a shell script, a Dockerfile, a
// YAML workflow or a markdown runbook just as easily as in a .js file.
const SKIP_EXT = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.pdf', '.zip', '.gz', '.tgz',
    '.bz2', '.xz', '.wasm', '.node', '.so', '.dylib', '.dll', '.woff', '.woff2', '.ttf',
    '.eot', '.mp4', '.mov', '.class', '.jar',
]);

// A file larger than this is a data dump, not code that requires a module.
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// Platform tooling that hardcodes hub paths without being a shipped service.
// It is swept under one label rather than added to the sibling list, so the
// `siblingRepos` array means exactly the `xchain-*` set and nothing else. The
// directories are named by the caller, not by this file: they are paths in the
// tree AROUND this checkout, and a repo carries no inventory of its surroundings.
const PLATFORM_TOOLING_LABEL = 'platform-tooling';
const PLATFORM_TOOLING_ENV  = 'SIBLING_MAP_EXTRA_DIRS';

/**
 * The tooling directories to sweep, relative to the siblings root, from
 * SIBLING_MAP_EXTRA_DIRS (comma-separated). Empty when the caller named none,
 * which is what turns the opt-in sweep into a no-op rather than a guess.
 *
 * @returns {string[]}
 */
function platformToolingDirs(env = process.env) {
    return String(env[PLATFORM_TOOLING_ENV] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Is this directory a git checkout in its own right? A sibling repo may carry
 * whole clones of other repos inside it (xchain-node/modules holds thirteen of
 * them, gitignored, and xchain-node/tmp holds six more), and every hub path
 * inside one of those is a reference belonging to the cloned repo, not to the
 * repo that happens to hold the clone. Measured 2026-09-13: sweeping them read
 * 312 reference sites for xchain-node against 31 that its own tracked files
 * carry. Counting them is not conservative, it is wrong: a move is checked
 * against the repos that must be repointed, and nobody repoints a scratch clone.
 *
 * @param {string} dir
 * @returns {boolean}
 */
function isNestedCheckout(dir) {
    try { return fs.existsSync(path.join(dir, '.git')); } catch (e) { return false; }
}

function walkFiles(dir, out) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return out;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        // A symlinked directory inside a repo points at another checkout that
        // this sweep visits under its own name (xchain-e2e-test/xchain-hub is
        // ../xchain-hub), so following it would count every hit twice. The
        // sibling roots themselves may still be symlinks: readdir resolves
        // those, and this walk starts below them.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            if (isNestedCheckout(full)) continue;
            walkFiles(full, out);
            continue;
        }
        if (!entry.isFile()) continue;
        if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
        out.push(full);
    }
    return out;
}

/**
 * The sibling repos to sweep: `xchain-*` directories beside this checkout,
 * minus this checkout itself, sorted so the output is stable.
 */
function siblingRepos(root) {
    const self = fs.realpathSync(getRepoRoot());
    const names = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.name.startsWith('xchain-')) continue;
        // By name as well as by real path: a lane worktree resolves somewhere
        // else entirely, so a sweep aimed at the platform root would otherwise
        // count the hub's own checkout as one of its siblings.
        if (entry.name === REPO_NAME) continue;
        const full = path.join(root, entry.name);
        let real;
        try { real = fs.realpathSync(full); } catch (e) { continue; }
        if (real === self) continue;
        if (!fs.statSync(full).isDirectory()) continue;
        names.push(entry.name);
    }
    return names.sort();
}

module.exports = {
    MAX_FILE_BYTES,
    PLATFORM_TOOLING_LABEL,
    PLATFORM_TOOLING_ENV,
    platformToolingDirs,
    isNestedCheckout,
    walkFiles,
    siblingRepos,
};
