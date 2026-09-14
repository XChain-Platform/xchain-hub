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
 * The checkout the reachability walk measures. One binding shared by every part
 * of the walk, moved together with the sibling map's so both read one tree.
 *
 ********************************************************************/

'use strict';

const path = require('path');

const { setRepoRoot: setMapRepoRoot } = require('../sibling_reference_map/repo_root.js');

// The checkout under measurement, a binding rather than a constant so `--root`
// can aim the whole walk at another hub worktree. See WHICH CHECKOUT IS MEASURED.
let REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

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

/** The checkout under measurement, read at call time so a later --root is seen. */
function getRepoRoot() { return REPO_ROOT; }

module.exports = { getRepoRoot, setRepoRoot };
