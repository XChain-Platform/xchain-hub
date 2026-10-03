'use strict';

// GENERATED
// Copyright © 2025-2026 Dankest, LLC
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const { listMetaHash } = require('../../../../../../src/cross_chain/list/canonical.js');
const { DB_METHODS } = require('../../../../../helpers/mockHub.js');

const MEMBERS_HASH = 'ff0e5a860d907b646255b7ab798db5057319b71c20facd02b9856b9a956320cb';
const META_HASH = listMetaHash('Alpha list', 'Members of alpha');
const OTHER_HASH = 'cd'.repeat(32);

function listRow(extra){
    return Object.assign({
        id: 1,
        snapshot_id: 'c0e9a6b57adfc25378343388363aad10498fd201a36cd32dddb1ee35da265f21',
        snapshot_block: 160000,
        network: 'regtest',
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
    }, extra || {});
}

function metaFields(extra){
    return Object.assign({ name: 'Alpha list', description: 'Members of alpha', meta_hash: META_HASH }, extra || {});
}

function setup(held){
    const pub = new StateAnchorPublisher({
        db: { ...DB_METHODS, getListSnapshotBySnapshotId: async () => [held] },
        network: held.network,
        getIdentity: () => null,
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {}
    });
    const quorum = sinon.stub(pub, 'verifyArchivedBridgePolicyQuorum').resolves(true);
    return { pub, quorum };
}

function archivedFrom(pub, held, extra){
    return Object.assign(pub.serializeListSnapshot(held), extra || {});
}

describe('archive list snapshot verify with metadata', function () {
    it('reaches the quorum check when name, description and meta_hash match', async function () {
        const held = listRow(metaFields());
        const { pub, quorum } = setup(held);
        const archived = archivedFrom(pub, held);

        expect(archived).to.include({ name: 'Alpha list', description: 'Members of alpha', meta_hash: META_HASH });
        expect(await pub.verifyArchivedListSnapshot(archived)).to.equal(true);
        expect(quorum.calledOnce).to.equal(true);
    });

    for(const [label, override, warning] of [
        ['name', {
            name: 'Beta list',
            meta_hash: listMetaHash('Beta list', 'Members of alpha')
        }, /TERMS differ/],
        ['description', {
            description: 'Members of beta',
            meta_hash: listMetaHash('Alpha list', 'Members of beta')
        }, /TERMS differ/],
        ['meta_hash', { meta_hash: OTHER_HASH }, /metadata hash mismatch/]
    ]){
        it('refuses an archived row whose ' + label + ' differs from the held row', async function () {
            const held = listRow(metaFields());
            const { pub, quorum } = setup(held);
            const warn = sinon.spy(require('../../../../../../src/observability').getLogger(), 'warn');
            try {
                expect(await pub.verifyArchivedListSnapshot(archivedFrom(pub, held, override))).to.equal(false);
                expect(warn.args.some(a => warning.test(a[0]))).to.equal(true);
            } finally {
                warn.restore();
            }
            expect(quorum.called).to.equal(false);
        });
    }

    it('refuses a held row with a meta_hash against an archive omitting the three fields', async function () {
        const held = listRow(metaFields());
        const { pub, quorum } = setup(held);
        const archived = archivedFrom(pub, held);
        delete archived.name;
        delete archived.description;
        delete archived.meta_hash;

        expect(await pub.verifyArchivedListSnapshot(archived)).to.equal(false);
        expect(quorum.called).to.equal(false);
    });

    it('reaches the quorum check for a null meta_hash against an archive without the fields', async function () {
        const held = listRow({
            network: 'testnet', name: null, description: null, meta_hash: null
        });
        const { pub, quorum } = setup(held);
        const archived = archivedFrom(pub, held);

        expect(archived).to.not.have.property('meta_hash');
        expect(await pub.verifyArchivedListSnapshot(archived)).to.equal(true);
        expect(quorum.calledOnce).to.equal(true);
    });
});
