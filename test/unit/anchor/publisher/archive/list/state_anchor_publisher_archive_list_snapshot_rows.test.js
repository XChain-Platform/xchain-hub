'use strict';

// GENERATED
// Copyright © 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../../src/validators/identity');
const { DB_METHODS } = require('../../../../../helpers/mockHub.js');
const { listMetaHash } = require('../../../../../../src/cross_chain/list/canonical.js');

const BLOCK = 160000;
const MEMBERS = ['bc1qmemberalpha', 'ltc1qmemberbeta'];
const MEMBERS_HASH = 'ff0e5a860d907b646255b7ab798db5057319b71c20facd02b9856b9a956320cb';
const CANONICAL = 'EQUIV|XLISTSHARE|' +
    'c0e9a6b57adfc25378343388363aad10498fd201a36cd32dddb1ee35da265f21|0||' +
    'XLISTSHARE|c0e9a6b57adfc25378343388363aad10498fd201a36cd32dddb1ee35da265f21|' +
    '160000|DOGE|880001|2|1|full|68000000|' + MEMBERS_HASH +
    '|testnet|BTC:160010,DOGE:68000010,LTC:4905000';
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
        added: JSON.stringify(MEMBERS),
        removed: '[]',
        admit_block_btc: 160010,
        admit_block_ltc: 4905000,
        admit_block_doge: 68000010,
        finalizing_view: 0,
        // Testnet block 160000 sits above the v0.21.3 LIST_META height, so the row carries
        // the (empty) metadata fields an armed archive check requires.
        name: null,
        description: null,
        meta_hash: listMetaHash(null, null),
        validator_signatures: '[]',
        status: 'finalized'
    };
}

function buildPub(held){
    const pub = new StateAnchorPublisher({
        db: {
            ...DB_METHODS,
            getListSnapshotBySnapshotId: async () => held ? [held] : []
        },
        network: 'testnet',
        getIdentity: () => IDENTITIES[0],
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {}
    });
    pub.resolveCapabilitySet = async (capability, block, network) =>
        capability === 'cross_chain' && block === BLOCK && network === 'testnet' ? SET : [];
    return pub;
}

function sign(pub, row, count){
    const canonical = pub.listSnapshotCanonical(row);
    row.validator_signatures = JSON.stringify(IDENTITIES.slice(0, count).map(identity => ({
        pubkey: identity.getPubkeyHex().toLowerCase(),
        sig: identity.sign(canonical)
    })));
    return row;
}

describe('archive list snapshot rows', () => {
    it('matches the list_share.json signed canonical vector plus the LIST_META field', () => {
        // Testnet block 160000 sits above the v0.21.3 LIST_META height, so the archive
        // check signs the legacy vector bytes with the empty-metadata hash appended.
        expect(buildPub().listSnapshotCanonical(listRow())).to.equal(CANONICAL + '|' + listMetaHash(null, null));
    });

    it('refuses a tampered added array', async () => {
        const pub = buildPub();
        const row = sign(pub, listRow(), 3);
        row.added = JSON.stringify(['attacker']);

        expect(await pub.verifyArchivedListSnapshot(row)).to.equal(false);
    });

    it('refuses a kind that disagrees with the sequence', async () => {
        const pub = buildPub();
        const row = listRow();
        row.kind = 'delta';
        sign(pub, row, 3);

        expect(await pub.verifyArchivedListSnapshot(row)).to.equal(false);
    });

    it('refuses terms that diverge from a held row', async () => {
        const held = listRow();
        const archived = Object.assign({}, held, { origin_block: held.origin_block + 1 });
        const pub = buildPub(held);
        sign(pub, archived, 3);

        expect(await pub.verifyArchivedListSnapshot(archived)).to.equal(false);
    });

    it('refuses a row with only a sub-quorum signature set', async () => {
        const pub = buildPub();
        const row = sign(pub, listRow(), 2);

        expect(await pub.verifyArchivedListSnapshot(row)).to.equal(false);
    });

    it('accepts a quorum-signed row', async () => {
        const pub = buildPub();
        const row = sign(pub, listRow(), 3);

        expect(await pub.verifyArchivedListSnapshot(row)).to.equal(true);
    });
});
