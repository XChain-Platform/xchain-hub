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
 * Every indirect reference in one file's text: helper calls, the bash idioms, the
 * computed requires, and the one entry point the sweep and the fixtures share.
 *
 ********************************************************************/

'use strict';

const path = require('path');

const { trimPath, callArg } = require('./source_text.js');
const {
    underSrc, resolveJoinTail, relFromTail, collectLoopLists, nearestList, collectStringConsts,
} = require('./loops.js');
const { isPathAlias, rootPrefix, collectRootVars, rootVarReferences, collectHelpers } = require('./roots.js');

/**
 * Every call of a helper closure, resolved to the file or files it reads. A
 * `helper('src/' + twin)` over a literal array is emitted once per element,
 * because that is exactly the set a move has to repoint; a tail nothing names
 * goes to the dynamic channel instead.
 */
function helperReferences(text, helpers, lists, strings) {
    const found = [];
    const dynamic = [];
    const push = (index, rel, helper) => {
        const clean = trimPath(rel);
        if (underSrc(clean)) found.push({ index, path: clean, form: 'helper', helper });
    };
    for (const [name, suffix] of helpers) {
        const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
        let m;
        while ((m = re.exec(text)) !== null) {
            // `function hubFile(rel){` reads as a call of itself. Its
            // parameter is not a path, and counting it would put one phantom
            // "ask a human" line under every helper in the platform.
            if (/\bfunction\s+$/.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
            const arg = callArg(text, m.index + m[0].length - 1, 400);
            if (arg === null) continue;
            const expr = arg.trim();
            const literal = /^(['"`])([^'"`]*)\1$/.exec(expr);
            if (literal) { push(m.index, relFromTail(suffix, literal[2]), name); continue; }
            const prefixed = /^(['"`])([^'"`]*)\1\s*\+\s*([A-Za-z_$][\w$]*)$/.exec(expr);
            if (prefixed) {
                const items = nearestList(lists, prefixed[3], m.index);
                if (items) {
                    for (const item of items) push(m.index, relFromTail(suffix, prefixed[2] + item), name);
                } else {
                    dynamic.push({ index: m.index, form: 'helper', helper: name, expression: expr.slice(0, 120) });
                }
                continue;
            }
            const ident = /^[A-Za-z_$][\w$]*$/.exec(expr);
            if (ident) {
                // A loop variable first: the post-move twin loops pass the whole
                // hub-side path per row rather than deriving it from a
                // basename, so the literal list IS the reference set.
                const items = nearestList(lists, expr, m.index);
                if (items) {
                    for (const item of items) push(m.index, relFromTail(suffix, item), name);
                    continue;
                }
                const value = strings.get(expr);
                if (value) push(m.index, relFromTail(suffix, value), name);
                else dynamic.push({ index: m.index, form: 'helper', helper: name, expression: expr.slice(0, 120) });
                continue;
            }
            const joined = /^([A-Za-z_$][\w$]*)\s*\.\s*(?:join|resolve)\s*\(([\s\S]*)\)$/.exec(expr);
            if (joined && isPathAlias(joined[1])) {
                const tails = resolveJoinTail(joined[2], lists, m.index);
                if (tails !== null) {
                    for (const tail of tails) push(m.index, relFromTail(suffix, tail), name);
                    continue;
                }
            }
            dynamic.push({ index: m.index, form: 'helper', helper: name, expression: expr.slice(0, 120) });
        }
    }
    return { found, dynamic };
}

/**
 * The bash side of the same blind spot. Two shapes, both in the platform's
 * twin-copier script reconcile-twins.sh: a variable holding the checkout and then
 * "$VAR/src/<file>", and the repo name passed as its own word followed by the
 * relative path, `copy_twin xchain-hub "src/$f"`, where the file comes from
 * a literal `for f in ...` list. That script is wired into no CI at all, so a
 * move it does not follow fails silently at the next hand run.
 */
function shellReferences(text, lists) {
    const found = [];
    const dynamic = [];
    let m;
    const roots = new Map();
    const assign = /^[ \t]*(?:local\s+|export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(["']?)([^"'\n]*)\2/gm;
    while ((m = assign.exec(text)) !== null) {
        const prefix = rootPrefix(m[3]);
        if (prefix !== null && !roots.has(m[1])) roots.set(m[1], prefix);
    }
    for (const [name, suffix] of roots) {
        const use = new RegExp(`\\$\\{?${name}\\}?/([A-Za-z0-9_@.\\-/]+)`, 'g');
        while ((m = use.exec(text)) !== null) {
            const rel = trimPath(relFromTail(suffix, m[1]));
            if (underSrc(rel)) found.push({ index: m.index, path: rel, form: 'shell-var', root: name });
        }
    }
    const positional = /xchain-hub[ \t]+["']?(src\/[^"'\s;)]+)/g;
    while ((m = positional.exec(text)) !== null) {
        const raw = m[1];
        const interpolated = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(raw);
        if (!interpolated) {
            const rel = trimPath(raw);
            if (underSrc(rel)) found.push({ index: m.index, path: rel, form: 'shell-arg' });
            continue;
        }
        const items = nearestList(lists, interpolated[1], m.index);
        if (!items) {
            dynamic.push({ index: m.index, form: 'shell-arg', expression: raw.slice(0, 120) });
            continue;
        }
        for (const item of items) {
            const rel = trimPath(raw.replace(interpolated[0], item));
            if (underSrc(rel)) found.push({ index: m.index, path: rel, form: 'shell-arg', loopVar: interpolated[1] });
        }
    }
    return { found, dynamic };
}

/**
 * `require('./' + mod + '.js')` over a literal list, which is how
 * src/consensus_rules_digest.js loads its shared gate carriers and how
 * src/cross_chain/bridge_engine.js loads its three bridge gates. No string names the
 * loaded file, so neither matcher above nor a grep can see the edge, and BOTH
 * sites swallow the failure: the digest reports a gate it cannot load as ABSENT
 * instead of throwing, and the bridge engine's loadActivation returns null and
 * idles. A move that misses one of these is silent all the way to a rules
 * mismatch on the fleet, or to a bridge that has quietly stopped polling.
 */
function computedRequireSites(text, dirRel) {
    const lists = collectLoopLists(text);
    const out = [];
    const re = /require\s*\(\s*(['"`])(\.\.?\/[^'"`]*)\1\s*\+\s*([A-Za-z_$][\w$]*)\s*(?:\+\s*(['"`])([^'"`]*)\4)?/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const items = nearestList(lists, m[3], m.index) || [];
        const candidates = items
            .map((item) => path.posix.normalize(path.posix.join(dirRel, `${m[2]}${item}${m[5] || ''}`)))
            .filter((p) => p.startsWith('src/'));
        out.push({
            index: m.index,
            form: 'computed-require',
            expression: m[0].trim().slice(0, 120),
            listVariable: m[3],
            listCandidates: candidates,
        });
    }
    return out;
}

/**
 * The indirect idioms over one file's text, offsets only; the caller owns line
 * numbers and the repo-relative name. Kept as one entry point so a fixture
 * string can drive exactly what the sweep drives.
 */
function scanIndirectIdioms(text, opts) {
    const options = opts || {};
    const lists = collectLoopLists(text);
    const found = [];
    const dynamic = [];
    if (options.shell) {
        const shell = shellReferences(text, lists);
        found.push(...shell.found);
        dynamic.push(...shell.dynamic);
    } else {
        const roots = collectRootVars(text);
        const helperRanges = [];
        const helpers = collectHelpers(text, roots, helperRanges);
        const rootHits = rootVarReferences(text, roots, lists, helperRanges);
        found.push(...rootHits.found);
        dynamic.push(...rootHits.dynamic);
        const helperHits = helperReferences(text, helpers, lists, collectStringConsts(text));
        found.push(...helperHits.found);
        dynamic.push(...helperHits.dynamic);
    }
    return { found, dynamic };
}

/** A shell script by extension or by shebang, which is what picks the bash matchers. */
function isShellFile(file, text) {
    if (path.extname(file).toLowerCase() === '.sh') return true;
    return /^#!.*\b(?:ba|z|k)?sh\b/.test(text.slice(0, 120));
}

module.exports = { helperReferences, shellReferences, computedRequireSites, scanIndirectIdioms, isShellFile };
