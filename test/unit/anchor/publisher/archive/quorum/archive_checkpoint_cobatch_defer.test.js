'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../../src/validators/identity');

function checkpoint(seq, blockIndex, supersedesFrom, overrides){
    return Object.assign({
        chain: 'BTC', network: 'regtest', block_index: blockIndex,
        block_hash: 'c0'.repeat(32), ledger_hash: 'a1'.repeat(32),
        actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: seq, snapshot_block: 100, state_root: null,
        state_root_version: null, block_merkle_root: null, block_merkle_version: null,
        validator_signatures: '[]', supersedes_from: supersedesFrom
    }, overrides || {});
}

function publisherReading(pending){
    const none = async () => [];
    const db = {
        findCrossChainMatchesByBatchSeq: none, findCrossChainCallsByBatchSeq: none,
        findArchivableAnchorRewardsBelowFlagDays: none, findArchivableAnchorRewards: none,
        findBridgeTransfersByBatchSeq: none, findPolicySnapshotsByBatchSeq: none,
        findStateCheckpointsByBatchSeq: async () => pending,
        findPriceSnapshotRoundsByBatchSeq: none, findPriceSnapshotsForArchiveRounds: none,
        findPriceTombstonesByBatchSeq: none
    };
    const identity = new ValidatorIdentity('11'.repeat(32));
    return new StateAnchorPublisher({
        db, network: 'regtest', p2pConfig: {}, getIdentity: () => identity,
        getPeerManager: () => ({ broadcast() {} })
    });
}

async function archivedSeqs(pending){
    const rows = await publisherReading(pending).gatherArchiveRows();
    return rows.checkpoints.map(row => Number(row.checkpoint_seq));
}

async function coSignerAccepts(checkpoints){
    const pub = publisherReading([]);
    pub.verifyArchivedStateCheckpoint = async () => true;
    pub.archivedSnapshotGroups = () => new Map();
    pub.seedRequiredSnapshotGroups = () => true;
    pub.verifyArchivedSnapshotGroups = async () => true;
    return pub.verifyArchiveAgainstLocal({
        matches: [], calls: [], rewards: [], capability_snapshots: [],
        state_checkpoints: checkpoints, price_snapshots: [], price_tombstones: []
    }, 100);
}

describe('archive checkpoint selection beside a superseding marker', function () {
    it('keeps a row back when a marker in the same page supersedes it', async function () {
        const pending = [checkpoint(100, 500, null), checkpoint(101, 520, 450)];
        expect(await archivedSeqs(pending)).to.deep.equal([101]);
    });

    it('archives the same row once the marker is no longer pending', async function () {
        expect(await archivedSeqs([checkpoint(100, 500, null)])).to.deep.equal([100]);
    });

    it('keeps both rows when the marker starts above the row', async function () {
        const pending = [checkpoint(100, 500, null), checkpoint(101, 620, 600)];
        expect(await archivedSeqs(pending)).to.deep.equal([100, 101]);
    });

    it('judges rows per chain and network', async function () {
        const pending = [checkpoint(100, 500, null, { chain: 'LTC' }), checkpoint(101, 520, 450),
            checkpoint(102, 520, null, { network: 'testnet' })];
        const kept = await archivedSeqs(pending);
        expect(kept.sort((a, b) => a - b)).to.deep.equal([100, 101, 102]);
    });

    it('defers only the rows at or above the marker start', async function () {
        const pending = [checkpoint(100, 500, null), checkpoint(101, 510, null),
            checkpoint(102, 520, 505)];
        const kept = await archivedSeqs(pending);
        expect(kept).to.deep.equal([100, 102]);
    });
});

describe('archive checkpoint co-signer beside a superseding marker', function () {
    it('refuses a checkpoint superseded by a sibling marker', async function () {
        const rows = [checkpoint(100, 500, null), checkpoint(101, 520, 450)];
        expect(await coSignerAccepts(rows)).to.equal(false);
    });

    it('accepts non-conflicting checkpoints and isolated rows', async function () {
        expect(await coSignerAccepts([checkpoint(100, 500, null), checkpoint(101, 620, 600)]))
            .to.equal(true);
        expect(await coSignerAccepts([checkpoint(100, 500, null)])).to.equal(true);
        expect(await coSignerAccepts([checkpoint(101, 520, 450)])).to.equal(true);
    });

    it('keeps chain and network boundaries independent', async function () {
        const rows = [checkpoint(100, 500, null, { chain: 'LTC' }),
            checkpoint(101, 520, 450), checkpoint(102, 520, null, { network: 'testnet' })];
        expect(await coSignerAccepts(rows)).to.equal(true);
    });
});
