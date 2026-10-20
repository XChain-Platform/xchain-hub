'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../../src/validators/identity');
const { applyListDelta, listMembersHash } = require('../../../../../../src/cross_chain/list/canonical.js');
const { deriveListSnapshotId } = require('../../../../../../src/cross_chain/list/chain.js');
const { DB_METHODS } = require('../../../../../helpers/mockHub.js');

const BLOCK = 160000;
const NETWORK = 'mainnet';
const FULL = ['bc1qmemberalpha', 'ltc1qmemberbeta'];
const IDENTITIES = ['11', '22', '33'].map(seed => new ValidatorIdentity(seed.repeat(32)));
const SET = IDENTITIES.map((identity, index) => ({
    pubkey: identity.getPubkeyHex().toLowerCase(), amount: '1', source: 'stake-' + index
}));

function listRow(seq, added, removed, members){
    return {
        id: seq,
        snapshot_id: deriveListSnapshotId(NETWORK, 'DOGE', 880001, seq, BLOCK),
        snapshot_block: BLOCK,
        network: NETWORK,
        home_chain: 'DOGE',
        home_list_index: 880001,
        list_type: 2,
        seq,
        kind: seq === 1 ? 'full' : 'delta',
        origin_block: 68000000 + seq,
        members_hash: listMembersHash(members),
        added: JSON.stringify(added),
        removed: JSON.stringify(removed),
        admit_block_btc: 160010,
        admit_block_ltc: 4905000,
        admit_block_doge: 68000010,
        finalizing_view: 0,
        validator_signatures: '[]',
        status: 'finalized'
    };
}

function publisher(heldChain){
    const pub = new StateAnchorPublisher({
        db: {
            ...DB_METHODS,
            getListSnapshotBySnapshotId: async () => [],
            findListSnapshotChain: async (network, homeChain, index, uptoSeq) =>
                (heldChain || []).filter(row => row.seq <= uptoSeq)
        },
        network: NETWORK,
        getIdentity: () => IDENTITIES[0],
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {}
    });
    pub.resolveCapabilitySet = async (capability, block, network) =>
        capability === 'cross_chain' && block === BLOCK && network === NETWORK ? SET : [];
    return pub;
}

function signed(pub, row){
    const canonical = pub.listSnapshotCanonical(row);
    row.validator_signatures = JSON.stringify(IDENTITIES.map(identity => ({
        pubkey: identity.getPubkeyHex().toLowerCase(), sig: identity.sign(canonical)
    })));
    return row;
}

// A quorum-signed seq 1 and seq 2 pair, plus a seq 2 whose arrays a leader rewrote after signing
function chainFor(pub){
    const first = signed(pub, listRow(1, FULL, [], FULL));
    const added = ['doge1qmembergamma'];
    const removed = ['bc1qmemberalpha'];
    const second = signed(pub, listRow(2, added, removed, applyListDelta(FULL, added, removed)));
    return { first, second };
}

function archiveOf(rows){
    return {
        network: NETWORK,
        matches: [],
        list_snapshots: rows,
        capability_snapshots: SET.map(member => ({
            snapshot_block: BLOCK, capability: 'cross_chain',
            signing_pubkey: member.pubkey, amount: member.amount, source: member.source
        }))
    };
}

describe('archive list follower unheld delta rows', function () {
    it('accepts an unheld delta that folds onto our own finalized predecessor', async function () {
        const { first, second } = chainFor(publisher());
        const pub = publisher([first]);

        expect(await pub.verifyArchivedListSnapshot(second, archiveOf([second]))).to.equal(true);
        expect(await pub.verifyArchivedListSnapshot({ ...second, seq: '2' }, archiveOf([second])))
            .to.equal(true);
    });

    it('refuses an unheld delta whose added or removed array was rewritten after signing', async function () {
        const { first, second } = chainFor(publisher());
        const pub = publisher([first]);
        const forgedAdded = { ...second, added: JSON.stringify(['doge1qmemberforged']) };
        const forgedRemoved = { ...second, removed: JSON.stringify(['ltc1qmemberbeta']) };

        expect(await pub.verifyArchivedListSnapshot(forgedAdded, archiveOf([forgedAdded]))).to.equal(false);
        expect(await pub.verifyArchivedListSnapshot(forgedRemoved, archiveOf([forgedRemoved]))).to.equal(false);
    });

    it('folds an unheld delta onto a predecessor carried in the same archive', async function () {
        const pub = publisher();
        const { first, second } = chainFor(pub);
        const forged = { ...second, added: JSON.stringify(['doge1qmemberforged']) };

        expect(await pub.verifyArchiveAgainstLocal(archiveOf([second, first]), null)).to.equal(true);
        expect(await pub.verifyArchiveAgainstLocal(archiveOf([forged, first]), null)).to.equal(false);
    });

    it('refuses an unheld delta with no predecessor here or in the archive', async function () {
        const pub = publisher();
        const { second } = chainFor(pub);

        expect(await pub.verifyArchivedListSnapshot(second, archiveOf([second]))).to.equal(false);
        expect(await pub.verifyArchivedListSnapshot(second)).to.equal(false);
    });
});
