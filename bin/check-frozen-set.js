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
 * Is every file that may not move still where it was, and does every gate this
 * build judges still have its registry row? Exit 1 naming the file or the key if
 * not.
 *
 * WHY A CHECK AND NOT A CONVENTION, and this is the only reason it exists. Two
 * modules in this repo resolve consensus inputs by a NAME this build spells:
 *
 *   src/consensus_rules_digest.js  loadGateValue: every SHARED_GATES value is a
 *                                  registry row under '<module>.<EXPORT>'
 *                                  (src/consensus/gate_registry.js) and a miss
 *                                  THROWS at boot. The one legitimate miss is a
 *                                  name that is a FUNCTION on its carrier, which
 *                                  the loader requires by a path it COMPUTES from
 *                                  the module name. Before the registry, a miss
 *                                  read ABSENT: the digest was computed over a
 *                                  map in which a moved carrier's gate read
 *                                  absent while the SIGNED wire field,
 *                                  knownGateKeys().join(','), stayed byte for
 *                                  byte what every peer publishes: a rules fork
 *                                  that no wire field names.
 *   src/cross_chain/bridge_engine.js  loadActivation: the table as a registry row,
 *                                  read by the key the call spells. A miss throws
 *                                  at construction; it used to return null and
 *                                  idle the engine, by design and correctly, but
 *                                  for the wrong reason.
 *
 * A boot that throws is better than a digest that lies, and this check is better
 * than either: it refuses the move at the gate, before any process boots on it.
 * A restructure cannot be trusted to remember the computed paths and the spelled
 * keys; it can be made to run this.
 *
 * THE FOUR HALVES OF THE ANSWER, because no single one of them is enough:
 *
 *   derived   every SHARED_GATES '<module>.<EXPORT>' key and every key the bridge
 *             engine spells must be a row of the registry THIS TREE carries,
 *             read by loading src/consensus/gate_registry.js from the tree under
 *             test; a name with no row must be a FUNCTION on the carrier at the
 *             path the loader computes, read out of the loader's own expression.
 *             The lists are READ FROM THE MODULES, never restated here: a
 *             restated copy is a second registry, and the day it drifts is the
 *             day this check blesses the move it exists to refuse. A module every
 *             one of whose names is a row needs no file at all, which is what
 *             lets a consolidation delete the predicate-only twins and keep this
 *             check green.
 *   shaped    no *_activation.js may sit below the top level of src/, and no
 *             twin gate (a *_gate.js whose stem the registry holds rows for) may
 *             sit anywhere but src/consensus/gates/, bar the declared exceptions.
 *             This is what catches a gate carrier that no SHARED_GATES row names
 *             yet: the file is frozen the moment it is written, not the moment
 *             it is registered.
 *   listed    a committed manifest of every path the frozen globs matched when
 *             the pass began. The globs themselves cannot detect a deletion or a
 *             rename, because a glob over the tree always agrees with the tree.
 *             The manifest is the only half that does, and it is regenerated
 *             only by an explicit --write.
 *   pinned    every gate carrier's LOGIC still hashes to bin/pins/carrier-logic.json
 *             (bin/lib/carrier_logic_pin.js, a token-stream hash that ignores
 *             comments, whitespace and require paths). The three halves above
 *             see a file move; this one sees a function body change. --write
 *             here never touches that pin: only the pin module's own --write
 *             --reason may, so a re-pin always carries its record.
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
const vm   = require('vm');
const { execFileSync } = require('child_process');

const logicPin = require('./lib/carrier_logic_pin');

// The checkout under test. A binding rather than a constant so `--root` can aim
// it at another tree, which is what the falsification run does.
let REPO_ROOT = path.resolve(__dirname, '..');

const MANIFEST_REL = 'bin/pins/at1-frozen-set.json';

// The three modules the derived half reads, and the one directory a twin gate may
// live in: the same tail in every repo that carries a copy, so the byte compare
// between copies stays raw.
const DIGEST_REL   = 'src/consensus_rules_digest.js';
const REGISTRY_REL = 'src/consensus/gate_registry.js';
const BRIDGE_REL   = 'src/cross_chain/bridge_engine.js';
const GATES_DIR    = 'src/consensus/gates';

/**
 * The globs whose matches are frozen, with the reason each one is on the list.
 * Two shapes are frozen for two different reasons, and collapsing them would
 * lose the argument: the gate carriers are frozen because a computed require
 * resolves them or a sibling repo holds the same bytes, and the vendored trees
 * are frozen because six to ten other repos hold byte-identical copies kept in
 * step by a sync script. Both homes of a carrier are listed, the top of src/ it
 * had before the W5 layout and src/consensus/ it has after, so one list answers
 * on either tree: a glob that matches nothing freezes nothing, and the manifest
 * (the listed half) is what says which home the pass recorded.
 */
const FROZEN_GLOBS = [
    { glob: 'src/*_activation.js',        why: 'gate carriers at the top of src/: the twins before W5, the hub-only three after' },
    { glob: 'src/consensus/gates/*_gate.js', why: 'the logic-bearing twin gates, byte twins of the indexer copies at this one tail' },
    { glob: 'src/lib/fullnode_activation.js', why: 'a gate carrier that already sits outside the top level' },
    { glob: 'src/equivocation_header.js', why: 'a SHARED_GATES carrier under a name that is not _activation (its home before W5)' },
    { glob: 'src/snapshot_reorg_buffer.js', why: 'a SHARED_GATES carrier under a name that is not _activation (its home before W5)' },
    { glob: 'src/stake_weighted_quorum.js', why: 'a SHARED_GATES carrier under a name that is not _activation (its home before W5)' },
    { glob: 'src/consensus/equivocation_header.js', why: 'a SHARED_GATES carrier at its W5 home, a byte twin at this tail in every repo' },
    { glob: 'src/consensus/snapshot_reorg_buffer.js', why: 'a SHARED_GATES carrier at its W5 home, a byte twin at this tail in every repo' },
    { glob: 'src/consensus/stake_weighted_quorum.js', why: 'a SHARED_GATES carrier at its W5 home, a byte twin at this tail in every repo' },
    { glob: 'src/consensus_rules_digest.js', why: 'the module that computes the requires' },
    { glob: 'src/consensus/gate_registry.js', why: 'the registry every carrier, the digest and the bridge engine require by this one literal path' },
    { glob: 'src/consensus/gate_registry/**', why: 'the registry core and the SHARED block parts, byte twins the entry requires by literal path' },
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
 * Paths the shape rule forgives. src/lib/fullnode_activation.js is a hub-only
 * gate that already sat below the top level when the freeze began (D34).
 * src/attestation/attest_zero_conf_gate.js is the hub-OWNED zero-conf gate (D106):
 * its stem has registry rows, so it reads as a twin gate by name, but it is no
 * repo's twin (the hub adds assertZeroConfOrdering) and lives beside its first
 * requirer, src/attestation/round.js, by the first-requirer rule.
 * src/coins/fullnodeComment.test.js is a TEST file that this pass deliberately
 * moves out of src/, and it is not in sync-coins.sh's FILES list, so it is not a
 * vendored twin despite where it sits.
 */
const SHAPE_EXCEPTIONS = new Set([
    'src/lib/fullnode_activation.js',
    'src/attestation/attest_zero_conf_gate.js',
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
 * The SHARED_GATES declaration, read out of the digest module itself as
 * [{ module, names }] in declaration order, one entry per literal row.
 *
 * Read as TEXT rather than required, so the list is what the file SAYS and not
 * what a module graph resolved it to: the same file is read whether or not the
 * tree can load, and a declaration that stopped parsing is an error here rather
 * than an empty list read as clean. Comment lines are dropped first, because a
 * commented-out entry is not a declared one.
 *
 * @returns {{module: string, names: string[]}[]}
 */
function sharedGateEntries() {
    const src = fs.readFileSync(path.join(REPO_ROOT, DIGEST_REL), 'utf8');
    const decl = /const SHARED_GATES = \[([\s\S]*?)\n\];/.exec(src);
    if (!decl) throw new Error(`${DIGEST_REL} no longer declares SHARED_GATES`);
    const body = decl[1].replace(/^\s*\/\/.*$/gm, '');
    const entries = [];
    for (const m of body.matchAll(/\[\s*'([A-Za-z0-9_]+)'\s*,\s*\[([^\]]*)\]\s*\]/g)) {
        entries.push({ module: m[1], names: Array.from(m[2].matchAll(/'([A-Za-z0-9_]+)'/g), (n) => n[1]) });
    }
    if (!entries.length) throw new Error('SHARED_GATES declares no module: the derived half cannot be read');
    return entries;
}

/** The SHARED_GATES module basenames, unique, in declaration order. */
function sharedGateModules() {
    return Array.from(new Set(sharedGateEntries().map((e) => e.module)));
}

/** Every '<module>.<EXPORT>' key SHARED_GATES declares, unique, in declaration order. */
function sharedGateKeys() {
    const keys = new Set();
    for (const { module, names } of sharedGateEntries()) for (const name of names) keys.add(`${module}.${name}`);
    return Array.from(keys);
}

// Thrown by the sandbox stubs below the moment the loader names a path, so the
// loader's own path computation runs and nothing after it does.
const ASKED = Symbol('asked');

/**
 * Where the digest loader looks for a name that is a FUNCTION on its carrier,
 * for `mod`, repo-relative. The loader's own body (loadGateValue, read as text)
 * is run in a sandbox whose registry misses every key, whose fs and require
 * record the first path they are asked for, and whose __dirname is 'src', so the
 * check follows the loader wherever a layout points it (src/<mod>.js before the
 * W5 layout, src/consensus/gates/<stem>_gate.js after) and never restates the
 * path. Null when the loader is not there or asks for no file at all, in which
 * case a name without a row has nowhere to resolve.
 *
 * @param {string} mod a SHARED_GATES module basename
 * @returns {string|null}
 */
function carrierFallbackPath(mod) {
    const src = fs.readFileSync(path.join(REPO_ROOT, DIGEST_REL), 'utf8');
    const fn = /function loadGateValue\(mod, name\)\s*\{([\s\S]*?)\n\}/.exec(src);
    if (!fn) return null;
    let asked = null;
    const ask = (p) => { asked = p; throw ASKED; };
    const miss = () => { const e = new Error('sandbox miss'); e.name = 'RegistryMissError'; throw e; };
    const sandbox = { path: path.posix, __dirname: 'src', fs: { existsSync: ask }, require: ask,
        registry: { get: miss }, Error };
    try {
        vm.runInNewContext(`(function (mod, name) {${fn[1]}\n})(${JSON.stringify(mod)}, 'name')`, sandbox);
    } catch (e) {
        if (e !== ASKED) return null;
    }
    return asked;
}

/**
 * The registry keys the bridge engine spells, read out of its loadActivation calls
 * ('<module>', '<EXPORT>', ...) and out of every '<stem>_activation.<EXPORT>'
 * literal it holds, for the same reason the gate list is read out of SHARED_GATES.
 * Both spellings are read because the engine's shape changes at W5: the computed
 * require for a predicate goes with the predicate-only twins and the calls become
 * registry reads over the same keys, and the check must answer on either tree.
 *
 * @returns {string[]} unique keys in order of first appearance
 */
function bridgeGateKeys() {
    const abs = path.join(REPO_ROOT, BRIDGE_REL);
    if (!fs.existsSync(abs)) return [];
    const src = fs.readFileSync(abs, 'utf8');
    const keys = new Set();
    for (const m of src.matchAll(/loadActivation\(\s*'([A-Za-z0-9_]+)'\s*,\s*'([A-Z][A-Za-z0-9_]*)'/g)) keys.add(`${m[1]}.${m[2]}`);
    for (const m of src.matchAll(/'([a-z0-9_]+_activation\.[A-Z][A-Za-z0-9_]*)'/g)) keys.add(m[1]);
    return Array.from(keys);
}

/** The bridge engine's activation module basenames, unique, from bridgeGateKeys. */
function bridgeGateModules() {
    return Array.from(new Set(bridgeGateKeys().map((k) => k.split('.')[0])));
}

/**
 * Run `script` in a fresh node on the tree under test and hand back what it
 * printed as JSON. The registry and the carriers are loaded THERE, in their own
 * process, for two reasons: a module this process had already required would
 * answer from the require cache and never see the edit the check is asked about
 * (the test edits a scratch tree's registry and checks it again), and the tree
 * under test loads its own modules exactly as a boot on it would, with nothing
 * from this checkout's module graph leaking in. The tree needs no node_modules
 * for it: the registry parts and src/config.js require nothing beyond the tree,
 * which is what lets the falsification run copy src/ and bin/ alone into a
 * scratch directory and still be checked.
 *
 * @param {string} script node -e source; process.argv[1] is `arg`
 * @param {string} arg an absolute path handed to the script
 * @returns {{value: *}|{error: string}} the parsed output, or the failing line
 */
function probe(script, arg) {
    try {
        const out = execFileSync(process.execPath, ['-e', script, arg],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
        return { value: JSON.parse(out) };
    } catch (e) {
        // The message line of node's uncaught-error print ('<Name>Error: <message>'),
        // not the source excerpt above it, so the verdict names the row or module.
        const lines = String(e.stderr || '').trim().split('\n').filter(Boolean);
        return { error: lines.find((l) => /^[A-Za-z]*Error: /.test(l)) || lines[lines.length - 1] || e.message };
    }
}

/**
 * The keys of the registry the tree under test carries, or why they could not
 * be read. A registry that is not there or does not load is reported, never
 * read as an empty set: an empty set would make every key a miss, and an
 * unreadable registry made silent would make none.
 * @returns {{value: string[]}|{error: string}}
 */
function registryKeys() {
    const entry = path.join(REPO_ROOT, REGISTRY_REL);
    if (!fs.existsSync(entry)) return { error: `${REGISTRY_REL} is not there` };
    const got = probe('process.stdout.write(JSON.stringify(require(process.argv[1]).keys()))', entry);
    if (got.error) return got;
    if (!Array.isArray(got.value)) return { error: `${REGISTRY_REL} keys() returned no list` };
    return got;
}

/** The names a carrier at `rel` exports as FUNCTIONS, loaded on the tree under test. */
function functionExports(rel) {
    return probe('const m = require(process.argv[1]);'
        + 'process.stdout.write(JSON.stringify(Object.keys(m).filter((k) => typeof m[k] === "function")))',
    path.join(REPO_ROOT, rel));
}

/**
 * Pinned: every carrier-logic entry against the tree. A missing pin is a
 * violation, not a skip, for the same reason a missing manifest is.
 * @returns {object[]} violations
 */
function pinnedViolations() {
    if (!fs.existsSync(path.join(REPO_ROOT, logicPin.PIN_REL))) {
        return [{ kind: 'carrier_logic_pin_missing', file: logicPin.PIN_REL,
            detail: 'nothing to compare carrier logic against; run bin/lib/carrier_logic_pin.js --init --reason "<why>"' }];
    }
    const measured = logicPin.measure(REPO_ROOT, logicPin.readPin(REPO_ROOT));
    return Object.keys(measured).filter((id) => !measured[id].ok).map((id) => ({
        kind: 'carrier_logic_moved',
        file: measured[id].path,
        id,
        detail: measured[id].actual === null
            ? 'pinned carrier logic and the file is gone'
            : `the carrier's logic no longer hashes to its pin (${measured[id].expected.slice(0, 8)} pinned, ${measured[id].actual.slice(0, 8)} measured)`,
    }));
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
 * Derived, for one SHARED_GATES key the registry holds no row for: the name must
 * be a FUNCTION on the carrier at the path the loader computes. Anything else is
 * what the digest throws on at boot, reported here by kind so the repair is named:
 * no fallback declared, the carrier not where the loader looks (with where it
 * went, because "missing" and "moved one directory down" are the same bug with
 * very different repairs), the carrier there but not loading, or the carrier
 * loading without that function.
 *
 * @param {string} key '<module>.<EXPORT>'
 * @param {Map<string, object>} exportsByFile functionExports memo for this check
 * @returns {object[]} zero or one violation
 */
function carrierViolations(key, exportsByFile) {
    const [mod, name] = key.split('.');
    const rel = carrierFallbackPath(mod);
    if (!rel) {
        return [{ kind: 'gate_row_missing', file: DIGEST_REL, key,
            detail: 'no registry row and the loader declares no carrier fallback, so the digest throws at boot' }];
    }
    if (!fs.existsSync(path.join(REPO_ROOT, rel))) {
        const found = filesUnder('src').filter((p) => path.posix.basename(p) === path.posix.basename(rel));
        return [{ kind: 'carrier_not_resolvable', file: rel, key, foundAt: found,
            detail: `no registry row for '${key}' and the loader computes '${rel}' for its function, which is not there: the digest throws at boot` }];
    }
    if (!exportsByFile.has(rel)) exportsByFile.set(rel, functionExports(rel));
    const fns = exportsByFile.get(rel);
    if (fns.error) {
        return [{ kind: 'carrier_not_resolvable', file: rel, key, foundAt: [],
            detail: `the carrier is there but failed to load (${fns.error}), so the digest throws at boot` }];
    }
    if (!fns.value.includes(name)) {
        return [{ kind: 'carrier_export_missing', file: rel, key,
            detail: `no registry row for '${key}' and the carrier exports no function '${name}', so the digest throws at boot` }];
    }
    return [];
}

/**
 * Derived: every SHARED_GATES key and every bridge key resolves on this tree,
 * through the registry the tree carries. The registry is loaded once per check
 * and the answer is a list of violations plus the counts the --json verdict
 * prints, so an operator can see the derived half measured something.
 *
 * @returns {{violations: object[], rows: string[]|null, sharedGateKeys: number, bridgeKeys: number}}
 */
function derivedViolations() {
    const violations = [];
    const shared = sharedGateKeys();
    const bridge = bridgeGateKeys();
    const reg = registryKeys();
    if (reg.error) {
        violations.push({ kind: 'registry_unreadable', file: REGISTRY_REL,
            detail: `${reg.error}: no gate key can be resolved, so the derived half cannot answer` });
        return { violations, rows: null, sharedGateKeys: shared.length, bridgeKeys: bridge.length };
    }
    const rows = new Set(reg.value);
    const exportsByFile = new Map();
    for (const key of shared) {
        if (!rows.has(key)) violations.push(...carrierViolations(key, exportsByFile));
    }
    for (const key of bridge) {
        if (rows.has(key)) continue;
        violations.push({ kind: 'bridge_row_missing', file: BRIDGE_REL, key,
            detail: `the bridge engine reads registry row '${key}' and this tree's registry holds none, so the engine throws at construction` });
    }
    return { violations, rows: reg.value, sharedGateKeys: shared.length, bridgeKeys: bridge.length };
}

/**
 * The stems the tree knows as gates, '<stem>' of every '<stem>_activation' the
 * registry holds rows for, SHARED_GATES names or the bridge engine spells. A
 * *_gate.js with one of these stems is a twin gate; the hub's own auth_gate.js
 * and cosign_gate.js have no such rows and are not gates in this sense.
 * @param {string[]} rowKeys the registry's keys, empty when it could not be read
 * @returns {Set<string>}
 */
function gateStems(rowKeys) {
    const stems = new Set();
    const modules = rowKeys.map((k) => k.split('.')[0]).concat(sharedGateModules(), bridgeGateModules());
    for (const mod of modules) if (mod.endsWith('_activation')) stems.add(mod.slice(0, -'_activation'.length));
    return stems;
}

/**
 * Shaped: no activation module below the top level of src/, and no twin gate
 * anywhere but GATES_DIR, bar the declared exceptions.
 * @param {string[]} rowKeys the registry's keys, empty when it could not be read
 * @returns {object[]} violations
 */
function shapedViolations(rowKeys) {
    const violations = [];
    const stems = gateStems(rowKeys);
    for (const rel of filesUnder('src')) {
        if (SHAPE_EXCEPTIONS.has(rel)) continue;
        const base = path.posix.basename(rel);
        const dir = path.posix.dirname(rel);
        if (/_activation\.js$/.test(base) && dir !== 'src') {
            violations.push({ kind: 'activation_below_top_level', file: rel,
                detail: 'an activation module outside src/ cannot be reached by a computed require from src/' });
        } else if (/_gate\.js$/.test(base) && dir !== GATES_DIR && stems.has(base.slice(0, -'_gate.js'.length))) {
            violations.push({ kind: 'gate_outside_gates_dir', file: rel,
                detail: `a twin gate lives only at ${GATES_DIR}/${base}, the one tail every repo's copy shares` });
        }
    }
    return violations;
}

/**
 * Listed: the committed manifest against the measured set, which is the only
 * half that sees a rename or a deletion.
 * @param {string[]} files the measured frozen set
 * @returns {{violations: object[], manifest: object|null}}
 */
function listedViolations(files) {
    const violations = [];
    const manifestPath = path.join(REPO_ROOT, MANIFEST_REL);
    if (!fs.existsSync(manifestPath)) {
        violations.push({ kind: 'manifest_missing', file: MANIFEST_REL,
            detail: 'nothing to compare against; run with --write to record it' });
        return { violations, manifest: null };
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const have = new Set(files);
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
    return { violations, manifest };
}

/**
 * Every way the tree can have broken the freeze, as one list of violations in
 * the order of the halves: derived, shaped, listed, pinned.
 * @returns {{violations: object[], measured: object, manifest: object|null, derived: object}}
 */
function check() {
    const measured = measure();
    const derived = derivedViolations();
    const shaped = shapedViolations(derived.rows || []);
    const listed = listedViolations(measured.files);
    const violations = derived.violations.concat(shaped, listed.violations, pinnedViolations());
    return { violations, measured, manifest: listed.manifest, derived: {
        registryKeys: derived.rows ? derived.rows.length : null,
        sharedGateKeys: derived.sharedGateKeys,
        bridgeKeys: derived.bridgeKeys } };
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
        // The manifest only. The carrier-logic pin has its own --write with a
        // mandatory --reason, and regenerating it here would bypass that record.
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
            derived: report.derived,
        }, null, 2));
    } else {
        for (const v of report.violations) {
            const where = v.foundAt && v.foundAt.length ? ` (found at ${v.foundAt.join(', ')})` : '';
            const key = v.key ? ` [${v.key}]` : '';
            console.log(`FROZEN ${v.kind}: ${v.file}${key}${where}: ${v.detail}`);
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
    sharedGateEntries,
    sharedGateModules,
    sharedGateKeys,
    carrierFallbackPath,
    bridgeGateKeys,
    bridgeGateModules,
    registryKeys,
    derivedViolations,
    shapedViolations,
    listedViolations,
    pinnedViolations,
    setRepoRoot,
    repoRoot: () => REPO_ROOT,
    FROZEN_GLOBS,
    MANIFEST_REL,
    main,
};
