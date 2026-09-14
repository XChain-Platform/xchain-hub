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
 * Requires the hub builds at runtime, each declared with the site that builds it
 * so the static walk can follow it.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const { getRepoRoot } = require('./root.js');
const { REQUIRE_LITERAL, resolveRequire } = require('./resolve.js');

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
            const { SHARED_GATES } = require(path.join(getRepoRoot(), 'src/consensus_rules_digest.js'));
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
            const src = fs.readFileSync(path.join(getRepoRoot(), 'src/cross_chain/bridge_engine.js'), 'utf8');
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
        from: 'src/validators/provider_registry.js',
        // getModule requires src/providers/<id>.js from the registry's feature
        // directory, where the id comes from a database row, so no literal in
        // the repo names a provider module and both
        // of them read unreachable without this edge. A failed load returns null
        // and the provider is simply unavailable, which is the same silent shape
        // the two gates above have.
        toList: () => {
            const dir = path.join(getRepoRoot(), 'src/providers');
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
    try { text = fs.readFileSync(path.join(getRepoRoot(), indexRel), 'utf8'); } catch (e) { return []; }

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
        try { entries = fs.readdirSync(path.join(getRepoRoot(), DB_HOME)); } catch (e) { entries = []; }
        for (const name of entries) {
            const rel = `${DB_HOME}/${name}`;
            if (name.endsWith('.js') && rel !== indexRel) out.add(rel);
        }
    }
    return Array.from(out).sort();
}

module.exports = { DYNAMIC_EDGES, dbHomeMixins };
