'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// SWQ-TRUNC-MIRROR IN COUNT MODE. Every writer refused a truncated set on the
// stake-weighted branch, but the resolvers rebuilt the COUNT set with a `.map(...)`
// that dropped the marker CapabilitySnapshot sets, so a capped count-mode set was
// mirrored in full. capability_snapshots has no completeness column, so an off-BTC
// verifier reads those partial rows as COMPLETE and clears a 2/3 bar over an
// under-counted stake denominator the writing hub itself rejects. These tests drive
// each writer's real persist path below the stake-weighted activation height and
// assert the mirror stays empty.

const sinon      = require('sinon');
const { expect } = require('chai');

const swq       = require('../../src/stake_weighted_quorum.js');
const snapWrite = require('../../src/lib/capability_snapshot_write.js');

const OracleConsensus       = require('../../src/OracleConsensus.js');
const StateCheckpointEngine = require('../../src/StateCheckpointEngine.js');
const CrossChainDexEngine   = require('../../src/CrossChainDexEngine.js');
const CrossChainCallEngine  = require('../../src/CrossChainCallEngine.js');
const RetractionConsensus   = require('../../src/RetractionConsensus.js');
const AttestationRelay      = require('../../src/AttestationRelay.js');
const PriceAggregator       = require('../../src/PriceAggregator.js');
const AttestationBatchPublisher = require('../../src/AttestationBatchPublisher.js');

// Count mode is only reachable BELOW a network's stake-weighted activation height, and
// mainnet is the one network whose height is not 0. The premise is asserted, not assumed:
// a moved activation height must show up as a failing premise rather than a vacuous pass.
const NETWORK = 'mainnet';
const BLOCK   = 900000;

// The indexer capped the qualifying set and marked it: these two rows are what SURVIVED
// the cap, so mirroring them publishes a set that is silently missing signers.
const RETAINED = [
    { pubkey: 'AA'.repeat(32), amount: '70' },
    { pubkey: 'bb'.repeat(32), amount: '20' }
];

// The weighted RPC rejects: a writer that took the stake-weighted branch would fail loudly
// instead of quietly proving the wrong half of the row.
const capStub = truncated => ({
    getSnapshot:       sinon.stub().resolves(countSnapshot(truncated)),
    getWeightSnapshot: sinon.stub().rejects(new Error('weighted path not taken'))
});

const countSnapshot = truncated => ({
    blockIndex: BLOCK,
    capability: 'cross_chain',
    truncated:  truncated,
    validators: RETAINED.map(v => Object.assign({}, v))
});

// Records what actually reached capability_snapshots. Only the INSERT matters here: the
// select-back is broadcast plumbing, and every writer is driven with no broadcaster.
function makeDb() {
    let inserts = [], rows = [];
    return {
        inserts, rows,
        doQuery: async function (sql, params) {
            if (/INSERT IGNORE INTO capability_snapshots/i.test(sql)) {
                inserts.push({ sql, params });
                for (let i = 0; i + 5 < params.length; i += 6)
                    rows.push({
                        snapshot_block: params[i], capability: params[i + 1],
                        signing_pubkey: params[i + 2], amount: params[i + 3], source: params[i + 4]
                    });
                return { affectedRows: rows.length };
            }
            return [];
        }
    };
}

// One entry per writer of capability_snapshots that owns its own resolver. Each is a real
// prototype instance carrying only the fields its persist path reads (the constructors want
// a live hub, peers and timers), so the resolver, the guard and the shared writer are the
// SHIPPED ones and a subclass rename would break the test rather than skip it.
const WRITERS = [
    ['OracleConsensus',       OracleConsensus,       'cross_chain', [BLOCK],
        cap => ({ hub: { capabilitySnapshot: cap, network: NETWORK, hubDbBroadcaster: null } })],
    ['StateCheckpointEngine', StateCheckpointEngine, 'cross_chain', [BLOCK],
        cap => ({ capSnapshot: cap, network: NETWORK, _broadcastRowOrResync: async () => {} })],
    ['CrossChainDexEngine',   CrossChainDexEngine,   'cross_chain', [BLOCK, NETWORK],
        cap => ({ capSnapshot: cap, broadcaster: null, _resolveBtcChainId: async () => null })],
    ['CrossChainCallEngine',  CrossChainCallEngine,  'cross_chain', [BLOCK, NETWORK],
        cap => ({ capSnapshot: cap, broadcaster: null, _resolveBtcChainId: async () => null })],
    ['RetractionConsensus',   RetractionConsensus,   'cross_chain', [BLOCK],
        cap => ({ capSnapshot: cap, network: NETWORK, broadcaster: null })],
    ['AttestationRelay',      AttestationRelay,      'cross_chain', [BLOCK, NETWORK],
        cap => ({ capSnapshot: cap, broadcaster: null })]
];

function instance(entry, db, capSnapshot) {
    const [, Klass, , , fields] = entry;
    return Object.assign(Object.create(Klass.prototype), { db }, fields(capSnapshot));
}

const persist = (entry, db, cap) =>
    instance(entry, db, cap)._persistCapabilitySnapshot(entry[2], ...entry[3]);

// The resolver on its own, so a reverted marker carry is named at its source rather than
// only through a writer. The resolvers take the network as an argument or off `this`.
const resolve = (entry, cap) =>
    instance(entry, null, cap)._resolveCapabilityValidators(
        entry[2], BLOCK, ...(entry[3].length > 1 ? [NETWORK] : []));

describe('capability_snapshots truncation parity (count mode)', function () {

    beforeEach(function () { sinon.stub(console, 'warn'); });
    afterEach(function () { sinon.restore(); });

    it('PREMISE: the block under test is genuinely below stake-weighted activation', function () {
        expect(swq.isStakeWeightedQuorumActive(BLOCK, NETWORK)).to.equal(false);
        expect(swq.isStakeWeightedQuorumActive(BLOCK, 'regtest')).to.equal(true);
    });

    for (const entry of WRITERS) {
        const name = entry[0];

        it('SECURITY: ' + name + ' persists NOTHING for a truncated COUNT-mode set', async function () {
            const db  = makeDb();
            const cap = capStub(true);

            await persist(entry, db, cap);

            expect(cap.getSnapshot.callCount).to.equal(1);          // the count RPC really ran
            expect(db.inserts).to.have.lengthOf(0);
            expect(db.rows).to.have.lengthOf(0);
        });

        // Negative control: the SAME retained rows, marker cleared, do reach the mirror. It
        // pins the refusal to the marker rather than to a harness that writes nothing.
        it(name + ' still mirrors a COMPLETE COUNT-mode set (control)', async function () {
            const db = makeDb();

            await persist(entry, db, capStub(false));

            expect(db.inserts).to.have.lengthOf(1);
            expect(db.rows).to.have.lengthOf(2);
            expect(db.rows.map(r => r.signing_pubkey)).to.deep.equal(RETAINED.map(v => v.pubkey.toLowerCase()));
            expect(db.rows.every(r => r.source === '')).to.equal(true);   // count mode has no source key
        });

        it(name + ' carries `truncated` onto the resolved COUNT-mode array', async function () {
            const out = await resolve(entry, capStub(true));

            expect(out).to.have.lengthOf(2);
            expect(out.truncated).to.equal(true);
        });
    }

    // The two resolvers that sit outside the six writers above and reach the same table by
    // their own path. Both dropped the COUNT-mode marker until this row; each is driven
    // through its real resolver so a revert is named here rather than in a review.
    describe('resolvers outside the shared writer set', function () {

        it('SECURITY: PriceAggregator returns a MARKED set for a truncated COUNT-mode read', async function () {
            const cap = capStub(true);
            const agg = Object.assign(Object.create(PriceAggregator.prototype),
                { hub: { capabilitySnapshot: cap, network: NETWORK } });
            const out = await agg._resolvePriceCapabilityValidators(BLOCK);

            expect(out).to.be.an('array');
            expect(out.truncated).to.equal(true);   // the persist guard reads exactly this
        });

        it('PriceAggregator leaves a COMPLETE COUNT-mode set unmarked (control)', async function () {
            const cap = capStub(false);
            const agg = Object.assign(Object.create(PriceAggregator.prototype),
                { hub: { capabilitySnapshot: cap, network: NETWORK } });
            const out = await agg._resolvePriceCapabilityValidators(BLOCK);

            expect(out).to.have.lengthOf(2);
            expect(out.truncated).to.equal(undefined);
        });

        it('SECURITY: AttestationBatchPublisher REFUSES a truncated COUNT-mode set', async function () {
            const cap = capStub(true);
            const pub = Object.assign(Object.create(AttestationBatchPublisher.prototype),
                { hub: { capabilitySnapshot: cap }, network: NETWORK });
            const out = await pub._resolveAttestationSet(BLOCK);

            expect(out).to.equal(null);            // null is this rail's fail-closed value
        });

        it('AttestationBatchPublisher still returns a COMPLETE COUNT-mode set (control)', async function () {
            const cap = capStub(false);
            const pub = Object.assign(Object.create(AttestationBatchPublisher.prototype),
                { hub: { capabilitySnapshot: cap }, network: NETWORK });
            const out = await pub._resolveAttestationSet(BLOCK);

            expect(out).to.have.lengthOf(2);
        });
    });

    // The shared writer is the only INSERT into the table, so its own refusal is what makes
    // the rule un-forgettable for a writer that never learned it.
    describe('writeCapabilitySnapshotRows (shared choke point)', function () {

        it('SECURITY: refuses a marked set outright and issues no statement', async function () {
            const db  = makeDb();
            const set = RETAINED.map(v => ({ pubkey: v.pubkey, source: '', amount: v.amount }));
            set.truncated = true;

            const rows = await snapWrite.writeCapabilitySnapshotRows(db, 'cross_chain', BLOCK, set);

            expect(rows).to.deep.equal([]);
            expect(db.inserts).to.have.lengthOf(0);
            expect(console.warn.callCount).to.equal(1);      // a silent refusal is an ops trap
        });

        it('writes an unmarked set of the same rows (control)', async function () {
            const db  = makeDb();
            const set = RETAINED.map(v => ({ pubkey: v.pubkey, source: '', amount: v.amount }));

            const rows = await snapWrite.writeCapabilitySnapshotRows(db, 'cross_chain', BLOCK, set);

            expect(rows).to.have.lengthOf(2);
            expect(db.inserts).to.have.lengthOf(1);
            expect(db.rows).to.have.lengthOf(2);
        });
    });
});
