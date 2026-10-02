'use strict';

// GENERATED
// Copyright © 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const { LIST_SNAPSHOT_KEYS } = require('../../../../../src/anchor/publisher/constants.js');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');

const META_HASH = 'ab'.repeat(32);

function buildPub(){
    return new StateAnchorPublisher({
        db: DB_METHODS,
        network: 'regtest',
        getIdentity: () => null,
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {}
    });
}

function listRow(){
    return {
        id: '4',
        snapshot_id: 'snapshot-9',
        snapshot_block: '100',
        network: 'regtest',
        home_chain: 'DOGE',
        home_list_index: '7',
        list_type: '2',
        seq: '3',
        kind: 'delta',
        origin_block: '95',
        members_hash: 'cd'.repeat(32),
        added: '["member"]',
        removed: '[]',
        admit_block_btc: null,
        admit_block_ltc: '110',
        admit_block_doge: undefined,
        finalizing_view: null,
        validator_signatures: [],
        status: 'finalized'
    };
}

describe('archive list snapshot metadata serialization', () => {
    it('keeps a row without meta_hash byte-identical to the legacy serialization', () => {
        const serialized = buildPub().serializeListSnapshot(listRow());
        const expected = {
            id: 4,
            snapshot_id: 'snapshot-9',
            snapshot_block: 100,
            network: 'regtest',
            home_chain: 'DOGE',
            home_list_index: 7,
            list_type: 2,
            seq: 3,
            kind: 'delta',
            origin_block: 95,
            members_hash: 'cd'.repeat(32),
            added: '["member"]',
            removed: '[]',
            admit_block_btc: null,
            admit_block_ltc: 110,
            admit_block_doge: null,
            finalizing_view: 0,
            validator_signatures: [],
            status: 'finalized'
        };

        expect(Object.keys(serialized)).to.deep.equal(LIST_SNAPSHOT_KEYS);
        expect(JSON.stringify(serialized)).to.equal(JSON.stringify(expected));
    });

    it('keeps a row with null meta_hash byte-identical to the legacy serialization', () => {
        const withoutMetaHash = buildPub().serializeListSnapshot(listRow());
        const serialized = buildPub().serializeListSnapshot({
            ...listRow(), name: 'ignored', description: 'ignored', meta_hash: null
        });

        expect(Object.keys(serialized)).to.deep.equal(LIST_SNAPSHOT_KEYS);
        expect(JSON.stringify(serialized)).to.equal(JSON.stringify(withoutMetaHash));
    });

    it('appends name, description and meta_hash when the hash is non-null', () => {
        const serialized = buildPub().serializeListSnapshot({
            ...listRow(), name: 'Treasury addresses', description: 'Reviewed weekly',
            meta_hash: META_HASH
        });

        expect(Object.keys(serialized)).to.deep.equal([
            ...LIST_SNAPSHOT_KEYS, 'name', 'description', 'meta_hash'
        ]);
        expect(serialized).to.include({
            name: 'Treasury addresses',
            description: 'Reviewed weekly',
            meta_hash: META_HASH
        });
    });

    it('archives absent metadata text as null when meta_hash is present', () => {
        const serialized = buildPub().serializeListSnapshot({
            ...listRow(), meta_hash: META_HASH
        });

        expect(serialized.name).to.equal(null);
        expect(serialized.description).to.equal(null);
    });
});
