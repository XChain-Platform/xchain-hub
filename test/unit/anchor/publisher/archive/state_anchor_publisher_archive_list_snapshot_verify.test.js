'use strict';

// GENERATED
// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../src/validators/identity');
const { listMetaHash } = require('../../../../../src/cross_chain/list/canonical.js');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

const BLOCK = 160000;
const TXID = 'ab'.repeat(32);
const MEMBERS_HASH = 'ff0e5a860d907b646255b7ab798db5057319b71c20facd02b9856b9a956320cb';
const IDENTITIES = ['11', '22', '33'].map(seed => new ValidatorIdentity(seed.repeat(32)));
const SET = IDENTITIES.map((identity, index) => ({
    pubkey: identity.getPubkeyHex().toLowerCase(), amount: '1', source: 'stake-' + index
}));

function listRow(){
    return {
        id: 1,
        snapshot_id: 'c0e9a6b57adfc25378343388363aad10498fd201a36cd32dddb1ee35da265f21',
        snapshot_block: BLOCK,
        network: 'testnet',
        home_chain: 'DOGE',
        home_list_index: 880001,
        list_type: 2,
        seq: 1,
        kind: 'full',
        origin_block: 68000000,
        members_hash: MEMBERS_HASH,
        added: JSON.stringify(['bc1qmemberalpha', 'ltc1qmemberbeta']),
        removed: '[]',
        admit_block_btc: 160010,
        admit_block_ltc: 4905000,
        admit_block_doge: 68000010,
        finalizing_view: 0,
        validator_signatures: '[]',
        status: 'finalized'
    };
}

function publisher(held, dbOverrides, network = 'testnet'){
    const db = {
        ...DB_METHODS,
        getListSnapshotBySnapshotId: async () => held ? [held] : [],
        ...(dbOverrides || {})
    };
    const pub = new StateAnchorPublisher({
        db,
        network,
        getIdentity: () => IDENTITIES[0],
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {}
    });
    pub.resolveCapabilitySet = async (capability, block, network) =>
        capability === 'cross_chain' && block === BLOCK && network === pub.network ? SET : [];
    return pub;
}

function signedRow(pub, count, overrides){
    const row = Object.assign(listRow(), overrides || {});
    const canonical = pub.listSnapshotCanonical(row);
    row.validator_signatures = JSON.stringify(IDENTITIES.slice(0, count).map(identity => ({
        pubkey: identity.getPubkeyHex().toLowerCase(),
        sig: identity.sign(canonical)
    })));
    return row;
}

function archiveFor(row){
    return {
        network: 'testnet',
        matches: [],
        list_snapshots: [row],
        capability_snapshots: SET.map(member => ({
            snapshot_block: BLOCK,
            capability: 'cross_chain',
            signing_pubkey: member.pubkey,
            amount: member.amount,
            source: member.source
        }))
    };
}

describe('archive list snapshot follower integration', function () {
    it('binds active metadata without relying on a held row', async function () {
        const pub = publisher(null, null, 'regtest');
        const name = 'Original label';
        const description = 'Original description';
        const signed = signedRow(pub, 3, {
            network: 'regtest',
            name,
            description,
            meta_hash: listMetaHash(name, description)
        });

        expect(await pub.verifyArchivedListSnapshot(signed)).to.equal(true);
        for(const forged of [
            { ...signed, name: 'Forged archive label' },
            { ...signed, description: 'Forged archive description' },
            { ...signed, meta_hash: '00'.repeat(32) }
        ]){
            expect(await pub.verifyArchivedListSnapshot(forged)).to.equal(false);
        }
    });

    it('enforces absence of metadata below the gate', async function () {
        // mainnet stays below LIST_META; testnet block 160000 is above its v0.21.3 height.
        const pub = publisher(undefined, undefined, 'mainnet');
        const signed = signedRow(pub, 3, { network: 'mainnet' });

        expect(await pub.verifyArchivedListSnapshot(signed)).to.equal(true);
        for(const field of ['name', 'description', 'meta_hash']){
            expect(await pub.verifyArchivedListSnapshot({ ...signed, [field]: 'forged' }))
                .to.equal(false);
        }
    });

    it('refuses an archive whose list row differs from the held row', async function () {
        const held = listRow();
        const pub = publisher(held);
        const archived = signedRow(pub, 3, { origin_block: held.origin_block + 1 });

        expect(await pub.verifyArchiveAgainstLocal(archiveFor(archived), null)).to.equal(false);
    });

    it('refuses an archive whose list row fails signature quorum', async function () {
        const pub = publisher();

        expect(await pub.verifyArchiveAgainstLocal(archiveFor(signedRow(pub, 2)), null))
            .to.equal(false);
    });

    it('refuses an archive missing the list capability snapshot group', async function () {
        const pub = publisher();
        const archive = archiveFor(signedRow(pub, 3));
        archive.capability_snapshots = [];

        expect(await pub.verifyArchiveAgainstLocal(archive, null)).to.equal(false);
    });

    it('stamps an announced list row after a verified FINALIZED', async function () {
        const update = sinon.stub().resolves({ affectedRows: 1 });
        const pub = publisher(null, { updateListSnapshotArchiveBatchSeq: update });
        const leader = IDENTITIES[1];
        const sender = leader.getPubkeyHex().toLowerCase();
        const list = { snapshot_id: listRow().snapshot_id };
        pub.getActiveOraclePublishPubkeys = async () => [sender];
        pub.verifyArchiveCheckpointOnChain = async () => 'verified';
        pub.recordObservedArchiveLeader(7, sender);
        pub.recordObservedArchiveContent(7, sender, { list_snapshots: [list] });
        const data = {
            batch_seq: 7,
            txid: TXID,
            matches: [],
            calls: [],
            rewards: [],
            lists: [list],
            sig_pubkey: sender
        };
        data.sig = leader.sign(pub.finalizedCanonical(7, TXID, 0));

        await pub.handleFinalized({ data });

        expect(update.calledOnceWithExactly(7, TXID, list.snapshot_id)).to.equal(true);
    });

    it('refuses a FINALIZED list entry without a snapshot id', async function () {
        const pub = publisher();

        expect(await pub.verifyFinalizedAgainstLocal([], [], [], {
            bridges: [], policies: [], lists: [{}], checkpoints: [], prices: [], tombstones: []
        })).to.equal(false);
    });

    it('names a list id missing from the observed archive', function () {
        const pub = publisher();
        const sender = IDENTITIES[1].getPubkeyHex().toLowerCase();
        pub.recordObservedArchiveContent(7, sender, {
            list_snapshots: [{ snapshot_id: 'present' }]
        });

        expect(pub.finalizedOutsideObservedArchive(
            7, sender, [], [], [], [], [], [], [], [],
            [{ snapshot_id: 'abcdefghijklmnop-extra' }]))
            .to.equal('list abcdefghijklmnop...');
    });

    it('verifies an archive with no list snapshots as before', async function () {
        const pub = publisher();
        const verifyList = sinon.spy(pub, 'verifyArchivedListSnapshot');

        expect(await pub.verifyArchiveAgainstLocal({
            network: 'testnet', matches: [], capability_snapshots: []
        }, null)).to.equal(true);
        expect(verifyList.called).to.equal(false);
    });
});
