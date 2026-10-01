'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../src/validators/identity');
const { ARCHIVE_MAX_LIST_ROWS, LIST_SNAPSHOT_KEYS, XANC_FINALIZED } =
    require('../../../../../src/anchor/publisher/constants.js');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');
const vectors = require('../../../../fixtures/anchor_archive_vectors.json');

function buildPub(db, sets, broadcast){
    const identity = new ValidatorIdentity('11'.repeat(32));
    const pub = new StateAnchorPublisher({
        db: { ...DB_METHODS, ...(db || {}) }, network: 'regtest', p2pConfig: {},
        getIdentity: () => identity,
        getPeerManager: () => ({ broadcast: broadcast || (() => {}) })
    });
    pub.resolveCapabilitySet = async (capability, block) =>
        (sets || {})[capability + '@' + block] || [];
    return { pub, identity };
}

function listRow(snapshotId, snapshotBlock){
    return {
        id: snapshotId === 'a' ? 2 : 1,
        snapshot_id: snapshotId,
        snapshot_block: snapshotBlock,
        network: 'regtest',
        home_chain: 'DOGE',
        home_list_index: 7,
        list_type: 2,
        seq: snapshotId === 'a' ? 2 : 1,
        kind: 'delta',
        origin_block: snapshotBlock - 1,
        members_hash: snapshotId.repeat(64),
        added: '[]',
        removed: '[]',
        admit_block_btc: null,
        admit_block_ltc: null,
        admit_block_doge: snapshotBlock,
        finalizing_view: 0,
        validator_signatures: '[]',
        status: 'finalized'
    };
}

function emptySelectionDb(overrides){
    return Object.assign({
        findCrossChainMatchesByBatchSeq: async () => [],
        findCrossChainCallsByBatchSeq: async () => [],
        findArchivableAnchorRewardsBelowFlagDays: async () => [],
        findArchivableAnchorRewards: async () => [],
        findBridgeTransfersByBatchSeq: async () => [],
        findPolicySnapshotsByBatchSeq: async () => [],
        findListSnapshotsByBatchSeq: async () => [],
        findStateCheckpointsByBatchSeq: async () => [],
        findPriceSnapshotRoundsByBatchSeq: async () => [],
        findPriceSnapshotsForArchiveRounds: async () => [],
        findPriceTombstonesByBatchSeq: async () => []
    }, overrides || {});
}

describe('archive list snapshot build', function () {
    it('keeps existing archive vector bytes unchanged without list rows', async function () {
        const { inputs, json, crc32 } = vectors.L;
        const { pub } = buildPub({}, inputs.capability_sets);

        const absent = await pub.buildArchive(inputs.network, inputs.batch_seq, inputs.matches,
            inputs.wrapper_snapshot_block, inputs.calls, inputs.rewards, {});
        const empty = await pub.buildArchive(inputs.network, inputs.batch_seq, inputs.matches,
            inputs.wrapper_snapshot_block, inputs.calls, inputs.rewards, { lists: [] });

        expect(absent.json).to.equal(json);
        expect(empty.json).to.equal(json);
        expect(pub.crc32Hex(empty.json)).to.equal(crc32);
        expect(empty.json).to.not.contain('list_snapshots');
    });

    it('sorts list rows after price tombstones and resolves their capability blocks', async function () {
        const { inputs } = vectors.L;
        const sets = {
            ...inputs.capability_sets,
            'cross_chain@80': [{ pubkey: 'ee'.repeat(32), amount: '4', source: '' }],
            'cross_chain@90': [{ pubkey: 'ff'.repeat(32), amount: '5', source: '' }]
        };
        const { pub } = buildPub({}, sets);
        const result = await pub.buildArchive(inputs.network, inputs.batch_seq, inputs.matches,
            inputs.wrapper_snapshot_block, inputs.calls, inputs.rewards, {
                tombstones: [{ round_number: 6, coin_pair: 'XCP/USD' }],
                lists: [listRow('z', 90), listRow('a', 80)]
            });
        const body = JSON.parse(result.json);

        expect(Object.keys(body)).to.deep.equal([
            'v', 'network', 'batch_seq', 'matches', 'calls', 'rewards',
            'price_tombstones', 'list_snapshots', 'capability_snapshots'
        ]);
        expect(body.list_snapshots.map(row => row.snapshot_id)).to.deep.equal(['a', 'z']);
        expect(body.list_snapshots.map(row => Object.keys(row)))
            .to.deep.equal([LIST_SNAPSHOT_KEYS, LIST_SNAPSHOT_KEYS]);
        const groups = body.capability_snapshots
            .map(row => row.capability + '@' + row.snapshot_block);
        expect(groups).to.include('cross_chain@80').and.include('cross_chain@90');
    });

    it('selects eight of nine pending list rows and marks the round capped', async function () {
        const pending = Array.from({ length: 9 }, (_, i) =>
            listRow('snapshot-' + String(i).padStart(2, '0'), 80 + i));
        const findLists = sinon.stub().resolves(pending);
        const { pub } = buildPub(emptySelectionDb({ findListSnapshotsByBatchSeq: findLists }));

        const rows = await pub.gatherArchiveRows();

        expect(findLists.calledOnceWithExactly(ARCHIVE_MAX_LIST_ROWS + 1)).to.equal(true);
        expect(rows.lists).to.have.length(ARCHIVE_MAX_LIST_ROWS);
        expect(rows.lists.map(row => row.snapshot_id))
            .to.deep.equal(pending.slice(0, ARCHIVE_MAX_LIST_ROWS).map(row => row.snapshot_id));
        expect(rows.cappedOrTrimmed).to.equal(true);
    });

    it('publishes, announces, and backfills every archived list identifier', async function () {
        const updates = sinon.stub().resolves({ affectedRows: 1 });
        const sent = [];
        const { pub } = buildPub({ updateListSnapshotArchiveBatchSeq: updates }, {},
            (type, data) => sent.push({ type, data }));
        const txid = 'ab'.repeat(32);
        const listIds = [{ snapshot_id: 'a' }, { snapshot_id: 'z' }];
        const round = {
            cp: { network: 'regtest', snapshot_block: 100 }, batchSeq: 42,
            signatures: new Map(), signer: { broadcastFn: async () => ({ txid }) },
            chunks: ['chunk'], matchIds: [], callIds: [], rewardIds: [],
            bridgeIds: [], policyIds: [], listIds, checkpointIds: [], priceIds: [],
            tombstoneIds: []
        };
        pub.getLiveArchiveIntent = async () => null;
        pub.collectArchiveAttestation = async () => ({ sigs: [], attested: false });
        pub.archiveHeadPayload = () => ({});
        pub.sendArchiveHead = async () => ({ txid });
        pub.markArchiveSent = async () => {};
        pub.notePendingConfirmation = () => {};
        pub.adoptedChunkSeq = () => round.batchSeq;
        pub.broadcastArchiveChunks = async () => 0;
        pub.archiveOnChainValid = () => true;
        pub.settleArchiveIntent = async () => {};
        pub.recordArchivePublish = () => {};

        await pub.publishArchive(round);

        expect(updates.callCount).to.equal(2);
        expect(updates.getCall(0).args).to.deep.equal([42, txid, 'a']);
        expect(updates.getCall(1).args).to.deep.equal([42, txid, 'z']);
        expect(sent).to.have.length(1);
        expect(sent[0].type).to.equal(XANC_FINALIZED);
        expect(sent[0].data.lists).to.deep.equal(listIds);
        expect(pub.archiveBackfillIds(round, 1, true, false).listIds).to.deep.equal([]);
    });
});
