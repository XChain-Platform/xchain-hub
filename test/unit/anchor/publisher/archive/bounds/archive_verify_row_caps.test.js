'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const { ARCHIVE_MAX_POLICY_ROWS, ARCHIVE_MAX_LIST_ROWS, ARCHIVE_MAX_PRICE_ROUNDS } =
    require('../../../../../../src/anchor/publisher/constants.js');
const { DB_METHODS } = require('../../../../../helpers/mockHub.js');

function buildPub(){
    const pub = new StateAnchorPublisher({
        db: { ...DB_METHODS }, network: 'regtest', getIdentity: () => null,
        getPeerManager: () => ({ broadcast() {} }), p2pConfig: {}
    });
    const calls = { bridge: 0, policy: 0, list: 0, checkpoint: 0, price: 0, tombstone: 0 };
    pub.verifyArchivedBridgeTransfer = async () => { calls.bridge++; return true; };
    pub.verifyArchivedPolicySnapshot = async () => { calls.policy++; return true; };
    pub.verifyArchivedListSnapshot = async () => { calls.list++; return true; };
    pub.verifyArchivedStateCheckpoint = async () => { calls.checkpoint++; return true; };
    pub.verifyArchivedPriceSnapshots = async () => { calls.price++; return true; };
    pub.verifyArchivedPriceTombstone = async () => { calls.tombstone++; return true; };
    pub.archivedSnapshotGroups = () => new Map();
    pub.seedRequiredSnapshotGroups = () => true;
    pub.verifyArchivedSnapshotGroups = async () => true;
    return { pub, calls };
}

function archive(over){
    return Object.assign({ matches: [] }, over);
}

function rows(count, prefix){
    return Array.from({ length: count }, (_, i) => ({ snapshot_id: prefix + i }));
}

function registerRowKindTests(){
    it('refuses every non-array row kind before per-row verification', async () => {
        const keys = ['matches', 'calls', 'rewards', 'capability_snapshots',
            'bridge_transfers', 'state_checkpoints', 'price_tombstones'];
        for(const key of keys){
            for(const value of [{}, 1]){
                const { pub, calls } = buildPub();
                expect(await pub.verifyArchiveAgainstLocal(archive({ [key]: value }), 1), key)
                    .to.equal(false);
                expect(calls.bridge + calls.checkpoint + calls.tombstone, key).to.equal(0);
            }
        }
    });

    it('accepts every optional row kind as an empty array', async () => {
        expect(await buildPub().pub.verifyArchiveAgainstLocal(archive({
            calls: [], rewards: [], capability_snapshots: [], bridge_transfers: [],
            policy_snapshots: [], list_snapshots: [], state_checkpoints: [],
            price_snapshots: [], price_tombstones: []
        }), 1)).to.equal(true);
    });
}

describe('archive verifier row caps', () => {
    it('refuses policy rows over the cap before per-row verification', async () => {
        const { pub, calls } = buildPub();
        expect(await pub.verifyArchiveAgainstLocal(archive({
            policy_snapshots: rows(ARCHIVE_MAX_POLICY_ROWS + 1, 'p')
        }), 1)).to.equal(false);
        expect(calls.policy).to.equal(0);
    });

    it('accepts policy and list rows at their caps', async () => {
        const { pub, calls } = buildPub();
        expect(await pub.verifyArchiveAgainstLocal(archive({
            policy_snapshots: rows(ARCHIVE_MAX_POLICY_ROWS, 'p'),
            list_snapshots: rows(ARCHIVE_MAX_LIST_ROWS, 'l')
        }), 1)).to.equal(true);
        expect(calls.policy).to.equal(ARCHIVE_MAX_POLICY_ROWS);
        expect(calls.list).to.equal(ARCHIVE_MAX_LIST_ROWS);
    });

    it('refuses list rows over the cap before per-row verification', async () => {
        const { pub, calls } = buildPub();
        expect(await pub.verifyArchiveAgainstLocal(archive({
            list_snapshots: rows(ARCHIVE_MAX_LIST_ROWS + 1, 'l')
        }), 1)).to.equal(false);
        expect(calls.list).to.equal(0);
    });

    it('caps distinct price rounds rather than price rows', async () => {
        const atCap = Array.from({ length: ARCHIVE_MAX_PRICE_ROUNDS }, (_, round) =>
            [0, 1, 2].map(pair => ({ round_number: round, coin_pair: String(pair) }))).flat();
        const accepted = buildPub();
        expect(await accepted.pub.verifyArchiveAgainstLocal(archive({ price_snapshots: atCap }), 1))
            .to.equal(true);
        expect(accepted.calls.price).to.equal(1);

        const refused = buildPub();
        const overCap = atCap.concat({ round_number: ARCHIVE_MAX_PRICE_ROUNDS, coin_pair: '0' });
        expect(await refused.pub.verifyArchiveAgainstLocal(archive({ price_snapshots: overCap }), 1))
            .to.equal(false);
        expect(refused.calls.price).to.equal(0);
    });

    it('refuses duplicate policy or list ids and non-array capped kinds', async () => {
        for(const over of [
            { policy_snapshots: rows(2, 'same').map(row => ({ snapshot_id: 'same' })) },
            { list_snapshots: rows(2, 'same').map(row => ({ snapshot_id: 'same' })) },
            { policy_snapshots: 'not-an-array' }
        ]){
            expect(await buildPub().pub.verifyArchiveAgainstLocal(archive(over), 1)).to.equal(false);
        }
    });

    registerRowKindTests();

    it('allows an archive with none of the capped keys', async () => {
        expect(await buildPub().pub.verifyArchiveAgainstLocal(archive({}), 1)).to.equal(true);
    });
});
