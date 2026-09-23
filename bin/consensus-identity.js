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
 * The five numbers that say whether this build still applies the same rules as
 * the one before it. A restructure may move any file it likes; it may not move
 * one of these.
 *
 *   consensus_rules_digest    sha256 over the DECIDED VALUES of every gate in
 *                             SHARED_GATES, with the gate-by-gate preimage kept
 *                             beside it. Comparable across repos: it answers
 *                             "same rules?".
 *   gates_field_hash          sha256 of the GATES field this hub signs into a
 *                             ROLLCALL v1 epoch, which is
 *                             knownGateKeys().join(','). Built by gatesFor()
 *                             in rollcall/round.js and hashed by gatesHash()
 *                             in rollcall/rollcall_canonical.js.
 *   coin_consensus_pins       the coin registry's consensus hash for every
 *                             (coin, network) PAIR, not one number per network.
 *   hub_schema_version        the mirror-row schema every reader checks for
 *                             strict equality before applying a hub row.
 *   carrier_logic_digest      sha256 over the sorted id=hash lines of
 *                             bin/pins/carrier-logic.json, the token-stream pin
 *                             of every gate carrier's LOGIC. Read from the pin,
 *                             not the tree: the pin's own guard measures the tree.
 *
 * WHY THE GATES MAP IS PINNED AND NOT JUST THE DIGEST, and this is the whole
 * reason this script exists rather than a one-line hash. Two digests that differ
 * say nothing about what to fix; the map turns "the digest changed" into "these
 * gates changed", which is the sentence an operator can act on, and it is what
 * makes an environment-shifted digest diagnosable in one read (see ONE OF THE
 * FIVE below). The SIGNED wire field is knownGateKeys().join(','), built from
 * the key list alone, so it reads the same whether or not a carrier resolves.
 * That is why consensus_rules_digest takes each gate from the activation
 * registry, or a function-valued one from src/consensus/gates/<stem>_gate.js,
 * and THROWS naming the key when neither is there: this script then prints no
 * pin and exits 2 with that one line, so a moved carrier cannot hide inside a
 * well-formed digest. `<absent>` survives as the sentinel that module's
 * diffGates uses for a key a peer's map lacks, not as a value this build emits.
 *
 * WHY THE COIN PIN IS PER PAIR. The registry hash is consensusHash(tick,
 * network) in coins/index.js, and coins/consensus_pin.js has
 * CONSENSUS_CONFIG_PIN.mainnet null, so mainnet verification is a deliberate
 * skip and only the non-mainnet pairs are actually pinned today. One number per
 * network would average over three chains and hide a single moved chain; the
 * pair map cannot.
 *
 * WHY NO LEDGER READ. The indexer's copy of this tool takes a fifth reading
 * from its blocks table. The hub has no chain of its own to read: it is the
 * config oracle, so its identity is entirely code-derived and this script opens
 * no socket, reads no .env and needs no database.
 *
 * ONE OF THE FIVE IS NOT PURE, AND IT MATTERS FOR ANY PIN. The rules digest
 * hashes gate VALUES, and a regtest venue arms some gates from its own
 * environment rather than from a committed height, so the same build reports one
 * digest in a bare checkout and another inside a configured container. Two
 * readings have to be taken with the same environment to be comparable, and the
 * `gates` map is what turns a mismatch into a named gate instead of two opaque
 * hashes.
 *
 * USAGE
 *   node bin/consensus-identity.js                    human summary
 *   node bin/consensus-identity.js --json             the full pin on stdout
 *   node bin/consensus-identity.js --out <file>       write the pin as JSON
 *   node bin/consensus-identity.js --root <dir>       measure another checkout
 *   node bin/consensus-identity.js --assert-no-absent exit 1 if any gate reads
 *                                                     `<absent>`; a lost carrier
 *                                                     is the exit-2 refusal
 *                                                     above, flag or no flag
 *   node bin/consensus-identity.js --compare <pin>    diff a tree against a pin,
 *                                                     exit 1 on any difference
 *
 ********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// The checkout under measurement. A binding rather than a constant so `--root`
// can aim it at another hub worktree: several lanes of a restructure run at once
// in separate trees and each has to be able to take this reading against its own.
let REPO_ROOT = path.resolve(__dirname, '..');

const ABSENT = '<absent>';

/**
 * Measure `dir` instead of the checkout this script lives in.
 * @param {string} dir a hub checkout
 * @returns {string} the resolved root
 */
function setRepoRoot(dir) { REPO_ROOT = path.resolve(dir); return REPO_ROOT; }

/** A module of the measured checkout, by repo-relative path. */
function loadFromRepo(rel) {
    // Resolved against REPO_ROOT rather than required relatively, so --root
    // actually reaches the other tree instead of silently re-reading this one.
    return require(path.join(REPO_ROOT, rel));
}

/**
 * The coin registry's consensus hash for every (coin, network) pair, plus which
 * pairs carry an armed CONSENSUS_CONFIG_PIN to be checked against.
 *
 * @returns {{pairs: object, pinnedNetworks: string[], unpinnedNetworks: string[]}}
 */
function coinConsensusPins() {
    const coins = loadFromRepo('src/coins/index.js');
    const { CONSENSUS_CONFIG_PIN } = loadFromRepo('src/coins/consensus_pin.js');

    const pairs = {};
    for (const network of coins.NETWORKS) {
        for (const tick of coins.ALLOWED_COINS) {
            pairs[`${tick}:${network}`] = coins.consensusHash(tick, network);
        }
    }
    const pinned = [];
    const unpinned = [];
    for (const network of coins.NETWORKS) {
        // A null pin is a deliberate skip, not a missing value: mainnet arms in a
        // coordinated release, and recording the distinction keeps a later reader
        // from treating the skip as a drift.
        (CONSENSUS_CONFIG_PIN[network] ? pinned : unpinned).push(network);
    }
    return { pairs, pinnedNetworks: pinned, unpinnedNetworks: unpinned };
}

/**
 * The five values, all of them derived from the source tree alone.
 * @returns {object}
 */
function codeIdentity() {
    const rulesModule = loadFromRepo('src/consensus_rules_digest.js');
    const { HUB_SCHEMA_VERSION } = loadFromRepo('src/hub_schema_version.js');
    const logicPin = loadFromRepo('bin/lib/carrier_logic_pin.js');
    // The measured checkout's registry, whose exported canonicaliser consensusHash uses.
    const coins = loadFromRepo('src/coins/index.js');

    const rules = rulesModule.computeConsensusRulesDigest();
    // The GATES field verbatim, because the hash alone cannot be checked by hand
    // against a wire capture and this is the string the hub signs.
    const gatesField = rulesModule.knownGateKeys().join(',');
    const coinPins = coinConsensusPins();

    const absentGates = Object.keys(rules.gates).filter((k) => rules.gates[k] === ABSENT).sort();

    return {
        consensus_rules_digest: rules.digest,
        // The gate-by-gate preimage. See WHY THE GATES MAP IS PINNED: without it
        // a digest mismatch cannot be traced to the gate that moved.
        consensus_rules_gates: rules.gates,
        gate_key_count: Object.keys(rules.gates).length,
        absent_gates: absentGates,
        gates_field: gatesField,
        gates_field_hash: crypto.createHash('sha256').update(gatesField, 'utf8').digest('hex'),
        coin_consensus_pins: coinPins.pairs,
        coin_consensus_pin_hash: crypto.createHash('sha256').update(coins.canonicalJson(coinPins.pairs)).digest('hex'),
        coin_pin_armed_networks: coinPins.pinnedNetworks,
        coin_pin_skipped_networks: coinPins.unpinnedNetworks,
        hub_schema_version: HUB_SCHEMA_VERSION,
        carrier_logic_digest: logicPin.digest(logicPin.readPin(REPO_ROOT)),
    };
}

/**
 * Pin against tree, value by value. The gates map is compared gate by gate
 * rather than as one blob, because "the digest moved" is not actionable and
 * "these three gates stopped resolving" is.
 *
 * @param {object} pin a previously written identity
 * @param {object} fresh the identity of the tree under test
 * @returns {object[]} one entry per difference, empty when they agree
 */
function compare(pin, fresh) {
    const differences = [];
    const scalars = [
        'consensus_rules_digest', 'gates_field', 'gates_field_hash',
        'coin_consensus_pin_hash', 'hub_schema_version', 'gate_key_count', 'carrier_logic_digest',
    ];
    for (const key of scalars) {
        if (pin[key] !== fresh[key]) {
            differences.push({ kind: 'value', field: key, before: pin[key], after: fresh[key] });
        }
    }
    const gateKeys = Array.from(new Set(
        Object.keys(pin.consensus_rules_gates || {}).concat(Object.keys(fresh.consensus_rules_gates || {})),
    )).sort();
    for (const key of gateKeys) {
        const before = (pin.consensus_rules_gates || {})[key];
        const after = (fresh.consensus_rules_gates || {})[key];
        if (before === after) continue;
        differences.push({
            kind: after === undefined ? 'gate_dropped' : (before === undefined ? 'gate_added' : 'gate_value'),
            field: key,
            before: before === undefined ? null : before,
            after: after === undefined ? null : after,
        });
    }
    for (const pair of Array.from(new Set(
        Object.keys(pin.coin_consensus_pins || {}).concat(Object.keys(fresh.coin_consensus_pins || {})),
    )).sort()) {
        const before = (pin.coin_consensus_pins || {})[pair];
        const after = (fresh.coin_consensus_pins || {})[pair];
        if (before !== after) differences.push({ kind: 'coin_pin', field: pair, before: before || null, after: after || null });
    }
    return differences;
}

function parseArgs(argv) {
    const opts = { json: false, assertNoAbsent: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        // Refuse a missing value or a following flag: consumed as a path, `--out
        // --assert-no-absent` would drop the assertion and exit 0.
        const takeValue = () => {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('-')) throw new Error(`${arg} requires a value`);
            i += 1;
            return value;
        };
        if (arg === '--json') opts.json = true;
        else if (arg === '--assert-no-absent') opts.assertNoAbsent = true;
        else if (arg === '--root') opts.root = path.resolve(takeValue());
        else if (arg === '--out') opts.out = path.resolve(takeValue());
        else if (arg === '--compare') opts.compare = path.resolve(takeValue());
        else if (arg === '--help' || arg === '-h') opts.help = true;
        // A misspelt flag would otherwise run as the default reading and exit 0,
        // which a caller checking --assert-no-absent would take as a pass.
        else throw new Error(`unknown flag ${argv[i]}`);
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

    const identity = codeIdentity();

    if (opts.compare) {
        const pin = JSON.parse(fs.readFileSync(opts.compare, 'utf8'));
        const differences = compare(pin, identity);
        if (!differences.length) {
            console.log(`consensus identity holds against ${opts.compare}`);
            return;
        }
        console.log(`${differences.length} difference(s) against ${opts.compare}:`);
        for (const d of differences) console.log(`  ${d.kind} ${d.field}: ${d.before} -> ${d.after}`);
        process.exitCode = 1;
        return;
    }

    if (opts.out) {
        fs.mkdirSync(path.dirname(opts.out), { recursive: true });
        fs.writeFileSync(opts.out, `${JSON.stringify(identity, null, 2)}\n`);
    }
    if (opts.json) {
        console.log(JSON.stringify(identity, null, 2));
    } else {
        console.log(`consensus_rules_digest:   ${identity.consensus_rules_digest}`);
        console.log(`gate keys:                ${identity.gate_key_count} (${identity.absent_gates.length} absent)`);
        console.log(`gates_field_hash:         ${identity.gates_field_hash}`);
        console.log(`coin_consensus_pin_hash:  ${identity.coin_consensus_pin_hash}`);
        for (const pair of Object.keys(identity.coin_consensus_pins).sort()) {
            console.log(`  ${pair.padEnd(22)}${identity.coin_consensus_pins[pair]}`);
        }
        console.log(`coin pins armed on:       ${identity.coin_pin_armed_networks.join(', ') || 'none'}`);
        console.log(`coin pins skipped on:     ${identity.coin_pin_skipped_networks.join(', ') || 'none'}`);
        console.log(`hub_schema_version:       ${identity.hub_schema_version}`);
        console.log(`carrier_logic_digest:     ${identity.carrier_logic_digest}`);
        if (opts.out) console.log(`\nwritten to ${opts.out}`);
    }

    if (opts.assertNoAbsent && identity.absent_gates.length) {
        // Loud and by name. An absent gate is the failure this whole script is
        // built around, and a silent exit code would be read as a passing run.
        console.error(`ABSENT GATES (${identity.absent_gates.length}): the digest is over a rules set this build `
            + 'has lost, while the signed GATES field is unchanged:');
        for (const key of identity.absent_gates) console.error(`  ${key}`);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    // Caught here rather than left to Node's default uncaught-exception handler,
    // which exits 1 with a raw stack. The indexer's copy of this tool already gives
    // a caller the contract this one now matches: exit 2, one clean line on stderr.
    try { main(); } catch (e) { console.error(`consensus-identity: ${e.message}`); process.exit(2); }
}

module.exports = {
    codeIdentity,
    coinConsensusPins,
    compare,
    setRepoRoot,
    // The measured checkout, as a call rather than a binding: a consumer that
    // captured the value at require time would keep reading the default after
    // --root moved it.
    repoRoot: () => REPO_ROOT,
    ABSENT,
};
