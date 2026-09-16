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
 * Text primitives the matchers share: path trimming, literal path.join tails,
 * line lookup, and bracket-aware slicing of arrays, bodies and call arguments.
 *
 ********************************************************************/

'use strict';

// A captured path stops at the first character that cannot be part of one. The
// text regex is deliberately greedy over dots and slashes so `foo.js` survives,
// which means a sentence-ending period or a closing quote can ride along.
function trimPath(raw) {
    let out = raw;
    while (out.length && '.,;:)\'"`]}>*'.includes(out[out.length - 1])) out = out.slice(0, -1);
    return out;
}

/** Every literal segment of a path.join tail, or null when one is an expression. */
function literalJoinTail(rawTail) {
    const segments = [];
    // The call's own closing bracket ends the argument list; anything past it
    // belongs to the enclosing expression and is not a path segment.
    const stop = rawTail.search(/[)\]]/);
    const tail = stop === -1 ? rawTail : rawTail.slice(0, stop);
    // Consume `'a', 'b', ...` until the tail stops being literal segments.
    const re = /\s*(?:(['"`])([^'"`]*)\1|([^,]+))\s*(,|$)/g;
    let m;
    while ((m = re.exec(tail)) !== null) {
        if (m[3] !== undefined) {
            const token = m[3].trim();
            if (token === '') break;
            return null;
        }
        // A backticked segment holding `${...}` is a template, not a literal:
        // path.join(HUB, 'coins', `${c}.js`) names three coins, and reading
        // it as one file called "${c}.js" records a path nobody can repoint.
        if (m[1] === '`' && m[2].includes('${')) return null;
        segments.push(m[2]);
        if (m[4] !== ',') break;
    }
    return segments.length ? segments.join('/') : null;
}

/** Byte offset to 1-based line number, for a file already in memory. */
function lineAt(text, index) {
    let line = 1;
    for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
    return line;
}

/** The whole source line a match sits on, which tells a load from a mention. */
function lineTextAt(text, index) {
    const start = text.lastIndexOf('\n', index) + 1;
    const end = text.indexOf('\n', index);
    return text.slice(start, end === -1 ? text.length : end);
}

/**
 * A load or a mention. A load breaks the referring repo the moment the path
 * moves; a mention only misleads the next reader, so the two carry different
 * urgency and the map has to separate them.
 */
function referenceKind(line) {
    return /\brequire\s*\(|\bimport\s*\(|\bfrom\s+['"`]/.test(line) ? 'require' : 'text';
}

/** The `{ ... }` starting at openIndex, brace-counted, capped so a stray brace cannot run away. */
function bodySlice(text, openIndex, limit) {
    let depth = 0;
    const end = Math.min(text.length, openIndex + limit);
    for (let i = openIndex; i < end; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(openIndex, i + 1); }
    }
    return text.slice(openIndex, end);
}

/** The text between the parentheses opening at openIndex, paren-counted. */
function callArg(text, openIndex, limit) {
    let depth = 0;
    const end = Math.min(text.length, openIndex + limit);
    for (let i = openIndex; i < end; i += 1) {
        if (text[i] === '(') depth += 1;
        else if (text[i] === ')') { depth -= 1; if (depth === 0) return text.slice(openIndex + 1, i); }
    }
    return null;
}

/**
 * The literal string elements of `const NAME = [ ... ]`. When `tupleIndex` is
 * given the array holds rows rather than names (SHARED_GATES is
 * `[[module, [constants]], ...]`) and that column is taken from each row.
 */
function arrayLiteralItems(source, name, tupleIndex) {
    // A real list is commented row by row (SHARED_GATES explains why each gate is
    // there). Leaving the comments in makes the row after one fail to parse as a
    // literal, which silently truncates the list and under-reports the move.
    const text = stripComments(source);
    const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\[`).exec(text);
    if (!decl) return null;
    const body = balancedArrayBody(text, text.indexOf('[', decl.index));
    return body === null ? null : itemsFromArrayBody(body, tupleIndex);
}

/** The contents of the `[ ... ]` opening at openIndex, brackets balanced and strings respected. */
function balancedArrayBody(text, openIndex) {
    let depth = 0;
    let quote = null;
    for (let i = openIndex; i < text.length; i += 1) {
        const c = text[i];
        if (quote) { if (c === quote && text[i - 1] !== '\\') quote = null; continue; }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if (c === '[') depth += 1;
        else if (c === ']') { depth -= 1; if (depth === 0) return text.slice(openIndex + 1, i); }
    }
    return null;
}

/**
 * The literal strings in an array body. `tupleIndex` reads one column out of an
 * array of rows, which is how both SHARED_GATES and the post-move xchain-sync
 * twin loop are written: `[['merkle.js', 'src/consensus/merkle.js'], ...]`.
 */
function itemsFromArrayBody(body, tupleIndex) {
    const rows = splitTopLevel(stripComments(body));
    const items = [];
    for (const row of rows) {
        const cell = tupleIndex === undefined
            ? row
            : (splitTopLevel(row.replace(/^\s*\[/, '').replace(/\]\s*$/, ''))[tupleIndex] || '');
        const lit = /^\s*(['"`])([^'"`]*)\1\s*$/.exec(cell);
        if (lit) items.push(lit[2]);
    }
    return items.length ? items : null;
}

/**
 * The same text with javascript comments blanked to spaces, byte offsets and
 * line numbers preserved so a match found here still points at the real line.
 * Quote state is tracked, so a `//` inside a string literal survives.
 */
function stripComments(text) {
    let out = '';
    let quote = null;
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (quote) {
            out += c;
            if (c === '\\') { out += text[i + 1] || ''; i += 1; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; out += c; continue; }
        if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') { out += ' '; i += 1; }
            out += '\n';
            continue;
        }
        if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            const stop = end === -1 ? text.length : end + 2;
            for (let j = i; j < stop; j += 1) out += text[j] === '\n' ? '\n' : ' ';
            i = stop - 1;
            continue;
        }
        out += c;
    }
    return out;
}

/** Split on commas that are not inside brackets, braces, parens or a string. */
function splitTopLevel(body) {
    const out = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < body.length; i += 1) {
        const c = body[i];
        if (quote) { if (c === quote && body[i - 1] !== '\\') quote = null; continue; }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if ('[{('.includes(c)) depth += 1;
        else if (']})'.includes(c)) depth -= 1;
        else if (c === ',' && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
    }
    out.push(body.slice(start));
    return out.filter((s) => s.trim() !== '');
}

module.exports = {
    trimPath,
    literalJoinTail,
    lineAt,
    lineTextAt,
    referenceKind,
    bodySlice,
    callArg,
    arrayLiteralItems,
    balancedArrayBody,
    itemsFromArrayBody,
    stripComments,
    splitTopLevel,
};
