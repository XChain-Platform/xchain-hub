'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../../src/validators/identity');
const { DB_METHODS } = require('../../../../../helpers/mockHub.js');

const BLOCK = 100;
const IDENTITIES = ['11', '22', '33'].map(seed => new ValidatorIdentity(seed.repeat(32)));
const SET = IDENTITIES.map((id, index) => ({
    pubkey: id.getPubkeyHex().toLowerCase(), amount: '1', source: 'stake-' + index
}));

function policyHash(allow, block, sleeping){
    const part = (label, list) => list === null
        ? [label, '-']
        : [label, String(list.length)].concat(list);
    const text = part('ALLOW', allow).concat(part('BLOCK', block), ['SLEEP', sleeping ? '1' : '0']).join('|');
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

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
    const block = ['addr9'];
    return {
        id: 2, snapshot_id: 'b'.repeat(64), snapshot_block: BLOCK, network: 'regtest',
        origin_chain: 'BTC', tick: 'XCP', policy_seq: 3, origin_block: 95,
        policy_hash: policyHash(allow, block, false), allow_list: JSON.stringify(allow),
        block_list: JSON.stringify(block), sleeping: 0, effective_time: 140,
        admit_block_btc: null, admit_block_ltc: null, admit_block_doge: null,
        finalizing_view: 0, validator_signatures: '[]', status: 'finalized'
    };
}

function buildPub(held){
    held = held || {};
    const pub = new StateAnchorPublisher({
        db: {
            ...DB_METHODS,
            getBridgeTransferByTransferId: async () => held.bridge ? [held.bridge] : [],
            getPolicySnapshotBySnapshotId: async () => held.policy ? [held.policy] : []
        },
        network: 'regtest',
        getIdentity: () => IDENTITIES[0],
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {}
    });
    pub.resolveCapabilitySet = async (cap, block) =>
        cap === 'cross_chain' && block === BLOCK ? SET : [];
    return pub;
}

function sign(pub, row, count){
    const canonical = row.transfer_id
        ? pub.bridgeTransferCanonical(row)
        : pub.policySnapshotCanonical(row);
    row.validator_signatures = JSON.stringify(IDENTITIES.slice(0, count).map(id => ({
        pubkey: id.getPubkeyHex().toLowerCase(), sig: id.sign(canonical)
    })));
    return row;
}

function snapshots(){
    return SET.map(v => ({
        snapshot_block: BLOCK, capability: 'cross_chain', signing_pubkey: v.pubkey,
        amount: v.amount, source: v.source
    }));
}

function archive(extra){
    return Object.assign({
        network: 'regtest', matches: [], calls: [], rewards: [],
        bridge_transfers: [], policy_snapshots: [], capability_snapshots: snapshots()
    }, extra);
}

describe('archive bridge and policy follower verification', () => {
    it('accepts held terms with a full signature quorum', async () => {
        const b = bridge();
        const p = policy();
        const pub = buildPub({ bridge: b, policy: p });
        sign(pub, b, 3);
        sign(pub, p, 3);
        expect(await pub.verifyArchiveAgainstLocal(archive({
            bridge_transfers: [b], policy_snapshots: [p]
        }))).to.equal(true);
    });

    it('refuses bridge terms that diverge from the held row', async () => {
        const local = bridge();
        const archived = Object.assign({}, local, { amount: '150000001' });
        const pub = buildPub({ bridge: local });
        sign(pub, archived, 3);
        expect(await pub.verifyArchiveAgainstLocal(archive({ bridge_transfers: [archived] }))).to.equal(false);
    });

    it('refuses a bridge row with only a sub-quorum signature set', async () => {
        const pub = buildPub();
        const row = sign(pub, bridge(), 2);
        expect(await pub.verifyArchiveAgainstLocal(archive({ bridge_transfers: [row] }))).to.equal(false);
    });

    it('refuses an archive that drops the required cross_chain snapshot group', async () => {
        const pub = buildPub();
        const row = sign(pub, bridge(), 3);
        expect(await pub.verifyArchiveAgainstLocal(archive({
            bridge_transfers: [row], capability_snapshots: []
        }))).to.equal(false);
    });

    it('refuses unhashed policy lists when the follower does not hold the row', async () => {
        const pub = buildPub();
        const row = policy();
        sign(pub, row, 3);
        row.allow_list = JSON.stringify(['attacker']);
        expect(await pub.verifyArchiveAgainstLocal(archive({ policy_snapshots: [row] }))).to.equal(false);
    });
});

describe('archive bridge and policy row shape', () => {
    it('refuses a quorum-signed policy row filed under bridge_transfers', async () => {
        const pub = buildPub();
        const row = sign(pub, policy(), 3);
        expect(await pub.verifyArchiveAgainstLocal(archive({ bridge_transfers: [row] }))).to.equal(false);
    });

    it('refuses a quorum-signed transfer row filed under policy_snapshots', async () => {
        const pub = buildPub();
        const row = sign(pub, bridge(), 3);
        row.policy_hash = policy().policy_hash;
        row.allow_list = policy().allow_list;
        row.block_list = policy().block_list;
        row.sleeping = 0;
        expect(await pub.verifyArchiveAgainstLocal(archive({ policy_snapshots: [row] }))).to.equal(false);
    });

    it('refuses without throwing a row carrying both ids in either array', async () => {
        const pub = buildPub();
        const both = Object.assign(bridge(), { snapshot_id: 'b'.repeat(64) });
        expect(await pub.verifyArchiveAgainstLocal(archive({ bridge_transfers: [both] }))).to.equal(false);
        expect(await pub.verifyArchiveAgainstLocal(archive({ policy_snapshots: [both] }))).to.equal(false);
    });

    it('refuses without throwing a row carrying neither id or a malformed id', async () => {
        const pub = buildPub();
        const neither = bridge();
        delete neither.transfer_id;
        const nonHex = Object.assign(bridge(), { transfer_id: 'g'.repeat(64) });
        const short = Object.assign(bridge(), { transfer_id: 'a'.repeat(63) });
        expect(await pub.verifyArchiveAgainstLocal(archive({ bridge_transfers: [neither] }))).to.equal(false);
        expect(await pub.verifyArchiveAgainstLocal(archive({ policy_snapshots: [neither] }))).to.equal(false);
        expect(await pub.verifyArchiveAgainstLocal(archive({ bridge_transfers: [nonHex] }))).to.equal(false);
        expect(await pub.verifyArchiveAgainstLocal(archive({ bridge_transfers: [short] }))).to.equal(false);
    });

    // Followers co-sign an id case-insensitively, so a refused held row would stall every later archive.
    it('accepts a quorum-signed held row whose id is upper-case hex', async () => {
        const transfer = Object.assign(bridge(), { transfer_id: 'A'.repeat(64) });
        const snapshot = Object.assign(policy(), { snapshot_id: 'B'.repeat(64) });
        const pub = buildPub({ bridge: transfer, policy: snapshot });
        sign(pub, transfer, 3);
        sign(pub, snapshot, 3);
        expect(await pub.verifyArchiveAgainstLocal(archive({
            bridge_transfers: [transfer], policy_snapshots: [snapshot]
        }))).to.equal(true);
    });
});
