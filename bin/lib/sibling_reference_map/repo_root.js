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
 * The checkout the sibling reference map measures, and path resolution inside it.
 * One module holds the binding so every part of the tool reads the same --root.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

// The checkout under measurement. It is a binding rather than a constant so
// `--root` can aim the whole tool at ANOTHER hub checkout: several lanes of a
// restructure run at once in separate worktrees, and each has to be able to
// drive this tool against its own tree without first copying it there.
let REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// The repo's name as every referring file spells it, which is what the matchers
// below look for. It is fixed even when --root points somewhere else: a sibling
// names the hub by this name whatever a worktree's directory happens to be
// called.
const REPO_NAME = 'xchain-hub';

/**
 * Measure `dir` instead of the checkout this script lives in.
 * @param {string} dir a hub checkout
 * @returns {string} the resolved root
 */
function setRepoRoot(dir) { REPO_ROOT = path.resolve(dir); return REPO_ROOT; }

/** The checkout under measurement, read at call time so a later --root is seen. */
function getRepoRoot() { return REPO_ROOT; }

/**
 * The path as it exists in the tree, or null when nothing resolves. A require
 * may omit the extension (`require('.../hub_db_sync')`) and may name a
 * directory, so both are tried before the reference is called unresolvable.
 */
function resolveInRepo(rel) {
    const candidates = [rel, `${rel}.js`, path.posix.join(rel, 'index.js')];
    for (const c of candidates) {
        const abs = path.join(REPO_ROOT, c);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return c;
    }
    return null;
}

module.exports = { REPO_NAME, getRepoRoot, setRepoRoot, resolveInRepo };
