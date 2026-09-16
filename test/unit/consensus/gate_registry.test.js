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
 * test/unit/consensus/gate_registry.test.js
 *
 * src/consensus/gate_registry.js and the files under gate_registry/: the
 * hub's activation registry. What is pinned here is value neutrality at the
 * conversion: every table a converted carrier exports is exactly the registry
 * row of the same key, every value the rules digest names is a row, a miss
 * throws naming the key instead of reading null, get() hands out frozen rows
 * while copy() hands out mutable ones, the venue's regtest arming is applied
 * when a row is read (D78: the environment as it stands at that moment, with
 * no registry purge), the block lives in the part files and nowhere else,
 * and every part file is a byte twin of the indexer's.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const registry = require('../../../src/consensus/gate_registry.js');
const crd      = require('../../../src/consensus_rules_digest.js');

const SRC          = path.resolve(__dirname, '../../../src');
const ENTRY_PATH   = path.join(SRC, 'consensus', 'gate_registry.js');
const PARTS_DIR    = path.join(SRC, 'consensus', 'gate_registry');
const PARTS        = ['shared_rows_1.js', 'shared_rows_2.js', 'shared_rows_3.js', 'shared_rows_4.js', 'shared_rows_5.js'];
// The files under gate_registry/ that are byte twins of the indexer's
// src/protocol_changes/ files of the same name (core.js is the consumer core,
// authored here, so it is the one file with no indexer twin).
const TWINS        = ['regtest_env.js', 'shared_rows.js'].concat(PARTS);
const INDEXER_DIR  = process.env.XCHAIN_INDEXER_DIR || path.join(SRC, '..', '..', 'xchain-indexer');
const INDEXER_PARTS = path.join(INDEXER_DIR, 'src', 'protocol_changes');
const STRICT       = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// Every converted carrier that still has a logic module, by registry stem and the
// file it lives in since W5: the 7 gate twins under src/consensus/gates/, the
// hub-owned zero-conf gate, and the 3 carriers under names that are not
// _activation. The 10 predicate-only twins retired at W5 have no module left;
// their rows are covered by the twin-parts compare below and the registry tests.
const CONVERTED = [
    ['anchor_reward_activation', 'consensus/gates/anchor_reward_gate.js'],
    ['mirror_admission_activation', 'consensus/gates/mirror_admission_gate.js'],
    ['price_pair_activation', 'consensus/gates/price_pair_gate.js'],
    ['price_scale_activation', 'consensus/gates/price_scale_gate.js'],
    ['attest_responsible_widening_activation', 'consensus/gates/attest_responsible_widening_gate.js'],
    ['attest_zero_conf_activation', 'attestation/attest_zero_conf_gate.js'],
    ['rollcall_activation', 'consensus/gates/rollcall_gate.js'],
    ['rollcall_gates_activation', 'consensus/gates/rollcall_gates_gate.js'],
    ['equivocation_header', 'consensus/equivocation_header.js'],
    ['snapshot_reorg_buffer', 'consensus/snapshot_reorg_buffer.js'],
    ['stake_weighted_quorum', 'consensus/stake_weighted_quorum.js'],
];

// A RegExp compares by source and flags; everything else by canonical JSON.
function same(a, b) {
    if (a instanceof RegExp || b instanceof RegExp) {
        return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
    }
    return crd.canonical(a) === crd.canonical(b);
}

// The one loaded registry read through `fn` under `env` (one variable set, or
// cleared when the value is undefined), with the environment put back exactly
// as it was. No purge: the arming is applied at each read (D78), so the
// registry every suite holds answers for the venue as it stands now.
function bootedWith(name, value, fn) {
    const saved = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    try { return fn(registry); } finally {
        if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
    }
}

describe('src/consensus/gate_registry.js: the rows', function () {

    it('holds a row for every non-function export of every converted carrier, and nothing else of theirs', function () {
        this.timeout(10000);   // the first require of 11 carriers, mathjs included
        const missing = [];
        const differing = [];
        for (const [stem, file] of CONVERTED) {
            const carrier = require('../../../src/' + file);
            for (const name of Object.keys(carrier)) {
                if (typeof carrier[name] === 'function') {
                    expect(registry.has(stem + '.' + name), stem + '.' + name + ' is a function and must not be a row').to.equal(false);
                    continue;
                }
                if (!registry.has(stem + '.' + name)) { missing.push(stem + '.' + name); continue; }
                if (!same(carrier[name], registry.get(stem + '.' + name))) differing.push(stem + '.' + name);
            }
        }
        expect(missing, 'data exports with no registry row').to.deep.equal([]);
        expect(differing, 'a carrier export that is not its registry row: the conversion changed a value').to.deep.equal([]);
    });

    it('resolves every value the rules digest names, and only the admission functions are not rows', function () {
        const notRows = [];
        for (const [mod, names] of crd.SHARED_GATES) {
            for (const name of names) {
                if (registry.has(mod + '.' + name)) continue;
                notRows.push(mod + '.' + name);
                const file = CONVERTED.find(([stem]) => stem === mod);
                expect(file, mod + '.' + name + ' is not a row and its module has no file left').to.not.equal(undefined);
                expect(typeof require('../../../src/' + file[1])[name], mod + '.' + name).to.equal('function');
            }
        }
        expect(notRows.sort()).to.deep.equal([
            'mirror_admission_activation.admissionCanonicalField', 'mirror_admission_activation.decodeAdmitBlocks',
            'mirror_admission_activation.encodeAdmitBlocks', 'mirror_admission_activation.isAdmissionEra',
        ]);
    });

    it('spells every key in the fingerprint grammar, once', function () {
        const keys = registry.keys();
        expect(keys.length).to.equal(new Set(keys).size, 'a duplicate key');
        for (const k of keys) expect(k).to.match(/^[A-Za-z0-9_/-]+(\.[A-Za-z0-9_]+)+$/);
        expect(registry.rows().map(([k]) => k)).to.deep.equal(keys);
    });
});

describe('src/consensus/gate_registry.js: the layout', function () {

    it('keeps the SHARED block in the five part files, one marker pair each, and none in the entry', function () {
        const markers = (text) => [
            text.split('\n').filter((l) => l === '// SHARED-GATES BEGIN').length,
            text.split('\n').filter((l) => l === '// SHARED-GATES END').length,
        ];
        expect(markers(fs.readFileSync(ENTRY_PATH, 'utf8')), 'the entry carries no block of its own').to.deep.equal([0, 0]);
        for (const part of PARTS) {
            const text = fs.readFileSync(path.join(PARTS_DIR, part), 'utf8');
            expect(markers(text), part).to.deep.equal([1, 1]);
            expect(text.indexOf('// SHARED-GATES BEGIN'), part).to.be.below(text.indexOf('// SHARED-GATES END'));
            // A part is data: its one require is the queue beside it, nothing else.
            const requires = text.match(/require\([^)]*\)/g) || [];
            expect(requires, part + ' requires').to.deep.equal(["require('./shared_rows.js')"]);
        }
    });

    it('registers every queued row: the part files name exactly the keys the registry holds', function () {
        const queued = [];
        for (const part of PARTS) {
            const text = fs.readFileSync(path.join(PARTS_DIR, part), 'utf8');
            for (const m of text.matchAll(/^addGate\('([^']+)'/gm)) queued.push(m[1]);
        }
        expect(queued).to.deep.equal(registry.keys());
    });

    it('is byte-identical to the indexer twin, file for file under gate_registry/', function () {
        if (!fs.existsSync(path.join(INDEXER_PARTS, 'shared_rows_1.js'))) {
            if (STRICT) expect.fail('xchain-indexer sibling at ' + INDEXER_PARTS + ' carries no registry part files (set XCHAIN_INDEXER_DIR at a converted checkout)');
            this.skip();
            return;
        }
        const drifted = TWINS.filter((f) => !fs.readFileSync(path.join(PARTS_DIR, f)).equals(fs.readFileSync(path.join(INDEXER_PARTS, f))));
        expect(drifted, 'files under src/consensus/gate_registry/ that differ from xchain-indexer/src/protocol_changes/').to.deep.equal([]);
    });
});

describe('src/consensus/gate_registry.js: the readers', function () {

    it('throws a RegistryMissError naming the key on a miss, from get, copy and activeAt alike', function () {
        for (const fn of [registry.get, registry.copy, (k) => registry.activeAt(k, 'regtest', null, 0, 0)]) {
            expect(() => fn('no_such_module.NO_SUCH_EXPORT'))
                .to.throw(registry.RegistryMissError, 'no_such_module.NO_SUCH_EXPORT');
        }
        expect(registry.has('no_such_module.NO_SUCH_EXPORT')).to.equal(false);
    });

    it('hands out a frozen row from get() and a mutable, equal, distinct copy from copy()', function () {
        const key = 'checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION';
        const frozen = registry.get(key);
        const mutable = registry.copy(key);
        expect(Object.isFrozen(frozen)).to.equal(true);
        expect(Object.isFrozen(mutable)).to.equal(false);
        expect(mutable).to.not.equal(frozen);
        expect(mutable).to.deep.equal(frozen);
        mutable.regtest = 999;
        expect(registry.get(key).regtest, 'a copy edited in place must not reach the registry').to.equal(frozen.regtest);
    });

    it('judges activeAt by the unit, the coin key before the network key, and fails closed', function () {
        const bridge = 'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION';
        expect(registry.activeAt(bridge, 'regtest', 'BTC', 0, 0), 'regtest at genesis').to.equal(true);
        expect(registry.activeAt(bridge, 'testnet', 'BTC', 9999999998, 0), 'BTC:testnet below UNARMED').to.equal(false);
        expect(registry.activeAt(bridge, 'testnet', 'BTC', 9999999999, 0), 'BTC:testnet at UNARMED').to.equal(true);
        expect(registry.activeAt(bridge, 'devnet', 'BTC', 9999999999, 0), 'an unknown network').to.equal(false);
        expect(registry.activeAt(bridge, 'regtest', null, 'abc', 0), 'an unparseable height').to.equal(false);
        const rollcall = 'rollcall_activation.ROLLCALL_ACTIVATION';
        expect(registry.activeAt(rollcall, 'regtest', null, 0, 0), 'UNPINNED never arms, 0 >= null is a trap').to.equal(false);
        const time = 'price_scale_activation.PRICE_SCALE_ACTIVATION';
        expect(registry.activeAt(time, 'mainnet', null, 0, -1), 'a time row reads the time, not the height').to.equal(false);
        expect(registry.activeAt(time, 'mainnet', null, -1, 0)).to.equal(true);
        expect(() => registry.activeAt('anchor_reward_activation.ANCHOR_REWARD_AMOUNT', 'mainnet', null, 0, 0))
            .to.throw('unsupported unit constant');
    });

    it('refuses at registration what the fingerprint could not serialise: a function, a Date, a bad threshold, a duplicate', function () {
        const core = require('../../../src/consensus/gate_registry/core.js');
        const fresh = core.createRegistry();
        fresh.addGate('scratch.OK', 'height', { mainnet: 1, regtest: core.UNPINNED });
        expect(() => fresh.addGate('scratch.OK', 'height', { mainnet: 1 })).to.throw('duplicate key');
        expect(() => fresh.addGate('scratch.FN', 'constant', { f: function () {} })).to.throw('refused function');
        expect(() => fresh.addGate('scratch.DATE', 'constant', new Date(0))).to.throw('refused class instance');
        expect(() => fresh.addGate('scratch.NAN', 'constant', [NaN])).to.throw('refused non-finite number');
        expect(() => fresh.addGate('scratch.BAD', 'height', { mainnet: 'soon' })).to.throw('must be a finite number or UNPINNED');
        expect(() => fresh.addGate('scratch.UNIT', 'era', {})).to.throw('unit must be one of');
        expect(() => fresh.addGate('no dots', 'constant', 1)).to.throw('key grammar');
        expect(fresh.keys()).to.deep.equal(['scratch.OK']);
    });

    it('exports the readers, the two sentinels and the error, and no way to add a row after load', function () {
        expect(Object.keys(registry).sort()).to.deep.equal(
            ['RegistryMissError', 'UNARMED', 'UNPINNED', 'activeAt', 'copy', 'get', 'has', 'keys', 'rows']);
        expect(registry.UNARMED).to.equal(9999999999);
        expect(registry.UNPINNED).to.equal(null);
    });
});

describe('src/consensus/gate_registry.js: regtest arming from the environment', function () {

    const ROLLCALL  = 'rollcall_activation.ROLLCALL_ACTIVATION';
    const ADMISSION = 'mirror_admission_activation.MIRROR_ADMISSION_ACTIVATION';
    const BARRIER   = 'anchor_reward_activation.ANCHOR_ATTEST_BARRIER_ACTIVATION';

    it('keeps regtest UNPINNED when the variable is unset, off or malformed', function () {
        const heard = [];
        const listen = (w) => { if (w.name === 'RegtestArmingWarning') heard.push(w.message); };
        process.on('warning', listen);
        for (const v of [undefined, '', 'off', 'inert', 'no', 'later']) {
            bootedWith('XC_ROLLCALL_REGTEST_ACTIVATION', v, (fresh) => {
                expect(fresh.get(ROLLCALL).regtest, 'value ' + JSON.stringify(v)).to.equal(null);
            });
        }
        // The refused value said so as a process warning, the one channel a
        // registry that depends on no logger has; the accepted ones were silent.
        // The event fires on a later tick, so the check waits for it before the
        // listener goes.
        return new Promise((resolve) => setImmediate(resolve)).then(() => {
            process.removeListener('warning', listen);
            expect(heard, 'exactly one warning, for the malformed value').to.have.lengthOf(1);
            expect(heard[0]).to.match(/XC_ROLLCALL_REGTEST_ACTIVATION="later"/);
        });
    });

    it('arms regtest at the documented height on the armed words and at a given height on an integer', function () {
        for (const v of ['armed', 'GENESIS', ' on ', 'true', 'yes']) {
            bootedWith('XC_ROLLCALL_REGTEST_ACTIVATION', v, (fresh) => {
                expect(fresh.get(ROLLCALL).regtest, 'value ' + JSON.stringify(v))
                    .to.equal(fresh.get('rollcall_activation.ROLLCALL_REGTEST_ARMED_HEIGHT'));
            });
        }
        bootedWith('XC_ROLLCALL_REGTEST_ACTIVATION', '150', (fresh) => {
            expect(fresh.get(ROLLCALL).regtest).to.equal(150);
            expect(fresh.get(ROLLCALL).mainnet, 'the lever must not reach the held networks').to.equal(0);
            expect(fresh.get(ROLLCALL).testnet).to.equal(151200);
            expect(fresh.activeAt(ROLLCALL, 'regtest', null, 150, 0), 'activeAt judges the armed row').to.equal(true);
            expect(fresh.activeAt(ROLLCALL, 'regtest', null, 149, 0)).to.equal(false);
        });
    });

    it('arms every regtest key of the admission family, the barrier included, from the one admission variable', function () {
        bootedWith('XC_MIRROR_ADMISSION_ACTIVATION', '150', (fresh) => {
            const producer = fresh.get(ADMISSION);
            for (const k of ['BTC:regtest', 'LTC:regtest', 'DOGE:regtest']) expect(producer[k], k).to.equal(150);
            expect(producer['BTC:testnet']).to.equal(null);
            expect(fresh.copy(BARRIER).regtest).to.equal(150);
            expect(fresh.get(ROLLCALL).regtest, 'the roll-call lever is a different variable').to.equal(null);
        });
    });
});

describe('src/consensus/gate_registry.js: the arming follows the environment at each read', function () {

    const GATES = 'rollcall_gates_activation.ROLLCALL_GATES_ACTIVATION';

    it('a carrier re-required alone, with no registry purge, reads the venue as it stands now', function () {
        const before = registry.get(GATES).regtest;
        expect(before, 'the suite runs bare').to.equal(null);
        const saved = process.env.XC_ROLLCALL_GATES_REGTEST_ACTIVATION;
        process.env.XC_ROLLCALL_GATES_REGTEST_ACTIVATION = 'armed';
        const id = require.resolve('../../../src/consensus/gates/rollcall_gates_gate.js');
        const cached = require.cache[id];
        try {
            expect(registry.get(GATES).regtest, 'the loaded registry answers for the environment at the read').to.equal(0);
            delete require.cache[id];
            expect(require('../../../src/consensus/gates/rollcall_gates_gate.js').ROLLCALL_GATES_ACTIVATION.regtest,
                'a carrier re-required alone sees the armed table, as its own literal did').to.equal(0);
        } finally {
            if (cached) require.cache[id] = cached; else delete require.cache[id];
            if (saved === undefined) delete process.env.XC_ROLLCALL_GATES_REGTEST_ACTIVATION;
            else process.env.XC_ROLLCALL_GATES_REGTEST_ACTIVATION = saved;
        }
        expect(registry.get(GATES).regtest, 'restored, the bare reading is back').to.equal(before);
    });
});
