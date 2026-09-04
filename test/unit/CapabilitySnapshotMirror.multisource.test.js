'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// capability_snapshots mirror parity across every writer. StateCheckpointEngine
// was fixed (14e13ef) to select its just-persisted row back on the FULL widened
// uq_cap_snap (snapshot_block, capability, signing_pubkey, source); the four
// sibling writers kept the pubkey-only LIMIT 1 form, so a key delegated by two
// staking sources reached broadcastRow exactly once and mirror-reading verifiers
// tallied an under-counted stake denominator. Every case here forces the
// above-SWQ two-source scenario (regtest activation is 0) and asserts BOTH
// source rows reach the stream.

const assert = require('assert');
const { EventEmitter } = require('events');

const CrossChainCallEngine = require('../../src/CrossChainCallEngine.js');
const CrossChainDexEngine  = require('../../src/CrossChainDexEngine.js');
const AttestationRelay     = require('../../src/AttestationRelay.js');
const RetractionConsensus  = require('../../src/RetractionConsensus.js');

const BLOCK      = 970000;
const CAPABILITY = 'cross_chain';
const PK         = 'ab'.repeat(32);

// In-memory hub DB that honors the WIDENED uniqueness and, crucially, answers
// the select-back against whatever predicate the SQL actually declares. A stub
// that always filtered on source would pass with the pre-fix query too, which is
// the exact stub-based false green the finding's own risk note names.
function memDb() {
    let snapshots = [];
    return {
        snapshots,
        async doQuery(sql, params) {
            if (/^INSERT IGNORE INTO capability_snapshots/.test(sql)) {
                // The whole set arrives as ONE multi-row statement (that is what makes the
                // mirror write all-or-nothing), so walk the flattened params in groups of
                // five instead of destructuring a single row.
                for (let i = 0; i + 4 < params.length; i += 5) {
                    let [snapshot_block, capability, signing_pubkey, amount, source] = params.slice(i, i + 5);
                    source = source != null ? source : '';
                    if (!snapshots.some(r => r.snapshot_block === snapshot_block && r.capability === capability &&
                                             r.signing_pubkey === signing_pubkey && r.source === source))
                        snapshots.push({ id: snapshots.length + 1, snapshot_block, capability, signing_pubkey, amount, source });
                }
                return [];
            }
            if (/^SELECT \* FROM capability_snapshots/.test(sql)) {
                let sourceKeyed = /AND source = \?/.test(sql);
                return snapshots.filter(r => r.snapshot_block === params[0] && r.capability === params[1] &&
                                             r.signing_pubkey === params[2] &&
                                             (!sourceKeyed || r.source === params[3])).slice(0, 1);
            }
            return [];
        }
    };
}

// One pubkey, two sources, distinct weights: the only shape in which the defect
// is observable (below SWQ every row carries source='').
const TWO_SOURCE_SET = [
    { pubkey: PK, source: 'srcA', weight: '100' },
    { pubkey: PK, source: 'srcB', weight: '250' }
];

function makeHub(validators) {
    let db = memDb();
    let broadcaster = { rows: [], broadcastRow(ev) { this.rows.push(ev); }, broadcastDeletion() {} };
    let peerManager = new EventEmitter();
    peerManager.broadcast = () => {};
    let identity = { getPubkeyHex: () => PK };
    let hub = {
        db, network: 'regtest', p2pConfig: {},
        hubDbBroadcaster: broadcaster,
        identity, peerManager,
        getIdentity:    () => identity,
        getPeerManager: () => peerManager,
        capabilitySnapshot: {
            async getWeightSnapshot() {
                return { validators: validators.map(v => ({ pubkey: v.pubkey, source: v.source, weight: v.weight })), truncated: false };
            },
            async getSnapshot() {
                return { validators: validators.map(v => ({ pubkey: v.pubkey, amount: v.weight })) };
            }
        },
        _resolveBtcLatestBlock: async () => BLOCK
    };
    return { hub, db, broadcaster };
}

function mirroredSources(broadcaster) {
    return broadcaster.rows
        .filter(b => b.table === 'capability_snapshots')
        .map(b => b.row.source)
        .sort();
}

describe('capability_snapshots mirror: multi-source select-back parity @regression', function () {

    // Each writer persists one row per (source, pubkey) and must stream BOTH.
    // Pre-fix, `mirrored` was ['srcA', 'srcA'] on every one of these.
    const WRITERS = [
        { name: 'CrossChainCallEngine', persist: (hub) => new CrossChainCallEngine(hub)._persistCapabilitySnapshot(CAPABILITY, BLOCK, 'regtest') },
        { name: 'CrossChainDexEngine',  persist: (hub) => new CrossChainDexEngine(hub)._persistCapabilitySnapshot(CAPABILITY, BLOCK, 'regtest') },
        { name: 'AttestationRelay',     persist: (hub) => new AttestationRelay(hub)._persistCapabilitySnapshot(CAPABILITY, BLOCK, 'regtest') },
        { name: 'RetractionConsensus',  persist: (hub) => new RetractionConsensus(hub)._persistCapabilitySnapshot(CAPABILITY, BLOCK) }
    ];

    for (const w of WRITERS) {
        it(w.name + ' streams BOTH source rows of a delegated key', async function () {
            let { hub, db, broadcaster } = makeHub(TWO_SOURCE_SET);

            await w.persist(hub);

            let rows = db.snapshots.filter(r => r.capability === CAPABILITY && r.snapshot_block === BLOCK);
            assert.strictEqual(rows.length, 2, 'both source rows persisted');
            assert.deepStrictEqual(rows.map(r => r.source).sort(), ['srcA', 'srcB']);

            assert.deepStrictEqual(mirroredSources(broadcaster), ['srcA', 'srcB'],
                'both source rows reach the mirror stream (pre-fix this was the same row twice)');
        });

        it(w.name + ' select-back stays inert for a single-source key', async function () {
            let { hub, db, broadcaster } = makeHub([{ pubkey: PK, source: '', weight: '100' }]);

            await w.persist(hub);

            assert.strictEqual(db.snapshots.length, 1, 'one row per key below SWQ');
            assert.deepStrictEqual(mirroredSources(broadcaster), [''],
                "source='' still selects back and mirrors exactly once");
        });
    }
});
