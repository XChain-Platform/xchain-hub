'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// The builder (buildArchive) and the follower (seedRequiredSnapshotGroups) both take an archive's
// capability groups from archiveCapabilityWants. Every kind sits at its own block here, so a kind
// the shared list drops or moves, or a side that stops deriving from it, shows up against the table.

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../../src/validators/identity');
const { DB_METHODS } = require('../../../../../helpers/mockHub.js');
const vectors = require('../../../../../fixtures/anchor_archive_vectors.json');

const WRAPPER_BLOCK = 1010;
const SET = [{ pubkey: 'aa'.repeat(32), amount: '1', source: '' }];

// Every top-level archive key, and the group it obliges: [block, capability] or null for none
const ARCHIVE_KEYS = {
    v: null, network: null, batch_seq: null, price_tombstones: null, capability_snapshots: null,
    matches: [1001, 'cross_chain'],
    calls: [1002, 'cross_chain'],
    rewards: [1009, 'oracle_publish'],
    bridge_transfers: [1003, 'cross_chain'],
    policy_snapshots: [1004, 'cross_chain'],
    state_checkpoints: [1006, 'oracle_publish'],
    price_snapshots: [1007, 'price'],
    list_snapshots: [1005, 'cross_chain']
};

function copy(value){
    return JSON.parse(JSON.stringify(value));
}

function buildPub(){
    const pub = new StateAnchorPublisher({
        db: { ...DB_METHODS }, network: 'regtest',
        getIdentity: () => new ValidatorIdentity('11'.repeat(32)),
        getPeerManager: () => ({ broadcast() {} }), p2pConfig: {}
    });
    pub.resolveCapabilitySet = async () => SET;
    return pub;
}

function at(rows, field, block){
    return rows.map(row => Object.assign(copy(row), { [field]: block }));
}

// One row of every kind; the batch-proofed price round (12) sits at 1008 and must add no group
function allKindsInputs(){
    const B = vectors.B.inputs;
    const P = vectors.P.inputs;
    const list = {
        id: 1, snapshot_id: 'a'.repeat(64), snapshot_block: 1005, network: 'regtest',
        home_chain: 'DOGE', home_list_index: 7, list_type: 2, seq: 1, kind: 'full',
        origin_block: 1004, members_hash: 'b'.repeat(64), added: '[]', removed: '[]',
        admit_block_btc: null, admit_block_ltc: null, admit_block_doge: 1005,
        finalizing_view: 0, validator_signatures: '[]', status: 'finalized'
    };
    const prices = at(P.prices.filter(row => row.round_number === 11), 'reference_block', 1007)
        .concat(at(P.prices.filter(row => row.round_number === 12), 'reference_block', 1008));
    return {
        matches: at(B.matches, 'snapshot_block', 1001),
        calls: at(B.calls, 'snapshot_block', 1002),
        rewards: B.rewards.map(({ row, source }) => ({ row: Object.assign(copy(row), { block_index: 1009 }), source })),
        rows: {
            bridges: at(B.bridges.slice(0, 1), 'snapshot_block', 1003),
            policies: at(B.policies, 'snapshot_block', 1004),
            lists: [list],
            checkpoints: at(vectors.C.inputs.checkpoints.slice(0, 1), 'snapshot_block', 1006),
            prices,
            tombstones: copy(P.tombstones)
        }
    };
}

async function buildAllKinds(pub){
    const inputs = allKindsInputs();
    const result = await pub.buildArchive('regtest', 7, inputs.matches, WRAPPER_BLOCK,
        inputs.calls, inputs.rewards, inputs.rows);
    return JSON.parse(result.json);
}

function groupKeys(archive){
    return [...new Set(archive.capability_snapshots.map(s => s.snapshot_block + '|' + s.capability))].sort();
}

describe('archive capability groups: builder and follower agree per kind', function () {
    it('emits only archive keys this inventory classifies', async function () {
        const archive = await buildAllKinds(buildPub());
        expect(Object.keys(archive).sort()).to.deep.equal(Object.keys(ARCHIVE_KEYS).sort());
    });

    it('seeds exactly the groups the builder emitted, at each kind\'s own block', async function () {
        const pub = buildPub();
        const archive = await buildAllKinds(pub);
        const expected = Object.values(ARCHIVE_KEYS).filter(Boolean).map(([block, cap]) => block + '|' + cap)
            // Regtest arms the archive_publish gate at 0, so the wrapper group moves to that set
            .concat([WRAPPER_BLOCK + '|archive_publish']).sort();
        const seeded = new Map();

        expect(pub.seedRequiredSnapshotGroups(seeded, archive, WRAPPER_BLOCK)).to.equal(true);
        expect(groupKeys(archive)).to.deep.equal(expected);
        expect([...seeded.keys()].sort()).to.deep.equal(expected);
        expect(expected).to.not.include('1008|price');
    });

    it('refuses the archive when any one kind\'s group is stripped', async function () {
        const pub = buildPub();
        const archive = await buildAllKinds(pub);
        const control = pub.archivedSnapshotGroups(archive);
        expect(pub.seedRequiredSnapshotGroups(control, archive, WRAPPER_BLOCK)).to.equal(true);
        expect(await pub.verifyArchivedSnapshotGroups(control, archive)).to.equal(true);

        for(const key of groupKeys(archive)){
            const stripped = Object.assign({}, archive, {
                capability_snapshots: archive.capability_snapshots.filter(s =>
                    s.snapshot_block + '|' + s.capability !== key)
            });
            const groups = pub.archivedSnapshotGroups(stripped);
            expect(pub.seedRequiredSnapshotGroups(groups, stripped, WRAPPER_BLOCK)).to.equal(true);
            expect(await pub.verifyArchivedSnapshotGroups(groups, stripped), key).to.equal(false);
        }
    });
});
