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
