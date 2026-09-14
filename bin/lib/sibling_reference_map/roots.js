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
 * The javascript half of the indirect idioms: variables and closures that hold
 * this checkout, and the src/ paths joined onto them.
 *
 ********************************************************************/

'use strict';

const { literalJoinTail, bodySlice, trimPath } = require('./source_text.js');
const { underSrc, resolveJoinTail, relFromTail } = require('./loops.js');

// ---------------------------------------------------------------------------
// THE INDIRECT IDIOMS
//
// The two matchers above only see a path someone spelled out in one piece. The
// shape the sibling suites actually use keeps the checkout in a variable and
// joins the file onto it, so the repo name and the file name never share a
// string and a text sweep leaves no trace of the reference at all. That blind
// spot was measured on 2026-09-13: about 29 test and tool files across five
// sibling repos plus a bash script covering thirty more, none of them visible
// to the original map, all of them broken the moment a src/ file moves.
//
// Everything below reconstructs the literal file list such a site resolves to.
// A tail that is not literal goes to `dynamicReferences` rather than being
// guessed, because a rename cannot be checked against a guess.
// ---------------------------------------------------------------------------

// Environment variables that hold a checkout of this repo. Both spellings are in
// live use across the siblings (measured 2026-09-13: 19 sites name the first and
// 18 the second), and a root reached through either one spells no path at all, so
// a sweep that knew only one of them would miss every reference hung off the other.
// XCHAIN_HUB_DEPLOY_KEY is deliberately absent: it is a credential, not a checkout.
const ENV_ROOT_VARS = ['XCHAIN_HUB_PATH', 'XCHAIN_HUB_DIR'];

/** True when an identifier is the node path module under some alias. */
function isPathAlias(name) { return /path/i.test(name); }

/**
 * The repo-relative directory an expression points at: `''` for the checkout
 * itself, `'src'`, `'src/sql'`, and so on, or null when the expression is not a
 * directory in this repo at all (it names a FILE, which the text matcher already
 * owns, or it names some other repo).
 *
 * The prefix has to be the whole path rather than a two-valued repo/src flag:
 * a sibling that pins `path.join(..., 'xchain-hub', 'src', 'sql')` and then joins
 * bare table names onto it would otherwise be recorded against src/<table>.sql
 * for a file that lives at src/sql/<table>.sql.
 */
function rootPrefix(init) {
    let prefix = null;
    const named = /[A-Za-z0-9_@.\-]+/;
    const re = /xchain-hub((?:\/[A-Za-z0-9_@.\-]+)*)/g;
    let m;
    while ((m = re.exec(init)) !== null) {
        const segments = (m[1] || '').split('/').filter(Boolean);
        // Separately quoted segments spell the same directory:
        // path.join(base, 'xchain-hub', 'src', 'sql').
        let rest = init.slice(re.lastIndex);
        let more = /^['"`]\s*,\s*['"`]([A-Za-z0-9_@.\-]+)['"`]/.exec(rest);
        while (more) {
            segments.push(more[1]);
            rest = rest.slice(more[0].length - 1);
            more = /^['"`]\s*,\s*['"`]([A-Za-z0-9_@.\-]+)['"`]/.exec(rest);
        }
        if (segments.some((s) => !named.test(s) || /\.[A-Za-z0-9]+$/.test(s))) return null;
        prefix = segments.join('/');
    }
    if (prefix !== null) return prefix;
    for (const env of ENV_ROOT_VARS) if (init.includes(`process.env.${env}`)) return '';
    return null;
}

/**
 * A root variable derived from one already known: the candidate list filtered
 * to its first live entry, the `.find()` over that list, a plain alias, or a
 * join that walks the root down to its `src/` directory. Anything else that
 * merely mentions a root (an `existsSync` probe, a file path built from it) is
 * not itself a root and must not become one, or every boolean in the file turns
 * into a phantom reference site.
 */
function inheritedPrefix(init, roots) {
    for (const [name, prefix] of roots) {
        if (!new RegExp(`\\b${name}\\b`).test(init)) continue;
        if (new RegExp(`^\\s*${name}\\s*$`).test(init)) return prefix;
        if (new RegExp(`\\b${name}\\s*(?:\\.\\s*(?:find|filter)\\s*\\(|\\[\\s*0\\s*\\])`).test(init)) return prefix;
        const join = new RegExp(`([A-Za-z_$][\\w$]*)\\s*\\.\\s*(?:join|resolve)\\s*\\(\\s*${name}\\s*,([^)]*)\\)`).exec(init);
        if (join && isPathAlias(join[1])) {
            const tail = literalJoinTail(join[2]);
            // Walking the root down to another directory gives another root; a
            // tail whose last segment has an extension names a file, and a file
            // is a reference, not a root to hang more references off.
            if (tail === null || /\.[A-Za-z0-9]+$/.test(tail)) continue;
            return [prefix, tail.replace(/\/$/, '')].filter(Boolean).join('/');
        }
        if (/^\s*\[/.test(init)) return prefix;
    }
    return null;
}

/**
 * Functions that RETURN a root, the `resolveHubRoot()` shape. Without these
 * the variable holding their result is invisible and every join onto it is lost.
 */
function collectRootProducers(text) {
    const producers = new Map();
    const re = /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const body = bodySlice(text, m.index + m[0].length - 1, 3000);
        // A BARE identifier, not an expression. `return path.resolve(root, rel)`
        // hands back one file; treating its caller as a root made every
        // `const p = hubFile('src/x.js')` look like another checkout.
        if (!/\breturn\s+[A-Za-z_$][\w$]*\s*;/.test(body)) continue;
        const prefix = rootPrefix(body);
        if (prefix !== null) producers.set(m[1], prefix);
    }
    return producers;
}

/**
 * Every variable in a file that holds this checkout's root (or its src/
 * directory). The scan repeats until it stops learning names, because a root is
 * routinely derived from another one two or three steps away.
 */
function collectRootVars(text) {
    const roots = new Map();
    const producers = collectRootProducers(text);
    const declare = (name, prefix) => {
        if (!name || prefix === null || prefix === undefined || roots.has(name)) return false;
        roots.set(name, prefix);
        return true;
    };
    const classify = (init) => {
        const direct = rootPrefix(init);
        if (direct !== null) return direct;
        const derived = inheritedPrefix(init, roots);
        if (derived !== null) return derived;
        const call = /^\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(init);
        return call && producers.has(call[1]) ? producers.get(call[1]) : null;
    };
    for (let pass = 0; pass < 4; pass += 1) {
        let learned = false;
        let m;
        const decl = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]{0,400}?);/g;
        while ((m = decl.exec(text)) !== null) {
            if (declare(m[1], classify(m[2]))) learned = true;
        }
        const forOf = /for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([^)\n]{0,200})\)/g;
        while ((m = forOf.exec(text)) !== null) {
            if (declare(m[1], classify(m[2]))) learned = true;
        }
        const cb = /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:find|filter|map|forEach|some|every)\s*\(\s*(?:async\s+)?\(?\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
        while ((m = cb.exec(text)) !== null) {
            if (roots.has(m[1]) && declare(m[2], roots.get(m[1]))) learned = true;
        }
        if (!learned) break;
    }
    return roots;
}

/**
 * Every hub src/ path a root variable is joined with, in all three
 * spellings the tree uses: path.join(R, 'src', 'x.js'), path.join(R, 'src/x.js')
 * and `${R}/src/x.js`.
 */
function rootVarReferences(text, roots, lists, skipRanges) {
    const found = [];
    const dynamic = [];
    // A helper closure joins its own parameter onto the root; that site is the
    // helper's definition, and every call of it is already reported through the
    // helper channel. Reporting it again as an unresolvable join would put a
    // phantom "ask a human" line beside every one of them.
    const suppressed = (index) => (skipRanges || []).some((r) => index >= r.start && index < r.end);
    for (const [name, suffix] of roots) {
        let m;
        const joined = new RegExp(`([A-Za-z_$][\\w$]*)\\s*\\.\\s*(?:join|resolve)\\s*\\(\\s*${name}\\s*,([^)]*)\\)`, 'g');
        while ((m = joined.exec(text)) !== null) {
            if (!isPathAlias(m[1])) continue;
            const tails = resolveJoinTail(m[2], lists || [], m.index);
            if (tails === null) {
                if (!suppressed(m.index)) {
                    dynamic.push({ index: m.index, form: 'root-var', root: name, expression: m[0].trim().slice(0, 120) });
                }
                continue;
            }
            for (const tail of tails) {
                const rel = trimPath(relFromTail(suffix, tail));
                if (underSrc(rel)) found.push({ index: m.index, path: rel, form: 'root-var', root: name });
            }
        }
        const templated = new RegExp(`\\$\\{\\s*${name}\\s*\\}/([A-Za-z0-9_@.\\-/]+)`, 'g');
        while ((m = templated.exec(text)) !== null) {
            const rel = trimPath(relFromTail(suffix, m[1]));
            if (underSrc(rel)) found.push({ index: m.index, path: rel, form: 'root-var', root: name });
        }
        const concat = new RegExp(`\\b${name}\\s*\\+\\s*['"\`]/?([A-Za-z0-9_@.\\-/]+)`, 'g');
        while ((m = concat.exec(text)) !== null) {
            const rel = trimPath(relFromTail(suffix, m[1]));
            if (underSrc(rel)) found.push({ index: m.index, path: rel, form: 'root-var', root: name });
        }
    }
    return { found, dynamic };
}

/**
 * Closures that take a repo-relative path and hand back a file inside this
 * checkout, the `hubFile('src/db.js')` idiom. Recognised by a body
 * that joins its own first parameter onto a hub root, which is narrow
 * enough to leave the sibling-presence guards beside them alone.
 */
function collectHelpers(text, roots, outRanges) {
    const helpers = new Map();
    const re = /(?:function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\(([^)]*)\)\s*(?:=>)?)\s*\{/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const name = m[1] || m[3];
        const param = (m[2] || m[4] || '').split(',')[0].trim().replace(/[^\w$].*$/, '');
        if (!name || !param) continue;
        const open = m.index + m[0].length - 1;
        const body = bodySlice(text, open, 2000);
        const call = new RegExp(`([A-Za-z_$][\\w$]*)\\s*\\.\\s*(?:join|resolve)\\s*\\(\\s*([A-Za-z_$][\\w$]*)[^)]*\\b${param}\\b`).exec(body);
        if (!call || !isPathAlias(call[1])) continue;
        const prefix = roots.has(call[2]) ? roots.get(call[2]) : rootPrefix(body);
        if (prefix === null) continue;
        helpers.set(name, prefix);
        if (outRanges) outRanges.push({ start: open, end: open + body.length });
    }
    return helpers;
}

module.exports = { isPathAlias, rootPrefix, collectRootVars, rootVarReferences, collectHelpers };
