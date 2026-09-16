/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The consumer's activation registry core: rows, sentinels and the one
 * generic predicate.
 *
 * A row is (key, value). The key is literal data in the `<stem>.<EXPORT>`
 * spelling the rules digest and the signed GATES field already use, never
 * derived from where a file lives, so a module can move without a row moving.
 * The value is a gate's table of thresholds or a constant.
 *
 * This is the CONSUMER core: the reader half of xchain-indexer's
 * src/protocol_changes/core.js with the same semantics for get(), copy(),
 * has(), keys(), rows() and activeAt(), and the same addGate() validation,
 * minus the ProtocolChanges time table the indexer alone keeps. The same
 * bytes sit in xchain-sync, xchain-explorer and xchain-sdk, so a shim vendored
 * byte-identical across the repos behaves the same whichever registry backs it.
 *
 * Only the part files beside this one call addGate(); every other module
 * reads. A miss THROWS, because a row a build lacks is a build defect and not
 * a network state, and a null answer would let a moved carrier read as "not
 * yet active". Every read passes through one overlay hook, which is where
 * shared_rows.js applies a regtest venue's arming at the moment of the read
 * (see setReadOverlay).
 *
 * The core requires nothing, so no feature module can form a cycle with it.
 *
 ********************************************************************/

'use strict';

// Key grammar, the one the indexer's canonicaliser spells. The first segment
// admits upper case because today's module stems do, and the key must be
// today's spelling, the same one knownGateKeys() uses in the rules digest.
const KEY_RE = /^[A-Za-z0-9_/-]+(\.[A-Za-z0-9_]+)+$/;

// The house sentinel for a gate whose instant or height the operator has not
// named yet: a real number (year 2286), so it never fires before then and so
// the fingerprint tells it apart from UNPINNED. Never write the bare literal.
const UNARMED = 9999999999;

// A network the gate has not been ratified for at all. Never active: the
// predicate below refuses a null threshold explicitly, because `0 >= null` is
// true in JavaScript and would arm the gate at genesis.
const UNPINNED = null;

// The five row kinds addGate() accepts. `height` and `time` compare a block
// height or block time against the table; `epoch` is a BTC epoch height
// (the roll-call shape); `ruleset` is a version-keyed table of heights (the
// train shape); `constant` is any canonicalisable value with no predicate.
const UNITS = Object.freeze(['height', 'time', 'epoch', 'ruleset', 'constant']);

class RegistryMissError extends Error {
    constructor(key) {
        super('activation registry has no row ' + JSON.stringify(key));
        this.name = 'RegistryMissError';
        this.key = key;
    }
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

// A frozen deep copy of plain data, so a part file's literal cannot be edited
// through the registry and the registry cannot be edited through the literal.
function frozenCopy(value) {
    if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
    if (!isPlainObject(value)) return value;
    const out = {};
    for (const k of Object.keys(value)) out[k] = frozenCopy(value[k]);
    return Object.freeze(out);
}

// The mutable mirror of frozenCopy(): the same walk, nothing frozen.
function mutableCopy(value) {
    if (Array.isArray(value)) return value.map(mutableCopy);
    if (!isPlainObject(value)) return value;
    const out = {};
    for (const k of Object.keys(value)) out[k] = mutableCopy(value[k]);
    return out;
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

// '<COIN>:<network>' first, then the bare network key, the resolution order
// every coin-keyed activation module uses today. Own properties only: the
// network name comes off configuration, and an inherited member such as
// `constructor` must read as absent, not as a threshold.
function resolveThreshold(table, network, coin) {
    if (coin !== null && coin !== undefined && hasOwn(table, coin + ':' + network)) return table[coin + ':' + network];
    return hasOwn(table, network) ? table[network] : undefined;
}

// The parse-and-fail-closed body of the predicates, written once. An
// unparseable clock, an absent network, UNPINNED and an unknown network all
// read as inactive; UNARMED is a number and reads as inactive until 2286.
function reached(threshold, clock) {
    const c = parseInt(clock);
    if (!Number.isFinite(c)) return false;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold)) return false;
    return c >= threshold;
}

function checkKey(key, where) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) {
        throw new Error(where + ': key ' + JSON.stringify(key) + ' does not match the key grammar ' + String(KEY_RE));
    }
}

// A threshold table is a plain object whose entries are heights or instants
// (a finite number, UNARMED included) or UNPINNED; a ruleset table nests one
// such object per version. Anything else is refused at registration.
function checkTable(key, unit, table) {
    if (!isPlainObject(table)) throw new Error('addGate: ' + key + ' table must be a plain object of network keys');
    const leaves = unit === 'ruleset' ? Object.values(table) : [table];
    for (const leaf of leaves) {
        if (!isPlainObject(leaf)) throw new Error('addGate: ' + key + ' ruleset table must map versions to network tables');
        for (const [network, v] of Object.entries(leaf)) {
            if (v === UNPINNED || (typeof v === 'number' && Number.isFinite(v))) continue;
            throw new Error('addGate: ' + key + ' entry ' + network + ' must be a finite number or UNPINNED, got ' + JSON.stringify(v));
        }
    }
}

// What the indexer's canonicaliser refuses, refused here at registration for
// the same reason: a value the fingerprint cannot serialise by value (a
// function, a class instance, a Map, a Set, a Date, a BigInt, a non-finite
// number, an undefined) has no meaning as a row. The hub carries no copy of
// that canonicaliser, so the acceptance set is restated as a walk.
function checkValue(key, value, where) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('addGate: ' + key + ' refused non-finite number at ' + where);
        return;
    }
    if (value instanceof RegExp) return;
    if (Array.isArray(value)) {
        value.forEach((v, i) => checkValue(key, v, where + '[' + i + ']'));
        return;
    }
    if (!isPlainObject(value)) throw new Error('addGate: ' + key + ' refused ' + (typeof value === 'object' ? 'class instance' : typeof value) + ' at ' + where);
    for (const k of Object.keys(value)) {
        if (value[k] === undefined) continue;
        checkValue(key, value[k], where + '.' + k);
    }
}

class GateRegistry {
    constructor() {
        // key -> { unit, value }, in insertion order; a Map so no action name
        // off the wire can ever resolve to an inherited member.
        this.entries = new Map();
        // (key, committed value) -> the value a reader sees. Null until
        // registerRows() installs the regtest arming, which is applied here at
        // READ time so a module that reads a row when it loads sees the venue's
        // environment as it stands at that moment, exactly as its own literal
        // did, and the fingerprint sees it as it stands when it runs.
        this.overlay = null;
    }

    /**
     * Installs the one read overlay. Registration stays the committed table;
     * every read (get, copy, rows, activeAt) passes through `fn`.
     * @param {(key: string, value: *) => *} fn
     */
    setReadOverlay(fn) {
        if (typeof fn !== 'function') throw new Error('setReadOverlay: expected a function');
        this.overlay = fn;
    }

    // The one read path: the committed value through the overlay, or as is.
    read(key) {
        const row = this.entries.get(key);
        if (!row) throw new RegistryMissError(key);
        return this.overlay ? this.overlay(key, row.value) : row.value;
    }

    /**
     * Registers one gate or constant row.
     * @param {string} key   `<stem>.<EXPORT>` per the fingerprint key grammar
     * @param {string} unit  one of UNITS
     * @param {*} table      the threshold table (frozen copy stored), or for
     *                       `constant` any value the canonicaliser accepts
     */
    addGate(key, unit, table) {
        checkKey(key, 'addGate');
        if (this.entries.has(key)) throw new Error('addGate: duplicate key ' + key);
        if (!UNITS.includes(unit)) throw new Error('addGate: ' + key + ' unit must be one of ' + UNITS.join('|') + ', got ' + JSON.stringify(unit));
        if (unit !== 'constant') checkTable(key, unit, table);
        checkValue(key, table, '$');
        this.entries.set(key, { unit, value: frozenCopy(table) });
    }

    has(key) { return this.entries.has(key); }

    /** @returns {*} the row's value; throws RegistryMissError on a miss (never null). */
    get(key) {
        return this.read(key);
    }

    /**
     * The row's value as a fresh MUTABLE deep copy (primitives and RegExps as
     * they are); throws RegistryMissError on a miss. For a module that owned a
     * plain table before the registry and whose tests patch it: the copy is the
     * module's to mutate, the stored row never moves.
     * @returns {*}
     */
    copy(key) {
        return mutableCopy(this.get(key));
    }

    /** @returns {string} the row's unit; throws RegistryMissError on a miss. */
    unitOf(key) {
        const row = this.entries.get(key);
        if (!row) throw new RegistryMissError(key);
        return row.unit;
    }

    keys() { return [...this.entries.keys()]; }

    /** @returns {Array<[string, *]>} every row in insertion order, the fingerprint's input. */
    rows() { return [...this.entries.keys()].map((key) => [key, this.read(key)]); }

    /**
     * The one generic predicate. Resolves the coin key before the network key
     * and applies the unit: `height` and `epoch` compare `height`, `time`
     * compares `time`. `ruleset` needs the version this signature lacks and
     * `constant` rows have no predicate, so those throw.
     * @param {string} key
     * @param {string} network        mainnet|testnet|regtest
     * @param {string|null} coin      BTC|LTC|DOGE, or null for a network-only lookup
     * @param {number|string} height  block height (or the epoch height for `epoch`)
     * @param {number|string} time    block time
     * @returns {boolean}
     */
    activeAt(key, network, coin, height, time) {
        const row = this.entries.get(key);
        if (!row) throw new RegistryMissError(key);
        if (row.unit !== 'height' && row.unit !== 'epoch' && row.unit !== 'time') {
            throw new Error('activeAt: unsupported unit ' + row.unit + ' for ' + key);
        }
        if (typeof network !== 'string') return false;
        const threshold = resolveThreshold(this.read(key), network, coin);
        return reached(threshold, row.unit === 'time' ? time : height);
    }
}

function createRegistry() { return new GateRegistry(); }

// The one registry this process reads. The entry (../gate_registry.js) fills
// it from the part files once, at its own load, and exports the readers.
const registry = createRegistry();

module.exports = { UNARMED, UNPINNED, UNITS, KEY_RE, GateRegistry, RegistryMissError, createRegistry, registry };
