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
 * Loop variables bound to literal lists, in javascript and bash alike, and the
 * join tails such a variable expands into.
 *
 ********************************************************************/

'use strict';

const {
    literalJoinTail, bodySlice, balancedArrayBody, itemsFromArrayBody, arrayLiteralItems, splitTopLevel,
} = require('./source_text.js');

/** A repo-relative path is only ours when it lands under src/ and walks nowhere. */
function underSrc(rel) {
    return /^src\/[^\s]+$/.test(rel) && !rel.split('/').includes('..');
}

/**
 * The literal path or paths a `path.join(<root>, ...)` tail resolves to. A tail
 * whose last segment is a loop variable over a literal array resolves to one
 * path per element: the explorer's hub-mirror guard and the xchain-sync twin
 * loop are both written that way, and a move has to repoint every element, so
 * collapsing them to a single "dynamic, ask a human" line would hide the bulk
 * of the blast radius behind one note.
 */
function resolveJoinTail(rawTail, lists, index) {
    const literal = literalJoinTail(rawTail);
    if (literal !== null) return [literal];
    const stop = rawTail.search(/[)\]]/);
    const segments = splitTopLevel(stop === -1 ? rawTail : rawTail.slice(0, stop)).map((s) => s.trim());
    if (!segments.length) return null;
    const last = segments.pop();
    // Either the bare loop variable, or a template built around it:
    // path.join(HUB, 'coins', `${c}.js`) over ['BTC', 'LTC', 'DOGE'].
    let ident = /^[A-Za-z_$][\w$]*$/.test(last) ? last : null;
    let pre = '';
    let post = '';
    if (!ident) {
        const tpl = /^`([^`$]*)\$\{\s*([A-Za-z_$][\w$]*)\s*\}([^`$]*)`$/.exec(last);
        if (!tpl) return null;
        pre = tpl[1];
        ident = tpl[2];
        post = tpl[3];
    }
    const prefix = [];
    for (const segment of segments) {
        const lit = /^(['"`])([^'"`]*)\1$/.exec(segment);
        if (!lit) return null;
        prefix.push(lit[2]);
    }
    const items = nearestList(lists, ident, index);
    if (!items) return null;
    return items.map((item) => prefix.concat(pre + item + post).join('/'));
}

/** The repo-relative path a tail names when joined onto a root at `prefix`. */
function relFromTail(prefix, tail) {
    return prefix ? `${prefix}/${tail}` : tail;
}

/**
 * Every loop in a file whose variable ranges over a literal list, javascript and
 * bash alike, with the byte offset of the loop header so a use site can bind to
 * the nearest one above it rather than to every list in the file.
 */
function collectLoopLists(text) {
    const lists = [];
    collectForOfLists(text, lists);
    collectNamedForOfLists(text, lists);
    collectCallbackLists(text, lists);
    collectShellLists(text, lists);
    return lists;
}

// Where a loop variable stops meaning anything. Without this a use site
// binds to the nearest list ABOVE it wherever that list happens to be, so a
// `for (const f of SQL_FILES)` reading a directory would be attributed to
// some earlier literal `f` loop and the map would invent files nobody names.
function loopScopeEnd(text, from) {
    const brace = text.indexOf('{', from);
    if (brace !== -1 && brace - from <= 200) return brace + bodySlice(text, brace, 200000).length;
    return Math.min(text.length, from + 300);
}

/** Record one loop, unless its list resolved to nothing. */
function pushLoopList(lists, text, index, from, name, items) {
    if (items && items.length) lists.push({ index, end: loopScopeEnd(text, from), name, items });
}

/** `for (const f of ['a', 'b'])`, a destructured row read column by column. */
function collectForOfLists(text, lists) {
    let m;
    const inline = /for\s*\(\s*(?:const|let|var)\s+(?:\[([^\]]*)\]|([A-Za-z_$][\w$]*))\s+of\s+\[/g;
    while ((m = inline.exec(text)) !== null) {
        const body = balancedArrayBody(text, inline.lastIndex - 1);
        if (body === null) continue;
        const after = inline.lastIndex + body.length + 1;
        if (m[1] !== undefined) {
            const cols = m[1].split(',').map((s) => s.trim());
            for (let col = 0; col < cols.length; col += 1) {
                if (!/^[A-Za-z_$][\w$]*$/.test(cols[col])) continue;
                pushLoopList(lists, text, m.index, after, cols[col], itemsFromArrayBody(body, col));
            }
        } else {
            pushLoopList(lists, text, m.index, after, m[2], itemsFromArrayBody(body));
        }
        inline.lastIndex = after;
    }
}

/** `for (const f of NAMES)` over a literal array declared elsewhere in the file. */
function collectNamedForOfLists(text, lists) {
    let m;
    const named = /for\s*\(\s*(?:const|let|var)\s+(?:\[([^\]]*)\]|([A-Za-z_$][\w$]*))\s+of\s+([A-Za-z_$][\w$]*)\s*\)/g;
    while ((m = named.exec(text)) !== null) {
        if (m[1] !== undefined) {
            const cols = m[1].split(',').map((s) => s.trim());
            for (let col = 0; col < cols.length; col += 1) {
                if (!/^[A-Za-z_$][\w$]*$/.test(cols[col])) continue;
                pushLoopList(lists, text, m.index, named.lastIndex, cols[col], arrayLiteralItems(text, m[3], col));
            }
            continue;
        }
        pushLoopList(lists, text, m.index, named.lastIndex, m[2], arrayLiteralItems(text, m[3]));
    }
}

/** The same loops written as `.forEach` or `.map` callbacks. */
function collectCallbackLists(text, lists) {
    let m;
    // NAMES.forEach(function(f){ ... }) is the same loop written as a callback,
    // and the explorer's twin guard reaches into this repo from inside one.
    const each = /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:forEach|map)\s*\(\s*(?:async\s+)?(?:function\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
    while ((m = each.exec(text)) !== null) {
        pushLoopList(lists, text, m.index, each.lastIndex, m[2], arrayLiteralItems(text, m[1]));
    }
    // The list written where it is used: ['BTC', 'LTC', 'DOGE'].map((c) => ...).
    const eachInline = /\[/g;
    while ((m = eachInline.exec(text)) !== null) {
        const body = balancedArrayBody(text, m.index);
        if (body === null) continue;
        const after = m.index + body.length + 2;
        const call = /^\s*\.\s*(?:forEach|map)\s*\(\s*(?:async\s+)?(?:function\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*[,)]/.exec(text.slice(after, after + 80));
        if (!call) continue;
        pushLoopList(lists, text, m.index, after + call[0].length, call[1], itemsFromArrayBody(body));
    }
}

/** `for f in a b c; do`, which is how the bash twin copiers are written. */
function collectShellLists(text, lists) {
    let m;
    const shell = /\bfor\s+([A-Za-z_][\w]*)\s+in\s+([\s\S]{0,500}?)(?:;\s*|\n\s*)do\b/g;
    while ((m = shell.exec(text)) !== null) {
        const items = m[2].replace(/\\\s*\n/g, ' ').split(/\s+/)
            .filter((t) => t && /^[A-Za-z0-9_@.\-/]+$/.test(t));
        if (!items.length) continue;
        const done = text.indexOf('\ndone', shell.lastIndex);
        lists.push({
            index: m.index,
            end: done === -1 ? Math.min(text.length, shell.lastIndex + 600) : done,
            name: m[1],
            items,
        });
    }
}

/**
 * The list a loop variable ranges over at this offset: the innermost loop whose
 * body contains it, never a list from a scope that has already closed.
 */
function nearestList(lists, name, index) {
    let best = null;
    for (const entry of lists) {
        if (entry.name !== name || entry.index > index || index >= entry.end) continue;
        if (!best || entry.index > best.index) best = entry;
    }
    return best ? best.items : null;
}

/** Single-assignment string constants, so `const rel = 'src/x.js'` survives one hop. */
function collectStringConsts(text) {
    const seen = new Map();
    const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n]*)\2\s*;/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (seen.has(m[1]) && seen.get(m[1]) !== m[3]) seen.set(m[1], null);
        else if (!seen.has(m[1])) seen.set(m[1], m[3]);
    }
    return seen;
}

module.exports = { underSrc, resolveJoinTail, relFromTail, collectLoopLists, nearestList, collectStringConsts };
