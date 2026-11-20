'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const canonicalForms = require('../../../../../../src/anchor/publisher/canonical_forms.js');
const ValidatorIdentity = require('../../../../../../src/validators/identity');
const { archivedSignaturesRefusal } = require('../../../../../../src/anchor/publisher/archive/unheld_row.js');
const { DB_METHODS } = require('../../../../../helpers/mockHub.js');

const BLOCK = 100;
const IDENTITIES = ['11', '22', '33'].map((seed) => new ValidatorIdentity(seed.repeat(32)));
const SET = IDENTITIES.map((identity, index) => ({
    pubkey: identity.getPubkeyHex().toLowerCase(),
    amount: '1',
    source: 'stake-' + index,
}));

function bridge() {
    return {
        id: 1,
        transfer_id: 'a'.repeat(64),
        snapshot_block: BLOCK,
        network: 'regtest',
        src_chain: 'BTC',
        src_action_index: 7,
        src_address: 'source',
        dest_chain: 'DOGE',
        dest_address: 'destination',
        tick: 'XCP',
        decimals: 8,
        amount: '150000000',
        effective_time: 123,
        admit_block_btc: null,
        admit_block_ltc: null,
        admit_block_doge: null,
        finalizing_view: 0,
        validator_signatures: '[]',
        status: 'finalized',
    };
}

function policy() {
    const allow = ['addr1', 'addr2'];
    const text = ['ALLOW', '2'].concat(allow, ['BLOCK', '-', 'SLEEP', '0']).join('|');
    return {
        id: 2,
        snapshot_id: 'b'.repeat(64),
        snapshot_block: BLOCK,
        network: 'regtest',
        origin_chain: 'BTC',
        tick: 'XCP',
        policy_seq: 3,
        origin_block: 95,
        policy_hash: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
        allow_list: JSON.stringify(allow),
        block_list: null,
        sleeping: 0,
        effective_time: 140,
        admit_block_btc: null,
        admit_block_ltc: null,
        admit_block_doge: null,
        finalizing_view: 0,
        validator_signatures: '[]',
        status: 'finalized',
    };
}

function listRow() {
    return {
        id: 1,
        snapshot_id: 'c0e9a6b57adfc25378343388363aad10498fd201a36cd32dddb1ee35da265f21',
        snapshot_block: 160000,
        network: 'mainnet',
        home_chain: 'DOGE',
        home_list_index: 880001,
        list_type: 2,
        seq: 1,
        kind: 'full',
        origin_block: 68000000,
        members_hash: 'ff0e5a860d907b646255b7ab798db5057319b71c20facd02b9856b9a956320cb',
        added: JSON.stringify(['bc1qmemberalpha', 'ltc1qmemberbeta']),
        removed: '[]',
        admit_block_btc: 160010,
        admit_block_ltc: 4905000,
        admit_block_doge: 68000010,
        finalizing_view: 0,
        validator_signatures: '[]',
        status: 'finalized',
    };
}

function match() {
    return {
        id: 3,
        match_id: 'd'.repeat(64),
        snapshot_block: BLOCK,
        network: 'regtest',
        a_chain: 'BTC',
        a_action_index: 1,
        a_kind: 'swap',
        a_tick: 'AAA',
        a_amount: '1',
        a_filled_before: '0',
        a_ownership: 0,
        a_payout_addr: 'addrA',
        a_payout_legs: null,
        b_chain: 'DOGE',
        b_action_index: 2,
        b_kind: 'swap',
        b_tick: 'BBB',
        b_amount: '2',
        b_filled_before: '0',
        b_ownership: 0,
        b_payout_addr: 'addrB',
        b_payout_legs: null,
        effective_time: 150,
        finalizing_view: 0,
        validator_signatures: '[]',
        status: 'finalized',
    };
}

function call() {
    return {
        id: 4,
        call_id: 'e'.repeat(64),
        phase: 'dispatch',
        snapshot_block: BLOCK,
        network: 'regtest',
        source_chain: 'BTC',
        source_action_index: 1,
        source_contract_index: 2,
        target_chain: 'DOGE',
        target_contract_index: 3,
        method: 'run',
        params_json: '{}',
        gas_limit: 1000,
        cross_hops: 0,
        effective_time: 160,
        finalizing_view: 0,
        result_status: null,
        return_payload_b64: null,
        validator_signatures: '[]',
        status: 'finalized',
    };
}

function buildPub(held) {
    const rows = (value) => (value ? [value] : []);
    const pub = new StateAnchorPublisher({
        db: {
            ...DB_METHODS,
            getBridgeTransferByTransferId: async () => rows(held.bridge),
            getPolicySnapshotBySnapshotId: async () => rows(held.policy),
            getListSnapshotBySnapshotId: async () => rows(held.list),
            getCrossChainMatchByMatchId: async () => rows(held.match),
            getCrossChainCallByCallIdAndPhase: async () => rows(held.call),
        },
        network: 'regtest',
        getIdentity: () => IDENTITIES[0],
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {},
    });
    pub.resolveCapabilitySet = async () => SET;
    return pub;
}

function sign(pub, row, canonical) {
    row.validator_signatures = JSON.stringify(
        IDENTITIES.map((identity) => ({
            pubkey: identity.getPubkeyHex().toLowerCase(),
            sig: identity.sign(canonical),
        })),
    );
    return row;
}

const KINDS = [
    {
        name: 'match',
        key: 'match',
        raw: match,
        serialize: (_pub, row) => canonicalForms.serializeMatch(row),
        canonical: (pub, row) => pub.matchCanonical(row),
        verify: (pub, row) => pub.verifyArchivedMatch(row),
    },
    {
        name: 'call',
        key: 'call',
        raw: call,
        serialize: (_pub, row) => canonicalForms.serializeCall(row),
        canonical: (pub, row) => pub.callCanonical(row),
        verify: (pub, row) => pub.verifyArchivedCall(row),
    },
    {
        name: 'bridge transfer',
        key: 'bridge',
        raw: bridge,
        serialize: (pub, row) => pub.serializeBridgeTransfer(row),
        canonical: (pub, row) => pub.bridgeTransferCanonical(row),
        verify: (pub, row) => pub.verifyArchivedBridgeTransfer(row),
    },
    {
        name: 'policy snapshot',
        key: 'policy',
        raw: policy,
        serialize: (pub, row) => pub.serializePolicySnapshot(row),
        canonical: (pub, row) => pub.policySnapshotCanonical(row),
        verify: (pub, row) => pub.verifyArchivedPolicySnapshot(row),
    },
    {
        name: 'list snapshot',
        key: 'list',
        raw: listRow,
        serialize: (pub, row) => pub.serializeListSnapshot(row),
        canonical: (pub, row) => pub.listSnapshotCanonical(row),
        verify: (pub, row) => pub.verifyArchivedListSnapshot(row, { list_snapshots: [row] }),
    },
];

describe('archive validator signature field shape', function () {
    it('accepts only a string field', function () {
        expect(archivedSignaturesRefusal({ validator_signatures: '[]' })).to.equal(null);
        for (const bad of [[], {}, 7, null, undefined]) {
            const row = bad === undefined ? {} : { validator_signatures: bad };
            expect(archivedSignaturesRefusal(row)).to.equal('has malformed validator_signatures');
        }
        expect(archivedSignaturesRefusal(null)).to.equal('has malformed validator_signatures');
    });

    for (const kind of KINDS) {
        for (const held of [false, true]) {
            it('refuses malformed signatures for a ' + (held ? 'held ' : 'unheld ') + kind.name, async function () {
                const local = kind.raw();
                const pub = buildPub(held ? { [kind.key]: local } : {});
                const row = kind.serialize(pub, local);
                sign(pub, row, kind.canonical(pub, row));
                expect(await kind.verify(pub, row)).to.equal(true);

                const encoded = row.validator_signatures;
                expect(await kind.verify(pub, { ...row, validator_signatures: [encoded] })).to.equal(false);
                expect(
                    await kind.verify(pub, {
                        ...row,
                        validator_signatures: JSON.parse(encoded),
                    }),
                ).to.equal(false);
            });
        }
    }
});
