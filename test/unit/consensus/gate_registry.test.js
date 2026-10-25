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
 * and every block part file is a byte twin of the indexer's, while the one
 * hub-only part carries no block marker and is twinned nowhere.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const registry = require('../../../src/consensus/gate_registry.js');
const crd      = require('../../../src/consensus_rules_digest.js');
const { skipOrFail } = require('../../helpers/sibling_checkout.js');

const SRC          = path.resolve(__dirname, '../../../src');
const ENTRY_PATH   = path.join(SRC, 'consensus', 'gate_registry.js');
const PARTS_DIR    = path.join(SRC, 'consensus', 'gate_registry');
const PARTS        = ['shared_rows_1.js', 'shared_rows_2.js', 'shared_rows_3.js', 'shared_rows_4.js', 'shared_rows_5.js'];
// The rows this hub alone judges, queued after the block; not a twin, so it
// carries no SHARED-GATES markers and is graded apart from PARTS.
const HUB_PARTS    = ['hub_rows.js'];
// The files under gate_registry/ that are byte twins of the indexer's
// src/protocol_changes/ files of the same name (core.js is the consumer core,
// authored here, so it is the one file with no indexer twin).
const TWINS        = ['regtest_env.js', 'shared_rows.js'].concat(PARTS);
const INDEXER_DIR  = process.env.XCHAIN_INDEXER_DIR || path.join(SRC, '..', '..', 'xchain-indexer');
const INDEXER_TWIN_COMMIT = 'dba11b12847720481a9fa09ab0aedef670f9b893';

function indexerGit(ctx, what, args, encoding = null) {
    if (!fs.existsSync(path.join(INDEXER_DIR, '.git'))) {
        if (!skipOrFail(ctx, {
            usable: false,
            reason: 'sibling path absent: ' + INDEXER_DIR,
        }, what)) return null;
    }
    const read = () => execFileSync('git', ['-C', INDEXER_DIR].concat(args), {
        encoding,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
        return read();
    } catch (e) {
        // A CI sibling clone is depth 1, so the declared commit may be absent: fetch exactly that commit once.
        try {
            execFileSync('git', ['-C', INDEXER_DIR, 'fetch', '--quiet', '--depth=1', 'origin', INDEXER_TWIN_COMMIT], { stdio: 'ignore' });
            return read();
        } catch (e2) {
            throw new Error(what + ' cannot read declared indexer commit ' + INDEXER_TWIN_COMMIT);
        }
    }
}

function indexerTwinAtCommit(ctx, file, what) {
    return indexerGit(ctx, what, ['show', INDEXER_TWIN_COMMIT + ':src/protocol_changes/' + file]);
}

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

    it('keeps the hub-only rows outside the SHARED block: no markers, the same data-only shape', function () {
        for (const part of HUB_PARTS) {
            const text = fs.readFileSync(path.join(PARTS_DIR, part), 'utf8');
            expect(text.split('\n').filter((l) => /^\/\/ SHARED-GATES (BEGIN|END)$/.test(l)), part + ' markers').to.deep.equal([]);
            const requires = text.match(/require\([^)]*\)/g) || [];
            expect(requires, part + ' requires').to.deep.equal(["require('./shared_rows.js')"]);
            expect(text, part + ' holds at least one row').to.match(/^addGate\('/m);
        }
    });

    it('spells every dark threshold in the hub-only rows through UNARMED, never as a run of nines', function () {
        // Eight or more nines also catches a sentinel with a digit dropped, which would arm at a reachable height.
        for (const part of HUB_PARTS) {
            const live = fs.readFileSync(path.join(PARTS_DIR, part), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
            const offenders = live.split('\n').filter((line) => /9{8,}/.test(line));
            expect(offenders, part + ' writes the sentinel as a number').to.deep.equal([]);
        }
    });

    it('registers every queued row: the part files name exactly the keys the registry holds', function () {
        const queued = [];
        for (const part of PARTS.concat(HUB_PARTS)) {
            const text = fs.readFileSync(path.join(PARTS_DIR, part), 'utf8');
            for (const m of text.matchAll(/^addGate\('([^']+)'/gm)) queued.push(m[1]);
        }
        expect(queued).to.deep.equal(registry.keys());
    });
});

describe('src/consensus/gate_registry.js: the shared layout', function () {

    it('spells dark thresholds through UNARMED in the migrated shared row files', function () {
        const targets = {
            'shared_rows_1.js': [
                'archive_rollback_author_scope_activation.ARCHIVE_ROLLBACK_AUTHOR_SCOPE_ACTIVATION',
            ],
            'shared_rows_5.js': [
                'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION',
                'list_share_producer_activation.LIST_SHARE_PRODUCER_ACTIVATION',
                'list_share_consumer_activation.LIST_SHARE_CONSUMER_ACTIVATION',
                'list_meta_activation.LIST_META_ACTIVATION',
            ],
        };
        for (const [part, keys] of Object.entries(targets)) {
            const text = fs.readFileSync(path.join(PARTS_DIR, part), 'utf8');
            for (const key of keys) {
                const start = text.indexOf("addGate('" + key + "'");
                const end = text.indexOf('\n});', start);
                const live = text.slice(start, end + 4).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
                expect(start, part + ' contains ' + key).to.not.equal(-1);
                expect(end, part + ' terminates ' + key).to.not.equal(-1);
                expect(live, part + ':' + key + ' contains a bare UNARMED sentinel').to.not.match(/\b9999999999\b/);
                expect(live, part + ':' + key + ' uses UNARMED').to.match(/\bUNARMED\b/);
            }
        }
    });

    it('is byte-identical to the indexer twin, file for file under gate_registry/', function () {
        const what = 'the indexer registry part files twin guard';
        const drifted = TWINS.filter((f) => !fs.readFileSync(path.join(PARTS_DIR, f))
            .equals(indexerTwinAtCommit(this, f, what)));
        expect(drifted, 'files under src/consensus/gate_registry/ that differ from xchain-indexer/src/protocol_changes/').to.deep.equal([]);
    });

    // TWINS is a hand list, so hold it to both directory listings: a part added on
    // either side fails here until it is vendored and listed, never skipped silently.
    it('lists every indexer twin part in TWINS and leaves no file under gate_registry/ unclassified', function () {
        const what = 'the indexer registry part set guard';
        const listJs = (dir) => fs.readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isFile() && d.name.endsWith('.js')).map((d) => d.name).sort();
        const isTwinName = (f) => f === 'regtest_env.js' || /^shared_rows(_\d+)?\.js$/.test(f);
        const unclassified = listJs(PARTS_DIR).filter((f) => f !== 'core.js' && !HUB_PARTS.includes(f) && !TWINS.includes(f));
        const indexerParts = indexerGit(this, what, [
            'ls-tree', '--name-only', INDEXER_TWIN_COMMIT + ':src/protocol_changes',
        ], 'utf8').trim().split('\n').filter(Boolean).sort();
        expect(unclassified, 'files under src/consensus/gate_registry/ that are neither core.js, a hub-owned part nor in TWINS').to.deep.equal([]);
        expect(TWINS.slice().sort(), 'TWINS against the twin parts under xchain-indexer/src/protocol_changes/')
            .to.deep.equal(indexerParts.filter(isTwinName));
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
        expect(registry.activeAt(bridge, 'mainnet', 'BTC', 9999999998, 0), 'BTC:mainnet below UNARMED').to.equal(false);
        expect(registry.activeAt(bridge, 'mainnet', 'BTC', 9999999999, 0), 'BTC:mainnet at UNARMED').to.equal(true);
        expect(registry.activeAt(bridge, 'devnet', 'BTC', 9999999999, 0), 'an unknown network').to.equal(false);
        expect(registry.activeAt(bridge, 'regtest', null, 'abc', 0), 'an unparseable height').to.equal(false);
        const rollcall = 'rollcall_activation.ROLLCALL_ACTIVATION';
        expect(registry.activeAt(rollcall, 'regtest', null, 0, 0), 'UNPINNED never arms, 0 >= null is a trap').to.equal(false);
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

describe('src/consensus/gate_registry.js: the readers on an armed testnet slot', function () {
    // BTC:testnet has been armed since the v0.19.0 cut: the coin key wins over the bare
    // testnet fallback, which is still the sentinel, so an unlisted coin stays dark.
    it('judges activeAt by the coin key at and below its sized height, and reads the dark fallback for an unlisted coin', function () {
        const bridge = 'xchain_bridge_activation.XCHAIN_BRIDGE_ACTIVATION';
        const btcTestnet = registry.get(bridge)['BTC:testnet'];
        expect(btcTestnet, 'BTC:testnet is a sized height').to.be.a('number').below(9999999999);
        expect(registry.activeAt(bridge, 'testnet', 'BTC', btcTestnet - 1, 0), 'BTC:testnet one below its height').to.equal(false);
        expect(registry.activeAt(bridge, 'testnet', 'BTC', btcTestnet, 0), 'BTC:testnet at its height').to.equal(true);
        expect(registry.activeAt(bridge, 'testnet', 'BCH', btcTestnet, 0), 'an unlisted testnet coin reads the dark fallback').to.equal(false);
    });
});
