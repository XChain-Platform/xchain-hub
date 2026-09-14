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
 * The sibling half of the verdict: which tooling directories of the surrounding
 * tree are swept, and which siblings carry a same-path twin of a hub file.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const { platformToolingDirs } = require('../sibling_reference_map/walk.js');
const { getRepoRoot } = require('./root.js');

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
        const mine = path.join(getRepoRoot(), rel);
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

module.exports = { toolingSweepDirs, twinCopies };
