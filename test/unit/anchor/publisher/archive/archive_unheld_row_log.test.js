'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const { expect } = require('chai');
const sinon = require('sinon');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const canonicalForms = require('../../../../../src/anchor/publisher/canonical_forms.js');
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

function match(){
    return {
        id: 3, match_id: 'd'.repeat(64), snapshot_block: BLOCK, network: 'regtest',
        a_chain: 'BTC', a_action_index: 1, a_kind: 'swap', a_tick: 'AAA', a_amount: '1',
        a_filled_before: '0', a_ownership: 0, a_payout_addr: 'addrA', a_payout_legs: null,
        b_chain: 'DOGE', b_action_index: 2, b_kind: 'swap', b_tick: 'BBB', b_amount: '2',
        b_filled_before: '0', b_ownership: 0, b_payout_addr: 'addrB', b_payout_legs: null,
        effective_time: 150, finalizing_view: 0, validator_signatures: '[]', status: 'finalized'
    };
}

function call(){
    return {
        id: 4, call_id: 'e'.repeat(64), phase: 'dispatch', snapshot_block: BLOCK, network: 'regtest',
        source_chain: 'BTC', source_action_index: 1, source_contract_index: 2,
        target_chain: 'DOGE', target_contract_index: 3, method: 'run', params_json: '{}',
        gas_limit: 1000, cross_hops: 0, effective_time: 160, finalizing_view: 0,
        result_status: null, return_payload_b64: null, validator_signatures: '[]', status: 'finalized'
    };
}

function checkpointRow(){
    return Object.assign(copy(vectors.C.inputs.checkpoints[0]), {
        state_root: 'a'.repeat(64), state_root_version: 1,
        block_merkle_root: 'b'.repeat(64), block_merkle_version: 1
    });
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
            getCrossChainMatchByMatchId: async () => rows(held.match),
            getCrossChainCallByCallIdAndPhase: async () => rows(held.call),
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
    { name: 'match', held: () => ({ match: match() }),
      run: (pub, held) => pub.verifyArchivedMatch(canonicalForms.serializeMatch(held.match || match())) },
    { name: 'call', held: () => ({ call: call() }),
      run: (pub, held) => pub.verifyArchivedCall(canonicalForms.serializeCall(held.call || call())) },
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

// The unsigned status column and key list of a bridge or policy row this hub never held.
describe('archive verifiers refuse an unheld bridge or policy row the builder could not emit', () => {
    const bridgeRow = over => Object.assign(StateAnchorPublisher.prototype.serializeBridgeTransfer(bridge()), over);
    const policyRow = over => Object.assign(StateAnchorPublisher.prototype.serializePolicySnapshot(policy()), over);

    it('accepts an unheld bridge transfer archived as finalized or as retracted', async () => {
        for(const status of ['finalized', 'retracted']){
            expect(await buildPub({}).verifyArchivedBridgeTransfer(bridgeRow({ status })), status).to.equal(true);
        }
    });

    it('refuses an unheld bridge transfer with a status its table never holds', async () => {
        expect(await buildPub({}).verifyArchivedBridgeTransfer(bridgeRow({ status: 'bogus' }))).to.equal(false);
    });

    it('refuses an unheld bridge transfer with an extra key or a string snapshot block', async () => {
        expect(await buildPub({}).verifyArchivedBridgeTransfer(bridgeRow({ extra: 1 }))).to.equal(false);
        expect(await buildPub({}).verifyArchivedBridgeTransfer(bridgeRow({ snapshot_block: String(BLOCK) })))
            .to.equal(false);
    });

    it('accepts an unheld finalized policy snapshot and refuses a retracted one', async () => {
        expect(await buildPub({}).verifyArchivedPolicySnapshot(policyRow())).to.equal(true);
        expect(await buildPub({}).verifyArchivedPolicySnapshot(policyRow({ status: 'retracted' }))).to.equal(false);
    });

    it('refuses an unheld policy snapshot with a missing key', async () => {
        const row = policyRow();
        delete row.effective_time;
        expect(await buildPub({}).verifyArchivedPolicySnapshot(row)).to.equal(false);
    });

    it('keeps comparing a held bridge transfer to its twin whatever the unheld rule says', async () => {
        const held = Object.assign(bridge(), { status: 'retracted' });
        expect(await buildPub({ bridge: held }).verifyArchivedBridgeTransfer(bridgeRow({ status: 'retracted' })))
            .to.equal(true);
        expect(await buildPub({ bridge: held }).verifyArchivedBridgeTransfer(bridgeRow())).to.equal(false);
    });
});

describe('archive verifiers refuse an unheld list row the builder could not emit', () => {
    const listArchiveRow = over => Object.assign(
        StateAnchorPublisher.prototype.serializeListSnapshot(listRow()), over);

    it('checks the unsigned status and complete builder shape before quorum acceptance', async () => {
        expect(await buildPub({}).verifyArchivedListSnapshot(listArchiveRow())).to.equal(true);
        for(const status of ['retracted', 'bogus']){
            expect(await buildPub({}).verifyArchivedListSnapshot(listArchiveRow({ status })), status)
                .to.equal(false);
        }
        expect(await buildPub({}).verifyArchivedListSnapshot(listArchiveRow({ extra: 1 }))).to.equal(false);
        expect(await buildPub({}).verifyArchivedListSnapshot(
            listArchiveRow({ snapshot_block: String(160000) }))).to.equal(false);
        const missing = listArchiveRow();
        delete missing.finalizing_view;
        expect(await buildPub({}).verifyArchivedListSnapshot(missing)).to.equal(false);
        const missingName = listArchiveRow();
        delete missingName.name;
        expect(await buildPub({}).verifyArchivedListSnapshot(missingName)).to.equal(false);

        expect(await buildPub({ list: listRow() }).verifyArchivedListSnapshot(listArchiveRow())).to.equal(true);
        expect(await buildPub({ list: listRow() }).verifyArchivedListSnapshot(
            listArchiveRow({ status: 'retracted' }))).to.equal(false);
    });
});

describe('archive verifiers refuse unheld match and call rows the builder could not emit', () => {
    const cases = [
        ['match', match, 'verifyArchivedMatch', 'serializeMatch'],
        ['call', call, 'verifyArchivedCall', 'serializeCall']
    ];

    for(const [name, fixture, verify, serialize] of cases){
        it('checks the unsigned status and complete builder shape for an unheld ' + name, async () => {
            const pub = buildPub({});
            const archived = over => Object.assign(canonicalForms[serialize](fixture()), over);
            for(const status of ['finalized', 'retracted'])
                expect(await pub[verify](archived({ status })), status).to.equal(true);
            expect(await pub[verify](archived({ status: 'bogus' }))).to.equal(false);
            expect(await pub[verify](archived({ extra: 1 }))).to.equal(false);
            expect(await pub[verify](archived({ snapshot_block: String(BLOCK) }))).to.equal(false);
        });
    }
});

describe('archive verifiers shape-check unheld checkpoint and price rows', () => {
    it('accepts a builder-shaped checkpoint and refuses shape drift or missing active roots', async () => {
        const pub = buildPub({});
        const good = pub.serializeStateCheckpoint(checkpointRow());
        expect(await pub.verifyArchivedStateCheckpoint(good)).to.equal(true);
        expect(await pub.verifyArchivedStateCheckpoint(Object.assign({}, good, { extra: 1 }))).to.equal(false);
        expect(await pub.verifyArchivedStateCheckpoint(Object.assign({}, good, {
            snapshot_block: String(good.snapshot_block)
        }))).to.equal(false);
        expect(await pub.verifyArchivedStateCheckpoint(Object.assign({}, good, {
            state_root: good.state_root.toUpperCase()
        }))).to.equal(false);
        expect(await pub.verifyArchivedStateCheckpoint(Object.assign({}, good, {
            block_merkle_root: null, block_merkle_version: null
        }))).to.equal(false);
        expect(await pub.verifyArchivedStateCheckpoint(Object.assign({}, good, {
            id: String(good.id)
        }))).to.equal(false);
        expect(await pub.verifyArchivedStateCheckpoint(Object.assign({}, good, {
            validator_signatures: []
        }))).to.equal(false);
    });

    it('accepts an unheld rootless checkpoint, which recovery reads, and refuses a cross-network one', async () => {
        const pub = buildPub({});
        const good = pub.serializeStateCheckpoint(checkpointRow());
        const rootless = Object.assign({}, good, {
            state_root: null, state_root_version: null,
            block_merkle_root: null, block_merkle_version: null
        });
        expect(await pub.verifyArchivedStateCheckpoint(rootless, { network: pub.network })).to.equal(true);
        expect(await pub.verifyArchivedStateCheckpoint(good, { network: pub.network })).to.equal(true);
        expect(await pub.verifyArchivedStateCheckpoint(good, { network: pub.network + '-other' })).to.equal(false);
    });

    it('accepts a builder-shaped price row and refuses extra or mis-coerced columns', async () => {
        const pub = buildPub({});
        const good = priceRows().map(row => pub.serializePriceSnapshot(row));
        expect(await pub.verifyArchivedPriceGroup(good, { network: 'regtest' })).to.equal(true);
        expect(await pub.verifyArchivedPriceGroup(
            good.map(row => Object.assign({}, row, { extra: 1 })), { network: 'regtest' })).to.equal(false);
        expect(await pub.verifyArchivedPriceGroup(
            good.map(row => Object.assign({}, row, { validator_count: String(row.validator_count) })),
            { network: 'regtest' })).to.equal(false);
    });
});
