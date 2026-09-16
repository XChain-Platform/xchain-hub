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

const { trimPath, callArg, bodySlice } = require('./source_text.js');
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

// Requires whose target no string names (the digest's gate carriers, the providers). A
// missed move there is silent, so every spelling counts: './' + x, path.join over
// __dirname, a name bound to either, or a name bound to a relative join that spells the
// tail from a loop variable (the W5 digest loader: `const rel = path.join('consensus',
// 'gates', mod.replace(/_activation$/, '_gate') + '.js'); path.join(__dirname, rel)`);
// an unbound name is a site with no candidates.
function computedRequireSites(text, dirRel) {
    const lists = collectLoopLists(text);
    const derived = derivedBindings(text);
    const sites = [...concatRequires(text), ...joinRequires(text), ...boundRequires(text)]
        .map((site) => throughDerived(site, derived));
    return sites.sort((a, b) => a.index - b.index).map((site) => {
        const items = site.ident ? (loopVariableItems(text, lists, site.ident, site.index) || []) : [];
        const spell = (item) => (site.replace ? item.replace(site.replace.re, site.replace.to) : item);
        const candidates = items
            .map((item) => path.posix.normalize(path.posix.join(dirRel, ...site.segs, `${site.pre}${spell(item)}${site.post}`)))
            .filter((p) => p.startsWith('src/'));
        return {
            index: site.index,
            form: 'computed-require',
            expression: site.expression.replace(/\s+/g, ' ').trim().slice(0, 120),
            listVariable: site.ident,
            listCandidates: candidates,
        };
    });
}

const QUOTE = '([\'"])';

// path.join / path.resolve over __dirname ending in [literal +] variable [+ literal]; `o` counts
// the groups before it so its backreferences survive splicing. Groups after `o`: 1 segments,
// 4 prefix, 5 variable, 7 suffix.
function joinTail(o) {
    return 'path\\s*\\.\\s*(?:join|resolve)\\s*\\(\\s*__dirname\\s*((?:,\\s*' + QUOTE + '[^\'"]*\\' + (o + 2) + '\\s*)*),'
        + '\\s*(?:' + QUOTE + '([^\'"]*)\\' + (o + 3) + '\\s*\\+\\s*)?([A-Za-z_$][\\w$]*)'
        + '\\s*(?:\\+\\s*' + QUOTE + '([^\'"]*)\\' + (o + 6) + ')?\\s*\\)';
}

// A relative literal prefix concatenated with a variable. Groups after `o`:
// 1 quote, 2 prefix, 3 variable, 5 suffix.
function concatTail(o) {
    return QUOTE + '(\\.\\.?\\/[^\'"]*)\\' + (o + 1) + '\\s*\\+\\s*([A-Za-z_$][\\w$]*)'
        + '\\s*(?:\\+\\s*' + QUOTE + '([^\'"]*)\\' + (o + 4) + ')?';
}

function literalSegments(list) {
    return (list.match(/(['"])[^'"]*\1/g) || []).map((s) => s.slice(1, -1));
}

function concatRequires(text) {
    const out = [];
    const re = new RegExp('require\\s*\\(\\s*' + concatTail(0), 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
        out.push({ index: m.index, expression: m[0], segs: [], pre: m[2], ident: m[3], post: m[5] || '' });
    }
    return out;
}

function joinRequires(text) {
    const out = [];
    const re = new RegExp('require\\s*\\(\\s*' + joinTail(0) + '\\s*\\)', 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
        out.push({ index: m.index, expression: m[0], segs: literalSegments(m[1]), pre: m[4] || '', ident: m[5], post: m[7] || '' });
    }
    return out;
}

// `require(name)`, resolved through the nearest binding of `name` above it. A
// binding to a plain string or an all-literal join names its file and is no site.
function boundRequires(text) {
    const bindings = [];
    // Group 1 is the bound name; the join tail then holds groups 2 to 8 and the
    // concatenation groups 9 to 13.
    const bind = new RegExp('(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:' + joinTail(1) + '|' + concatTail(8) + ')', 'g');
    let m;
    while ((m = bind.exec(text)) !== null) {
        const join = m[6] !== undefined;
        bindings.push({
            name: m[1], index: m.index, expression: m[0],
            segs: join ? literalSegments(m[2]) : [], pre: join ? (m[5] || '') : m[10],
            ident: join ? m[6] : m[11], post: join ? (m[8] || '') : (m[13] || ''),
        });
    }
    const literal = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(['"`])[^'"`]*\2|path\s*\.\s*(?:join|resolve)\s*\(\s*__dirname(?:\s*,\s*(['"])[^'"]*\3)*\s*\))\s*[;,\n]/g;
    while ((m = literal.exec(text)) !== null) bindings.push({ name: m[1], index: m.index, literal: true });
    const out = [];
    const use = /\brequire\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
    while ((m = use.exec(text)) !== null) {
        const b = nearestBinding(bindings, m[1], m.index);
        if (b && b.literal) continue;
        if (b) out.push({ index: m.index, expression: `${b.expression.trim()} ... ${m[0]}`, segs: b.segs, pre: b.pre, ident: b.ident, post: b.post });
        else out.push({ index: m.index, expression: m[0], segs: [], pre: '', ident: null, post: '' });
    }
    return out;
}

// `const NAME = path.join(<literal segments>, [literal +] IDENT[.replace(/re/, 'lit')] [+ literal])`
// with no __dirname: a relative tail spelled from a variable, which a later
// path.join(__dirname, NAME) or require(NAME) resolves through. The one transform
// followed is a String.replace of a regex literal by a string literal, the W5
// loader's `_activation` to `_gate` respelling; anything else keeps the name unresolved.
function derivedBindings(text) {
    const out = [];
    const re = new RegExp('(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*path\\s*\\.\\s*(?:join|resolve)\\s*\\(\\s*'
        + '((?:' + QUOTE + '[^\'"]*\\3\\s*,\\s*)*)'
        + '(?:' + QUOTE + '([^\'"]*)\\4\\s*\\+\\s*)?([A-Za-z_$][\\w$]*)'
        + '(?:\\s*\\.\\s*replace\\s*\\(\\s*\\/((?:[^\\/\\\\\\n]|\\\\.)+)\\/([a-z]*)\\s*,\\s*' + QUOTE + '([^\'"]*)\\9\\s*\\))?'
        + '\\s*(?:\\+\\s*' + QUOTE + '([^\'"]*)\\11)?\\s*\\)', 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
        out.push({
            name: m[1], index: m.index, expression: m[0],
            segs: literalSegments(m[2]), pre: m[5] || '', ident: m[6], post: m[12] || '',
            replace: m[7] !== undefined ? { re: new RegExp(m[7], m[8] || ''), to: m[10] } : null,
        });
    }
    return out;
}

// A site whose variable is a derived binding takes that binding's tail, segments and
// transform in place of the variable, so the loop variable underneath is what the
// candidates range over.
function throughDerived(site, derived) {
    if (!site.ident || site.segs.length || site.pre || site.post) return site;
    const b = nearestBinding(derived, site.ident, site.index);
    if (!b) return site;
    return Object.assign({}, site, {
        expression: `${b.expression.trim()} ... ${site.expression.trim()}`,
        segs: b.segs, pre: b.pre, ident: b.ident, post: b.post, replace: b.replace,
    });
}

function nearestBinding(bindings, name, index) {
    let best = null;
    for (const b of bindings) if (b.name === name && b.index < index && (!best || b.index > best.index)) best = b;
    return best;
}

// The list a variable ranges over: an enclosing loop, else (for a parameter of the enclosing
// function) every call of that function, a literal argument being its own item and a variable
// resolving through the loop around the call.
function loopVariableItems(text, lists, ident, index) {
    const direct = nearestList(lists, ident, index);
    if (direct) return direct;
    const fn = enclosingFunction(text, ident, index);
    if (!fn) return null;
    const items = [];
    const call = new RegExp(String.raw`\b${fn.name}\s*\(\s*(?:(['"])([^'"]*)\1|([A-Za-z_$][\w$]*))\s*[,)]`, 'g');
    let m;
    while ((m = call.exec(text)) !== null) {
        if (m.index === fn.index) continue;
        if (m[2] !== undefined) items.push(m[2]);
        else items.push(...(nearestList(lists, m[3], m.index) || []));
    }
    return items.length ? [...new Set(items)] : null;
}

const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with']);

// The innermost named function or method whose body holds `index` and whose
// parameters include `ident`.
function enclosingFunction(text, ident, index) {
    const header = /(?:\bfunction\s+([A-Za-z_$][\w$]*)|(?:^|[\n;{}])[ \t]*(?:async\s+)?([A-Za-z_$][\w$]*))\s*\(([^()]*)\)\s*\{/g;
    let best = null;
    let m;
    while ((m = header.exec(text)) !== null) {
        const name = m[1] || m[2];
        if (!name || NOT_A_FUNCTION.has(name)) continue;
        const params = m[3].split(',').map((p) => p.replace(/=.*$/s, '').trim());
        if (!params.includes(ident)) continue;
        const brace = header.lastIndex - 1;
        const body = bodySlice(text, brace, 200000);
        if (index <= brace || index >= brace + body.length) continue;
        const at = m.index + m[0].indexOf(name);
        if (!best || brace > best.brace) best = { name, index: at, brace };
    }
    return best;
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
