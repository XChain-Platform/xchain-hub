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
 * Node's own resolution for the literal requires the walk follows, over the
 * files git tracks.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { getRepoRoot } = require('./root.js');

const SOURCE_EXT = ['.js'];

/** Tracked files only: an untracked scratch copy under src/ is not the tree. */
function trackedFiles() {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: getRepoRoot(), maxBuffer: 64 * 1024 * 1024 });
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
        const abs = path.join(getRepoRoot(), c);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile() && c.endsWith('.js')) return c;
    }
    return null;
}

const REQUIRE_LITERAL = /require\(\s*(['"])([^'"]+)\1\s*\)/g;

module.exports = { SOURCE_EXT, REQUIRE_LITERAL, trackedFiles, resolveRequire };
