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
 * Is every file that may not move still where it was? Exit 1 naming the file if
 * not.
 *
 * WHY A CHECK AND NOT A CONVENTION, and this is the only reason it exists. A set
 * of modules in this repo is resolved by a path this build COMPUTES at runtime,
 * inside a try/catch that swallows the failure:
 *
 *   src/consensus_rules_digest.js:152  require('./' + mod + '.js'), catch -> the
 *                                      ABSENT sentinel. Move a gate carrier into
 *                                      a subdirectory and the digest is computed
 *                                      over a map in which every gate reads
 *                                      absent, while the SIGNED wire field,
 *                                      knownGateKeys().join(','), is byte for
 *                                      byte what every peer publishes. A rules
 *                                      fork that no wire field names.
 *   src/cross_chain/bridge_engine.js:117  require(path.join(__dirname, '..',
 *                                      moduleName + '.js')), catch -> null. The
 *                                      engine then idles, by design and correctly,
 *                                      but for the wrong reason, and only the
 *                                      bridge activation resolve test notices.
 *
 * Neither failure throws, neither fails a suite and neither changes a published
 * number. A restructure cannot be trusted to remember that; it can be made to
 * run this.
 *
 * THE THREE HALVES OF THE ANSWER, because no single one of them is enough:
 *
 *   derived   every SHARED_GATES basename must resolve at src/<name>.js. The
 *             list is READ FROM THE MODULE, never restated here: a restated copy
 *             is a second registry, and the day it drifts is the day this check
 *             blesses the move it exists to refuse.
 *   shaped    no *_activation.js may sit below the top level of src/, bar the
 *             declared exceptions. This is what catches a gate carrier that no
 *             SHARED_GATES row names yet: the file is frozen the moment it is
 *             written, not the moment it is registered.
 *   listed    a committed manifest of every path the frozen globs matched when
 *             the pass began. The globs themselves cannot detect a deletion or a
 *             rename, because a glob over the tree always agrees with the tree.
 *             The manifest is the only half that does, and it is regenerated
 *             only by an explicit --write.
 *
 * USAGE
 *   node bin/check-frozen-set.js                  check this checkout
 *   node bin/check-frozen-set.js --root <dir>     check another one
 *   node bin/check-frozen-set.js --json           the full verdict
 *   node bin/check-frozen-set.js --write          record the manifest afresh
 *
 * Exit 0 clean, 1 something moved, 2 a bad argument or an unreadable tree.
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

// The checkout under test. A binding rather than a constant so `--root` can aim
// it at another tree, which is what the falsification run does.
let REPO_ROOT = path.resolve(__dirname, '..');

const MANIFEST_REL = 'bin/pins/at1-frozen-set.json';

/**
 * The globs whose matches are frozen, with the reason each one is on the list.
 * Two shapes are frozen for two different reasons, and collapsing them would
 * lose the argument: the gate carriers are frozen because a computed require
 * resolves them, and the vendored trees are frozen because six to ten other
 * repos hold byte-identical copies kept in step by a sync script.
 */
const FROZEN_GLOBS = [
    { glob: 'src/*_activation.js',        why: 'gate carriers, resolved by computed require' },
    { glob: 'src/lib/fullnode_activation.js', why: 'a gate carrier that already sits outside the top level' },
    { glob: 'src/equivocation_header.js', why: 'a SHARED_GATES carrier under a name that is not _activation' },
    { glob: 'src/snapshot_reorg_buffer.js', why: 'a SHARED_GATES carrier under a name that is not _activation' },
    { glob: 'src/stake_weighted_quorum.js', why: 'a SHARED_GATES carrier under a name that is not _activation' },
    { glob: 'src/consensus_rules_digest.js', why: 'the module that computes the requires' },
    { glob: 'src/coins/**',               why: 'byte-vendored to six to ten repos by sync-coins.sh' },
    { glob: 'src/observability/**',       why: 'byte-vendored to six to ten repos by sync-observability.sh' },
    { glob: 'src/sql/**',                 why: 'read by path from sibling conformance suites' },
    { glob: 'src/xchainPrice.js',         why: 'vendored twin' },
    { glob: 'src/xchainPriceQuery.js',    why: 'vendored twin' },
    { glob: 'src/price_batch_compression.js', why: 'vendored twin' },
    { glob: 'test/fixtures/anchor_canonical_vectors.json', why: 'a frozen protocol vector' },
    { glob: 'test/fixtures/dex-fill-quantization-vectors.json', why: 'a frozen protocol vector' },
];

/**
 * Paths the shape rule forgives. src/coins/fullnodeComment.test.js is a TEST
 * file that this pass deliberately moves out of src/, and it is not in
 * sync-coins.sh's FILES list, so it is not a vendored twin despite where it sits.
 */
const SHAPE_EXCEPTIONS = new Set([
    'src/lib/fullnode_activation.js',
]);

const MOVABLE = new Set([
    'src/coins/fullnodeComment.test.js',
]);

/**
 * Check `dir` instead of the checkout this script lives in.
 * @param {string} dir a hub checkout
 * @returns {string} the resolved root
 */
function setRepoRoot(dir) { REPO_ROOT = path.resolve(dir); return REPO_ROOT; }

/** Every file under `rel`, repo-relative and sorted; empty when it is absent. */
function filesUnder(rel) {
    const abs = path.join(REPO_ROOT, rel);
    const out = [];
    const walk = (dir, prefix) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of entries) {
            const child = path.posix.join(prefix, entry.name);
            if (entry.isDirectory()) walk(path.join(dir, entry.name), child);
            else if (entry.isFile()) out.push(child);
        }
    };
    let stat;
    try { stat = fs.statSync(abs); } catch (e) { return out; }
    if (stat.isFile()) return [rel];
    walk(abs, rel);
    return out.sort();
}

/** The files one frozen glob matches in the tree right now. */
function matchGlob(glob) {
    if (glob.endsWith('/**')) return filesUnder(glob.slice(0, -3));
    const star = glob.indexOf('*');
    if (star === -1) {
        const abs = path.join(REPO_ROOT, glob);
        return (fs.existsSync(abs) && fs.statSync(abs).isFile()) ? [glob] : [];
    }
    // A single `*` inside one directory segment, which is all the list uses:
    // a flat read of that directory, never a recursive walk, because the point
    // of `src/*_activation.js` is precisely that the file is at the TOP level.
    const dir = path.posix.dirname(glob);
    const base = path.posix.basename(glob);
    const re = new RegExp(`^${base.split('*').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    let entries;
    try { entries = fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }); } catch (e) { return []; }
    return entries.filter((e) => e.isFile() && re.test(e.name))
        .map((e) => path.posix.join(dir, e.name)).sort();
}

/**
 * The SHARED_GATES module basenames, read out of the module itself.
 *
 * Read as TEXT rather than required, so the check still answers on a tree that
 * carries no node_modules: the falsification run copies src/ and bin/ into a
 * scratch directory and nothing else, and a check that needed a module graph
 * could not be driven there at all.
 *
 * @returns {string[]} unique basenames in declaration order
 */
function sharedGateModules() {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/consensus_rules_digest.js'), 'utf8');
    const decl = /const SHARED_GATES = \[([\s\S]*?)\n\];/.exec(src);
    if (!decl) throw new Error('src/consensus_rules_digest.js no longer declares SHARED_GATES');
    const seen = [];
    for (const m of decl[1].matchAll(/^\s*\['([A-Za-z0-9_]+)'/gm)) {
        if (!seen.includes(m[1])) seen.push(m[1]);
    }
    if (!seen.length) throw new Error('SHARED_GATES declares no module: the derived half cannot be read');
    return seen;
}

/**
 * The bridge engine's activation basenames, read out of its loadActivation calls
 * for the same reason the gate list is read out of SHARED_GATES.
 *
 * @returns {string[]}
 */
function bridgeGateModules() {
    const abs = path.join(REPO_ROOT, 'src/cross_chain/bridge_engine.js');
    if (!fs.existsSync(abs)) return [];
    const src = fs.readFileSync(abs, 'utf8');
    return Array.from(new Set(Array.from(src.matchAll(/loadActivation\(\s*'([^']+)'/g)).map((m) => m[1])));
}

/** The frozen set as the tree spells it right now, glob by glob. */
function measure() {
    const byGlob = {};
    const all = new Set();
    for (const entry of FROZEN_GLOBS) {
        const matched = matchGlob(entry.glob);
        byGlob[entry.glob] = matched;
        for (const p of matched) if (!MOVABLE.has(p)) all.add(p);
    }
    return { byGlob, files: Array.from(all).sort() };
}

/**
 * Every way the tree can have broken the freeze, as one list of violations.
 * @returns {{violations: object[], measured: object, manifest: object|null}}
 */
function check() {
    const violations = [];
    const measured = measure();

    // Derived: every computed-require target resolves at the top level of src/.
    const carriers = Array.from(new Set(sharedGateModules().concat(bridgeGateModules())));
    for (const mod of carriers) {
        const rel = `src/${mod}.js`;
        if (fs.existsSync(path.join(REPO_ROOT, rel))) continue;
        // Say where it went when it can be found, because "missing" and "moved
        // one directory down" are the same bug with very different repairs.
        const found = filesUnder('src').filter((p) => path.posix.basename(p) === `${mod}.js`);
        violations.push({
            kind: 'carrier_not_resolvable',
            file: rel,
            foundAt: found,
            detail: `a computed require resolves './${mod}.js' from src/ and would catch the failure silently`,
        });
    }

    // Shaped: no activation module below the top level of src/.
    for (const rel of filesUnder('src')) {
        if (!/_activation\.js$/.test(path.posix.basename(rel))) continue;
        if (path.posix.dirname(rel) === 'src') continue;
        if (SHAPE_EXCEPTIONS.has(rel)) continue;
        violations.push({
            kind: 'activation_below_top_level',
            file: rel,
            detail: 'an activation module outside src/ cannot be reached by a computed require from src/',
        });
    }

    // Listed: the committed manifest, which is the only half that sees a rename
    // or a deletion.
    const manifestPath = path.join(REPO_ROOT, MANIFEST_REL);
    let manifest = null;
    if (fs.existsSync(manifestPath)) {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const have = new Set(measured.files);
        for (const rel of manifest.files || []) {
            if (have.has(rel)) continue;
            const stillThere = fs.existsSync(path.join(REPO_ROOT, rel));
            violations.push({
                kind: stillThere ? 'frozen_file_left_its_glob' : 'frozen_file_gone',
                file: rel,
                detail: stillThere
                    ? 'the path still exists but no frozen glob matches it any more'
                    : 'recorded frozen at the start of this pass and absent now',
            });
        }
    } else {
        violations.push({
            kind: 'manifest_missing',
            file: MANIFEST_REL,
            detail: 'nothing to compare against; run with --write to record it',
        });
    }

    return { violations, measured, manifest };
}

function parseArgs(argv) {
    const opts = { json: false, write: false };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--json') opts.json = true;
        else if (argv[i] === '--write') opts.write = true;
        else if (argv[i] === '--root') { opts.root = path.resolve(argv[i + 1]); i += 1; }
        else if (argv[i] === '--help' || argv[i] === '-h') opts.help = true;
        else return { error: `unknown argument: ${argv[i]}` };
    }
    return opts;
}

function main(argv) {
    const opts = parseArgs(argv);
    if (opts.error) { console.error(opts.error); return 2; }
    if (opts.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        return 0;
    }
    if (opts.root) setRepoRoot(opts.root);

    if (opts.write) {
        const measured = measure();
        const out = {
            recordedBy: 'bin/check-frozen-set.js --write',
            why: 'the paths frozen for this restructure, so a later tree can be checked against them',
            globs: FROZEN_GLOBS,
            movable: Array.from(MOVABLE).sort(),
            fileCount: measured.files.length,
            files: measured.files,
        };
        const dest = path.join(REPO_ROOT, MANIFEST_REL);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
        console.log(`frozen-set manifest written: ${MANIFEST_REL} (${out.fileCount} files)`);
        return 0;
    }

    const report = check();
    if (opts.json) {
        console.log(JSON.stringify({
            root: REPO_ROOT,
            violationCount: report.violations.length,
            violations: report.violations,
            frozenFileCount: report.measured.files.length,
        }, null, 2));
    } else {
        for (const v of report.violations) {
            const where = v.foundAt && v.foundAt.length ? ` (found at ${v.foundAt.join(', ')})` : '';
            console.log(`FROZEN ${v.kind}: ${v.file}${where}: ${v.detail}`);
        }
        console.log(`\nfrozen set: ${report.measured.files.length} files, ${report.violations.length} violation(s).`);
    }
    return report.violations.length ? 1 : 0;
}

if (require.main === module) {
    try {
        process.exit(main(process.argv.slice(2)));
    } catch (err) {
        console.error(`check-frozen-set: ${err.message}`);
        process.exit(2);
    }
}

module.exports = {
    check,
    measure,
    matchGlob,
    filesUnder,
    sharedGateModules,
    bridgeGateModules,
    setRepoRoot,
    repoRoot: () => REPO_ROOT,
    FROZEN_GLOBS,
    MANIFEST_REL,
    main,
};
