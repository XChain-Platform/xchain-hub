'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const { expect } = require('chai');
const sinon = require('sinon');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const { getLogger } = require('../../../../../src/observability');
const { listMetaHash } = require('../../../../../src/cross_chain/list/canonical.js');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');
const vectors = require('../../../../fixtures/anchor_archive_vectors.json');

const BLOCK = 100;
const PREDATES = 'predates our local history';

function copy(value){
    return JSON.parse(JSON.stringify(value));
}

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

function listRow(){
    return {
        id: 1, snapshot_id: 'c0e9a6b57adfc25378343388363aad10498fd201a36cd32dddb1ee35da265f21',
        snapshot_block: 160000, network: 'regtest', home_chain: 'DOGE', home_list_index: 880001,
        list_type: 2, seq: 1, kind: 'full', origin_block: 68000000,
        members_hash: 'ff0e5a860d907b646255b7ab798db5057319b71c20facd02b9856b9a956320cb',
        added: JSON.stringify(['bc1qmemberalpha', 'ltc1qmemberbeta']), removed: '[]',
        admit_block_btc: 160010, admit_block_ltc: 4905000, admit_block_doge: 68000010,
        finalizing_view: 0, validator_signatures: '[]', status: 'finalized',
        name: 'Alpha list', description: 'Members of alpha',
        meta_hash: listMetaHash('Alpha list', 'Members of alpha')
    };
}

function checkpointRow(){
    return copy(vectors.C.inputs.checkpoints[0]);
}

function priceRows(){
    return copy(vectors.P.inputs.prices.filter(row => row.round_number === 11));
}

// One publisher whose every lookup returns `held`, with each quorum check passing.
function buildPub(held){
    const rows = value => value ? [value] : [];
    const pub = new StateAnchorPublisher({
        db: {
            ...DB_METHODS,
            getBridgeTransferByTransferId: async () => rows(held.bridge),
            getPolicySnapshotBySnapshotId: async () => rows(held.policy),
            getListSnapshotBySnapshotId: async () => rows(held.list),
            getStateCheckpointByChainAndNetworkAndCheckpointSeq: async () => rows(held.checkpoint),
            findPriceSnapshotsForRound: async () => held.prices || []
        },
        network: 'regtest',
        getIdentity: () => null,
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {}
    });
    pub.resolveCapabilitySet = async () => [];
    pub.quorumVerified = () => true;
    pub.verifyArchivedBridgePolicyQuorum = async () => true;
    return pub;
}

// Each kind: the held fixture, the archived row and the verifier call.
const KINDS = [
    { name: 'bridge transfer', held: () => ({ bridge: bridge() }),
      run: (pub, held) => pub.verifyArchivedBridgeTransfer(pub.serializeBridgeTransfer(held.bridge || bridge())) },
    { name: 'policy snapshot', held: () => ({ policy: policy() }),
      run: (pub, held) => pub.verifyArchivedPolicySnapshot(pub.serializePolicySnapshot(held.policy || policy())) },
    { name: 'list snapshot', held: () => ({ list: listRow() }),
      run: (pub, held) => pub.verifyArchivedListSnapshot(pub.serializeListSnapshot(held.list || listRow())) },
    { name: 'state checkpoint', held: () => ({ checkpoint: checkpointRow() }),
      run: (pub, held) => pub.verifyArchivedStateCheckpoint(
          pub.serializeStateCheckpoint(held.checkpoint || checkpointRow())) },
    { name: 'price group', held: () => ({ prices: priceRows() }),
      run: (pub, held) => pub.verifyArchivedPriceGroup(
          (held.prices || priceRows()).map(row => pub.serializePriceSnapshot(row)), { network: 'regtest' }) }
];

describe('archive verifiers log a row this hub never held', () => {
    let info;

    beforeEach(() => {
        info = sinon.spy(getLogger(), 'info');
    });

    afterEach(() => {
        info.restore();
    });

    function predatesLogged(){
        return info.getCalls().some(call => String(call.args[0]).includes(PREDATES));
    }

    for(const kind of KINDS){
        it('logs the quorum-only acceptance of an unheld ' + kind.name, async () => {
            const pub = buildPub({});
            expect(await kind.run(pub, {})).to.equal(true);
            expect(predatesLogged()).to.equal(true);
        });

        it('logs nothing of the kind for a held ' + kind.name, async () => {
            const held = kind.held();
            const pub = buildPub(held);
            expect(await kind.run(pub, held)).to.equal(true);
            expect(predatesLogged()).to.equal(false);
        });
    }

    it('logs a price tombstone accepted with no live row here', async () => {
        const live = priceRows()[0];
        const pub = buildPub({ prices: [] });
        expect(await pub.verifyArchivedPriceTombstone({
            round_number: live.round_number, coin_pair: live.coin_pair
        })).to.equal(true);
        expect(info.getCalls().some(call =>
            String(call.args[0]).includes('accepting on local absence alone'))).to.equal(true);
    });
});
