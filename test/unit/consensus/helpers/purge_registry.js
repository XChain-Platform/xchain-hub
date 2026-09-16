/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The activation registry's own require.cache footprint, for a suite that
 * arms a gate from the environment and re-requires the one activation module
 * it is testing.
 *
 * The registry arms its five venue-armed regtest entries ONCE, at
 * registration, from the environment the entry hands registerRows(). A
 * carrier re-required on its own reads the cached registry and the arming
 * it was booted with, so every module below has to be dropped from
 * require.cache together: the entry, the core that holds the one registry,
 * the queue, the arming grammar and the five part files that queue the rows
 * as they load. The next require of the carrier then rebuilds the whole chain
 * from the current environment, the way the indexer's suites do it.
 *
 * A twin suite that re-arms the INDEXER's copy of a carrier through the
 * sibling checkout has the same problem one directory over, so
 * registryPathsOf() reads either layout: this repo's entry plus
 * src/consensus/gate_registry/, or the indexer's src/protocol_changes.js, its
 * D72 alias and src/protocol_changes/. Whatever is absent contributes nothing,
 * so an unconverted sibling purges as before.
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function jsFilesUnder(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => path.join(dir, f));
}

/**
 * Every registry module of the checkout at `root`, resolved, in either layout.
 * @param {string} root a hub or indexer checkout
 * @returns {string[]} absolute paths, the ones require.cache keys on
 */
function registryPathsOf(root) {
    const src = path.join(root, 'src');
    const candidates = [
        path.join(src, 'consensus', 'gate_registry.js'),
        path.join(src, 'protocol_changes.js'),
    ].filter((p) => fs.existsSync(p))
        .concat(jsFilesUnder(path.join(src, 'consensus', 'gate_registry')))
        .concat(jsFilesUnder(path.join(src, 'protocol_changes')));
    return candidates.map((p) => require.resolve(p));
}

// This repo's entry and every file under gate_registry/: the complete set a
// fresh read of the registry has to come from.
const REGISTRY_PATHS = registryPathsOf(REPO_ROOT);

/**
 * Deletes every registry module from require.cache.
 * @returns {function(): void} restore(), which puts back exactly what was cached before.
 */
function purgeRegistry() {
    const saved = REGISTRY_PATHS.map((p) => [p, require.cache[p]]);
    for (const p of REGISTRY_PATHS) delete require.cache[p];
    return function restore() {
        for (const [p, mod] of saved) {
            if (mod === undefined) delete require.cache[p];
            else require.cache[p] = mod;
        }
    };
}

module.exports = { REGISTRY_PATHS, registryPathsOf, purgeRegistry };
