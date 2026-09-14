#!/usr/bin/env node
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
 * What every npm test and ci script collects, file by file and title by title.
 *
 * WHY A MAP AND NOT A COUNT. A restructure that renames test files has to prove
 * it changed nothing about what runs, and a passing count proves nothing: a
 * renamed file can drop out of one glob while another file joins it and the
 * total holds. A suite that silently stops being collected reads as green
 * forever. So the invariant is the SET of full test titles per file, per npm
 * script, and a later run is compared against the committed pin through the
 * rename map that the moving commit declares.
 *
 * WHY IT NEEDS NO DATABASE. `mocha --dry-run` loads every spec file and walks
 * the suite tree without invoking a single hook or test body. Titles are
 * declared at load time, so they are all there; nothing connects, nothing
 * writes. That is what makes this pin cheap enough to re-take at every
 * milestone instead of once.
 *
 * EACH SCRIPT RUNS WITH ITS OWN ARGUMENTS, unchanged apart from the reporter
 * and the dry run. That matters more than it looks: the plain `test` script
 * carries no --no-config, so .mocharc.yml's spec list merges with its
 * positional globs, and a run that "tidied" the arguments would pin a
 * different collection than the one CI executes. A --grep stays, because the
 * filtered set is the script's identity, and so does a `--require`.
 *
 * WHICH SCRIPTS. Every script whose name begins `test` or `ci`, which is
 * nineteen of them here. The `ci` prefix is not decoration: `ci`,
 * `ci:security` and `ci:regression` are the tiers the venue actually runs, and
 * a rename that dropped a file out of one of those globs would be invisible to a
 * pin that only knew the `test` family.
 *
 * A CHAIN IS COLLECTED, NOT JUST NAMED. The hub's `ci` script is a mocha command
 * AND two npm members joined by `&&`. Recording it as a list of member names,
 * which is all its shape has in common with a pure wrapper, would silently drop
 * the unit glob spelled inline in the chain itself: exactly the invisible loss
 * this pin exists to catch. So each `&&` segment is handled on its own, the
 * mocha ones are collected and the npm ones are named, and a segment this tool
 * cannot read is recorded as unsupported rather than skipped in silence.
 *
 * A SCRIPT THAT IS NOT MOCHA IS RECORDED WITH ITS REASON and never dropped:
 * `ci:full` shells out to a script and the two mutation tiers run stryker, so
 * there are no titles to collect and the pin says so in as many words.
 *
 * THE SHAPE ON DISK. Titles are stored once in `titleSets`, keyed by a hash of
 * the list, and each script's `files` map points a test file at the set it
 * contributed. Written out flat the pin is six megabytes of text repeated
 * across the scripts whose globs overlap; the indirection is lossless and the
 * comparison below reads it, so nothing has to unpack it by hand.
 *
 * THE PIN STORES DIGESTS, NOT TITLES. `--out` and `--json` write each full title
 * as its sha256 hex (`titleEncoding: "sha256"`). Test titles quote third-party
 * product names that a public repo's committed files must not carry, and the
 * invariant is set membership, which a digest proves as well as the text does.
 * The comparison hashes the fresh collection before it matches, so a title the
 * tree still carries prints as text and one that vanished prints as its digest;
 * `--json` on the pinned revision recovers the text.
 *
 * USAGE
 *   node bin/suite-title-map.js                    human summary
 *   node bin/suite-title-map.js --root <dir>       collect another checkout
 *   node bin/suite-title-map.js --json             the full map, as a pin, on stdout
 *   node bin/suite-title-map.js --out <file>       write the map as JSON
 *   node bin/suite-title-map.js --script test      one script only
 *   node bin/suite-title-map.js --compare <pin>    diff the tree against a pin,
 *                                                  exit 1 on any difference
 *   node bin/suite-title-map.js --compare <pin> --rename-map <file>
 *                                                  the same, with the moving
 *                                                  commit's {old: new} paths
 *                                                  applied to the pin first
 *
 ********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const {
    getRepoRoot, setRepoRoot, splitCommand, segmentCommand, mochaArgsFor, collect, buildMap,
} = require('./lib/suite_title_map/collect.js');

/** sha256 hex of one full title: the form a committed pin stores it in. */
function titleDigest(title) {
    return crypto.createHash('sha256').update(title).digest('hex');
}

/**
 * The map as it is committed: every title replaced by its digest, set keys and
 * script entries unchanged. See THE SHAPE ON DISK in the header for why.
 */
function toPin(map) {
    if (map.titleEncoding === 'sha256') return map;
    const titleSets = {};
    for (const key of Object.keys(map.titleSets)) titleSets[key] = map.titleSets[key].map(titleDigest);
    return { titleEncoding: 'sha256', titleSets, scripts: map.scripts };
}

/**
 * One file's titles as a Map of digest to what a finding prints, whichever form
 * the map stores, so a digest pin and a text map compare on the same key.
 */
function titleIndex(map, titles) {
    const hashed = map.titleEncoding === 'sha256';
    return new Map(titles.map((t) => [hashed ? t : titleDigest(t), t]));
}

/** The flat {file: [titles]} view of one script in a map, pin or fresh. */
function expand(map, scriptName) {
    const s = map.scripts[scriptName];
    if (!s || !s.files) return null;
    const out = {};
    for (const rel of Object.keys(s.files).sort()) out[rel] = map.titleSets[s.files[rel]] || [];
    return out;
}

/**
 * Pin against tree, script by script. `renames` is the moving commit's declared
 * {oldPath: newPath}; a pin entry is compared under its new name so a pure move
 * reports no difference while a move that changed a title still does.
 */
function compare(pin, fresh, renames, only) {
    const differences = [];
    // A run narrowed to one script compares that script only: every other
    // script in the pin is absent because it was not collected, which is not a
    // finding and would bury the one that is.
    const names = Array.from(new Set(Object.keys(pin.scripts).concat(Object.keys(fresh.scripts))))
        .filter((n) => !only || n === only)
        .sort();
    for (const name of names) {
        const before = expand(pin, name);
        const after = expand(fresh, name);
        if (!before && !after) continue;
        if (!before || !after) {
            differences.push({ script: name, kind: 'script', detail: before ? 'script removed' : 'script added' });
            continue;
        }
        const mapped = {};
        for (const rel of Object.keys(before)) mapped[renames[rel] || rel] = before[rel];
        const files = Array.from(new Set(Object.keys(mapped).concat(Object.keys(after)))).sort();
        for (const rel of files) {
            if (!mapped[rel]) { differences.push({ script: name, kind: 'file_added', file: rel }); continue; }
            if (!after[rel]) { differences.push({ script: name, kind: 'file_dropped', file: rel }); continue; }
            // Keyed by digest on both sides: a pin stores digests and a fresh
            // collection stores text, and the invariant is the same set either way.
            const beforeIndex = titleIndex(pin, mapped[rel]);
            const afterIndex = titleIndex(fresh, after[rel]);
            const gone = [...beforeIndex].filter(([d]) => !afterIndex.has(d)).map(([, t]) => t);
            const added = [...afterIndex].filter(([d]) => !beforeIndex.has(d)).map(([, t]) => t);
            for (const t of gone) differences.push({ script: name, kind: 'title_dropped', file: rel, title: t });
            for (const t of added) differences.push({ script: name, kind: 'title_added', file: rel, title: t });
        }
    }
    return differences;
}

// Escaped to pure ASCII on the way out. The titles are captured verbatim and
// some of them carry characters the platform's prose rules keep out of
// committed files; escaping changes the encoding and not one parsed
// character, so the pin stays exactly what mocha reported.
/** A map or pin as the JSON text --out and --json write. */
function serialize(map) {
    return `${JSON.stringify(map, null, 2).replace(/[-￿]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

function parseArgs(argv) {
    const opts = { json: false };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--json') opts.json = true;
        else if (argv[i] === '--root') { opts.root = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--out') { opts.out = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--script') { opts.script = argv[i + 1]; i += 1; }
        else if (argv[i] === '--compare') { opts.compare = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--rename-map') { opts.renameMap = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        return;
    }
    if (opts.root) setRepoRoot(opts.root);
    const map = buildMap(opts.script);

    if (opts.compare) {
        const pin = JSON.parse(fs.readFileSync(opts.compare, 'utf8'));
        const renames = opts.renameMap ? JSON.parse(fs.readFileSync(opts.renameMap, 'utf8')) : {};
        const differences = compare(pin, map, renames, opts.script);
        if (!differences.length) {
            console.log(`suite identity holds against ${path.relative(getRepoRoot(), opts.compare)}`
                + `${opts.renameMap ? ' through the declared rename map' : ''}`);
            return;
        }
        console.log(`${differences.length} difference(s) against ${path.relative(getRepoRoot(), opts.compare)}:`);
        for (const d of differences.slice(0, 200)) {
            console.log(`  [${d.script}] ${d.kind} ${d.file || ''} ${d.title ? `:: ${d.title}` : d.detail || ''}`);
        }
        if (differences.length > 200) console.log(`  ... and ${differences.length - 200} more`);
        process.exitCode = 1;
        return;
    }

    const text = serialize(toPin(map));
    if (opts.out) {
        fs.mkdirSync(path.dirname(opts.out), { recursive: true });
        fs.writeFileSync(opts.out, text);
    }
    if (opts.json) {
        process.stdout.write(text);
        return;
    }
    let failed = 0;
    for (const name of Object.keys(map.scripts)) {
        const s = map.scripts[name];
        if (s.error) { console.log(`${name.padEnd(26)} ERROR: ${s.error}`); failed += 1; continue; }
        // Every line says what happened to the whole script, chained parts
        // included, because a half-collected chain reported as collected is the
        // silent loss this pin is for.
        const parts = [];
        if (s.files) parts.push(`${String(s.fileCount).padStart(4)} files  ${String(s.titleCount).padStart(5)} titles`);
        if (s.composite) parts.push(`plus npm ${s.composite.join(' + ')}`);
        if (s.skipped) parts.push(`not collected: ${s.skipped}`);
        console.log(`${name.padEnd(26)} ${parts.join('; ')}`);
    }
    if (opts.out) console.log(`\nwritten to ${path.relative(getRepoRoot(), opts.out)}`);
    if (failed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
    buildMap,
    collect,
    mochaArgsFor,
    segmentCommand,
    splitCommand,
    compare,
    expand,
    serialize,
    setRepoRoot,
    titleDigest,
    toPin,
    // The measured checkout, as a call rather than a binding: a consumer that
    // captured the value at require time would keep reading the default after
    // --root moved it.
    repoRoot: getRepoRoot,
};
