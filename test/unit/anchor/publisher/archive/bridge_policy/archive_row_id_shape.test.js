'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../../src/validators/identity');
const { archivedIdRefusal } = require('../../../../../../src/anchor/publisher/archive/unheld_row.js');
const { DB_METHODS } = require('../../../../../helpers/mockHub.js');

const BLOCK = 100;
const IDENTITIES = ['11', '22', '33'].map(seed => new ValidatorIdentity(seed.repeat(32)));
const SET = IDENTITIES.map((identity, index) => ({
    pubkey: identity.getPubkeyHex().toLowerCase(), amount: '1', source: 'stake-' + index
}));
const BAD_IDS = [['a string', '7'], ['negative', -1], ['fractional', 1.5],
    ['unsafe', 2 ** 53], ['null', null], ['missing', undefined]];

function bridge(){
    return {
        id: 1, transfer_id: 'a'.repeat(64), snapshot_block: BLOCK, network: 'regtest',
        src_chain: 'BTC', src_action_index: 7, src_address: 'source', dest_chain: 'DOGE',
        dest_address: 'destination', tick: 'XCP', decimals: 8, amount: '150000000',
        effective_time: 123, admit_block_btc: null, admit_block_ltc: null,
        admit_block_doge: null, finalizing_view: 0, validator_signatures: '[]', status: 'finalized'
    };
}

function policy(){
    const allow = ['addr1', 'addr2'];
    const text = ['ALLOW', '2'].concat(allow, ['BLOCK', '-', 'SLEEP', '0']).join('|');
    return {
        id: 2, snapshot_id: 'b'.repeat(64), snapshot_block: BLOCK, network: 'regtest',
        origin_chain: 'BTC', tick: 'XCP', policy_seq: 3, origin_block: 95,
        policy_hash: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
        allow_list: JSON.stringify(allow), block_list: null, sleeping: 0, effective_time: 140,
        admit_block_btc: null, admit_block_ltc: null, admit_block_doge: null,
        finalizing_view: 0, validator_signatures: '[]', status: 'finalized'
    };
}

function listRow(){
    return {
        id: 1, snapshot_id: 'c0e9a6b57adfc25378343388363aad10498fd201a36cd32dddb1ee35da265f21',
        snapshot_block: 160000, network: 'mainnet', home_chain: 'DOGE', home_list_index: 880001,
        list_type: 2, seq: 1, kind: 'full', origin_block: 68000000,
        members_hash: 'ff0e5a860d907b646255b7ab798db5057319b71c20facd02b9856b9a956320cb',
        added: JSON.stringify(['bc1qmemberalpha', 'ltc1qmemberbeta']), removed: '[]',
        admit_block_btc: 160010, admit_block_ltc: 4905000, admit_block_doge: 68000010,
        finalizing_view: 0, validator_signatures: '[]', status: 'finalized'
    };
}

function buildPub(held){
    const pub = new StateAnchorPublisher({
        db: {
            ...DB_METHODS,
            getBridgeTransferByTransferId: async () => held.bridge ? [held.bridge] : [],
            getPolicySnapshotBySnapshotId: async () => held.policy ? [held.policy] : [],
            getListSnapshotBySnapshotId: async () => held.list ? [held.list] : []
        },
        network: 'mainnet',
        getIdentity: () => IDENTITIES[0],
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {}
    });
    pub.resolveCapabilitySet = async () => SET;
    return pub;
}

function signed(pub, row, canonical){
    row.validator_signatures = JSON.stringify(IDENTITIES.map(identity => ({
        pubkey: identity.getPubkeyHex().toLowerCase(), sig: identity.sign(canonical)
    })));
    return row;
}

function withId(row, id){
    const out = Object.assign({}, row);
    if(id === undefined) delete out.id; else out.id = id;
    return out;
}

function registerRefusalTests(){
    for(const [label, bad] of BAD_IDS){
        it('refuses a bridge transfer with ' + label + ' id when held', async () => {
            const held = bridge();
            const pub = buildPub({ bridge: held });
            const row = withId(bridge(), bad);
            signed(pub, row, pub.bridgeTransferCanonical(row));
            expect(await pub.verifyArchivedBridgeTransfer(row)).to.equal(false);
        });

        it('refuses a bridge transfer with ' + label + ' id when unheld', async () => {
            const pub = buildPub({});
            const row = withId(bridge(), bad);
            signed(pub, row, pub.bridgeTransferCanonical(row));
            expect(await pub.verifyArchivedBridgeTransfer(row)).to.equal(false);
        });

        it('refuses a policy snapshot with ' + label + ' id held and unheld', async () => {
            for(const held of [{ policy: policy() }, {}]){
                const pub = buildPub(held);
                const row = withId(policy(), bad);
                signed(pub, row, pub.policySnapshotCanonical(row));
                expect(await pub.verifyArchivedPolicySnapshot(row)).to.equal(false);
            }
        });

        it('refuses a list snapshot with ' + label + ' id when held', async () => {
            const pub = buildPub({ list: listRow() });
            const row = withId(listRow(), bad);
            signed(pub, row, pub.listSnapshotCanonical(row));
            expect(await pub.verifyArchivedListSnapshot(row, { list_snapshots: [row] })).to.equal(false);
        });

        it('refuses a list snapshot with ' + label + ' id when unheld', async () => {
            const pub = buildPub({});
            const row = withId(listRow(), bad);
            signed(pub, row, pub.listSnapshotCanonical(row));
            expect(await pub.verifyArchivedListSnapshot(row, { list_snapshots: [row] })).to.equal(false);
        });
    }
}

describe('archive row id shape', () => {
    it('accepts only a non-negative safe integer number', () => {
        for(const good of [0, 1, 42, Number.MAX_SAFE_INTEGER])
            expect(archivedIdRefusal({ id: good }), String(good)).to.equal(null);
        for(const [label, bad] of BAD_IDS)
            expect(archivedIdRefusal(withId({}, bad)), label).to.equal('has a malformed id');
        expect(archivedIdRefusal(null)).to.equal('has a malformed id');
    });

    registerRefusalTests();

    it('still accepts an integer id that differs from the held row id', async () => {
        const pub = buildPub({ bridge: bridge(), list: listRow() });
        const transfer = withId(bridge(), 42);
        signed(pub, transfer, pub.bridgeTransferCanonical(transfer));
        expect(await pub.verifyArchivedBridgeTransfer(transfer)).to.equal(true);
        const snapshot = withId(policy(), 42);
        const policyPub = buildPub({ policy: policy() });
        signed(policyPub, snapshot, policyPub.policySnapshotCanonical(snapshot));
        expect(await policyPub.verifyArchivedPolicySnapshot(snapshot)).to.equal(true);
        const list = withId(listRow(), 42);
        signed(pub, list, pub.listSnapshotCanonical(list));
        expect(await pub.verifyArchivedListSnapshot(list, { list_snapshots: [list] })).to.equal(true);
    });
});
