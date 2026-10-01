'use strict';

// Copyright © 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const crossChainDb = require('../../../../../src/db/cross_chain.js');
const {
    LIST_SNAPSHOT_KEYS, ARCHIVE_MAX_LIST_ROWS
} = require('../../../../../src/anchor/publisher/constants.js');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

function buildPub(db = {}){
    return new StateAnchorPublisher({
        db: { ...DB_METHODS, ...db },
        network: 'regtest',
        getIdentity: () => null,
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {}
    });
}

describe('archive list snapshot serialization', () => {
    it('uses the fixed key order and archive cap', () => {
        expect(LIST_SNAPSHOT_KEYS).to.deep.equal([
            'id', 'snapshot_id', 'snapshot_block', 'network', 'home_chain',
            'home_list_index', 'list_type', 'seq', 'kind', 'origin_block',
            'members_hash', 'added', 'removed', 'admit_block_btc',
            'admit_block_ltc', 'admit_block_doge', 'finalizing_view',
            'validator_signatures', 'status'
        ]);
        expect(ARCHIVE_MAX_LIST_ROWS).to.equal(8);
    });

    it('serializes numeric, nullable and text values by the archive rules', () => {
        const signatures = [{ pubkey: 'aa', sig: 'bb' }];
        const row = buildPub().serializeListSnapshot({
            id: '4', snapshot_id: 9, snapshot_block: '100', network: 'regtest',
            home_chain: 'DOGE', home_list_index: '7', list_type: '2', seq: '3',
            kind: 'delta', origin_block: '95', members_hash: 123,
            added: 17, removed: false, admit_block_btc: null,
            admit_block_ltc: '110', admit_block_doge: undefined,
            finalizing_view: null, validator_signatures: signatures, status: 'finalized'
        });

        expect(Object.keys(row)).to.deep.equal(LIST_SNAPSHOT_KEYS);
        expect(row).to.include({
            id: 4, snapshot_id: '9', snapshot_block: 100, network: 'regtest',
            home_chain: 'DOGE', home_list_index: 7, list_type: 2, seq: 3,
            kind: 'delta', origin_block: 95, members_hash: '123',
            added: '17', removed: 'false', admit_block_btc: null,
            admit_block_ltc: 110, admit_block_doge: null,
            finalizing_view: 0, status: 'finalized'
        });
        expect(row.validator_signatures).to.equal(signatures);
    });

    it('backfills each list snapshot through the database method', async () => {
        const update = sinon.stub().resolves({ affectedRows: 1 });
        const pub = buildPub({ updateListSnapshotArchiveBatchSeq: update });

        await pub.backfillListRows(42, 'txid123', [
            { snapshot_id: 'snapshot-a' }, { snapshot_id: 'snapshot-b' }
        ]);

        expect(update.getCall(0).args).to.deep.equal([42, 'txid123', 'snapshot-a']);
        expect(update.getCall(1).args).to.deep.equal([42, 'txid123', 'snapshot-b']);
    });

    it('includes list_snapshots in the shared batch sequence allocator', async () => {
        const doQuery = sinon.stub().resolves([{ next_seq: 0 }]);
        await crossChainDb.getNextAnchorBatchSeq.call({ doQuery });
        expect(doQuery.firstCall.args[0]).to.include(
            '(SELECT MAX(batch_seq) FROM list_snapshots)'
        );
    });
});
