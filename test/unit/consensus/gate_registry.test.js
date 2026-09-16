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
 * src/consensus/gate_registry.js: the hub's activation registry. What is
 * pinned here is value neutrality at the conversion: every table a converted
 * carrier exports is exactly the registry row of the same key, every value
 * the rules digest names is a row, a miss throws naming the key instead of
 * reading null, get() hands out frozen rows while copy() hands out mutable
 * ones, and the venue lever arms the regtest entries from the environment
 * with the carriers' own grammar.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const registry = require('../../../src/consensus/gate_registry.js');
const crd      = require('../../../src/consensus_rules_digest.js');

const REGISTRY_PATH = path.resolve(__dirname, '../../../src/consensus/gate_registry.js');

// Every converted carrier, by stem: the 12 byte twins, the masked twin, the 5 value
// twins and the 3 carriers under names that are not _activation.
const CONVERTED = [
    'anchor_reward_activation', 'attest_relay_activation', 'attest_relay_reject_slot_activation',
    'checkpoint_commitment_activation', 'cross_chain_royalty_activation', 'mirror_admission_activation',
    'price_pair_activation', 'price_scale_activation', 'price_sig_tally_activation',
    'retraction_signing_activation', 'token_bridge_activation', 'token_policy_activation',
    'xchain_bridge_activation', 'attest_response_mirror_activation',
    'attest_responsible_widening_activation', 'attest_zero_conf_activation',
    'rollcall_activation', 'rollcall_gates_activation',
    'equivocation_header', 'snapshot_reorg_buffer', 'stake_weighted_quorum',
];

// A RegExp compares by source and flags; everything else by canonical JSON.
function same(a, b) {
    if (a instanceof RegExp || b instanceof RegExp) {
        return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
    }
    return crd.canonical(a) === crd.canonical(b);
}

function withEnv(name, value, fn) {
    const saved = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    try { return fn(); } finally {
        if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
    }
}

describe('src/consensus/gate_registry.js: the rows', function () {

    it('holds a row for every non-function export of every converted carrier, and nothing else of theirs', function () {
        const missing = [];
        const differing = [];
        for (const stem of CONVERTED) {
            const carrier = require('../../../src/' + stem + '.js');
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
                expect(typeof require('../../../src/' + mod + '.js')[name], mod + '.' + name).to.equal('function');
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

    it('carries the SHARED block between its two markers, once each', function () {
        const text = fs.readFileSync(REGISTRY_PATH, 'utf8');
        const begin = text.split('\n').filter((l) => l === '// SHARED-GATES BEGIN').length;
        const end   = text.split('\n').filter((l) => l === '// SHARED-GATES END').length;
        expect([begin, end]).to.deep.equal([1, 1]);
        expect(text.indexOf('// SHARED-GATES BEGIN')).to.be.below(text.indexOf('// SHARED-GATES END'));
    });
});

describe('src/consensus/gate_registry.js: the readers', function () {

    it('throws a RegistryMissError naming the key on a miss, from get, copy and rows alike', function () {
        for (const fn of [registry.get, registry.copy]) {
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

    it('exports no way to add a row after load', function () {
        expect(registry.addGate).to.equal(undefined);
        expect(Object.keys(registry).sort()).to.deep.equal(
            ['RegistryMissError', 'UNARMED', 'UNPINNED', 'addGate', 'copy', 'get', 'has', 'keys', 'rows']);
        expect(registry.UNARMED).to.equal(9999999999);
        expect(registry.UNPINNED).to.equal(null);
    });
});

describe('src/consensus/gate_registry.js: the venue lever', function () {

    const ROLLCALL = 'rollcall_activation.ROLLCALL_ACTIVATION';
    const ADMISSION = 'mirror_admission_activation.MIRROR_ADMISSION_ACTIVATION';
    const BARRIER = 'anchor_reward_activation.ANCHOR_ATTEST_BARRIER_ACTIVATION';

    it('keeps regtest UNPINNED when the variable is unset, off or malformed', function () {
        for (const v of [undefined, '', 'off', 'inert', 'no', 'later']) {
            withEnv('XC_ROLLCALL_REGTEST_ACTIVATION', v, () => {
                expect(registry.get(ROLLCALL).regtest, 'value ' + JSON.stringify(v)).to.equal(null);
            });
        }
    });

    it('arms regtest at the documented height on the armed words and at a given height on an integer', function () {
        for (const v of ['armed', 'GENESIS', ' on ', 'true', 'yes']) {
            withEnv('XC_ROLLCALL_REGTEST_ACTIVATION', v, () => {
                expect(registry.get(ROLLCALL).regtest, 'value ' + JSON.stringify(v))
                    .to.equal(registry.get('rollcall_activation.ROLLCALL_REGTEST_ARMED_HEIGHT'));
            });
        }
        withEnv('XC_ROLLCALL_REGTEST_ACTIVATION', '150', () => {
            expect(registry.get(ROLLCALL).regtest).to.equal(150);
            expect(registry.get(ROLLCALL).mainnet, 'the lever must not reach the held networks').to.equal(0);
            expect(registry.get(ROLLCALL).testnet).to.equal(151200);
        });
    });

    it('arms every regtest key of the admission family, the barrier included, from the one admission variable', function () {
        withEnv('XC_MIRROR_ADMISSION_ACTIVATION', '150', () => {
            const producer = registry.get(ADMISSION);
            for (const k of ['BTC:regtest', 'LTC:regtest', 'DOGE:regtest']) expect(producer[k], k).to.equal(150);
            expect(producer['BTC:testnet']).to.equal(null);
            expect(registry.copy(BARRIER).regtest).to.equal(150);
            expect(registry.get(ROLLCALL).regtest, 'the roll-call lever is a different variable').to.equal(null);
        });
    });

    it('reads the variable at each read, so a carrier re-required under a new environment sees it', function () {
        const id = require.resolve('../../../src/rollcall_gates_activation.js');
        const saved = require.cache[id];
        try {
            withEnv('XC_ROLLCALL_GATES_REGTEST_ACTIVATION', 'armed', () => {
                delete require.cache[id];
                expect(require('../../../src/rollcall_gates_activation.js').ROLLCALL_GATES_ACTIVATION.regtest).to.equal(0);
            });
        } finally {
            if (saved) require.cache[id] = saved; else delete require.cache[id];
        }
    });
});
