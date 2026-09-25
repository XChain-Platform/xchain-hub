'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../src/validators/identity');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');
const vectors = require('../../../../fixtures/anchor_archive_vectors.json');

const CHECKPOINT_BLOCK = 70;
const PRICE_BLOCK = 111;
const IDENTITIES = ['11', '22', '33'].map(seed => new ValidatorIdentity(seed.repeat(32)));
const SET = IDENTITIES.map((identity, index) => ({
    pubkey: identity.getPubkeyHex().toLowerCase(), amount: '1', source: 'stake-' + index
}));

function copy(value){
    return JSON.parse(JSON.stringify(value));
}

function buildPub(held){
    held = held || {};
    const pub = new StateAnchorPublisher({
        db: {
            ...DB_METHODS,
            getStateCheckpointByChainAndNetworkAndCheckpointSeq: async () =>
                held.checkpoint ? [held.checkpoint] : [],
            findPriceSnapshotsForRound: async round =>
                (held.prices || []).filter(row => Number(row.round_number) === Number(round))
        },
        network: 'regtest',
        getIdentity: () => IDENTITIES[0],
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {}
    });
    pub.resolveCapabilitySet = async (capability, block) =>
        ((capability === 'oracle_publish' && block === CHECKPOINT_BLOCK) ||
         (capability === 'price' && block === PRICE_BLOCK)) ? SET : [];
    return pub;
}

function signCheckpoint(pub, row){
    const canonical = pub.stateCheckpointCanonical(row);
    row.validator_signatures = JSON.stringify(IDENTITIES.map(identity => ({
        pubkey: identity.getPubkeyHex().toLowerCase(), sig: identity.sign(canonical)
    })));
    return row;
}

function signPrices(pub, rows){
    const canonical = pub.priceSnapshotCanonical(rows);
    const proof = JSON.stringify(IDENTITIES.map(identity => ({
        pubkey: identity.getPubkeyHex().toLowerCase(), sig: identity.sign(canonical)
    })));
    for(const row of rows) row.consensus_proof = proof;
    return rows;
}

function snapshots(){
    return ['oracle_publish', 'price'].flatMap(capability => SET.map(member => ({
        snapshot_block: capability === 'price' ? PRICE_BLOCK : CHECKPOINT_BLOCK,
        capability,
        signing_pubkey: member.pubkey,
        amount: member.amount,
        source: member.source
    })));
}

function archive(extra){
    return Object.assign({
        network: 'regtest', matches: [], calls: [], rewards: [],
        state_checkpoints: [], price_snapshots: [], price_tombstones: [],
        capability_snapshots: snapshots()
    }, extra);
}

function checkpoint(){
    return copy(vectors.C.inputs.checkpoints.find(row => row.snapshot_block === CHECKPOINT_BLOCK));
}

function signaturePrices(){
    return copy(vectors.P.inputs.prices.filter(row => row.round_number === 11));
}

describe('archive checkpoint and price follower verification', () => {
    it('accepts checkpoint and signature-proofed price quorums', async () => {
        const pub = buildPub();
        const cp = signCheckpoint(pub, checkpoint());
        const prices = signPrices(pub, signaturePrices());
        expect(await pub.verifyArchiveAgainstLocal(archive({
            state_checkpoints: [cp], price_snapshots: prices
        }))).to.equal(true);
    });

    it('refuses a forged checkpoint signature', async () => {
        const pub = buildPub();
        const cp = signCheckpoint(pub, checkpoint());
        cp.validator_signatures = JSON.stringify([{
            pubkey: SET[0].pubkey, sig: '00'.repeat(64)
        }]);
        expect(await pub.verifyArchiveAgainstLocal(archive({
            state_checkpoints: [cp]
        }))).to.equal(false);
    });

    it('refuses a signature-proofed round with its price group dropped', async () => {
        const pub = buildPub();
        const prices = signPrices(pub, signaturePrices());
        expect(await pub.verifyArchiveAgainstLocal(archive({
            price_snapshots: prices,
            capability_snapshots: snapshots().filter(row => row.capability !== 'price')
        }))).to.equal(false);
    });

    it('refuses a batch-proofed row the follower does not hold', async () => {
        const pub = buildPub();
        const batchRow = copy(vectors.P.inputs.prices.find(row => row.round_number === 12));
        expect(await pub.verifyArchiveAgainstLocal(archive({
            price_snapshots: [batchRow]
        }))).to.equal(false);
    });

    it('refuses a batch_block_time mismatch against a held price row', async () => {
        const pub = buildPub();
        const local = signaturePrices();
        signPrices(pub, local);
        const archived = copy(local);
        archived[0].batch_block_time = Number(archived[0].batch_block_time) + 1;
        pub.db.findPriceSnapshotsForRound = async () => local;
        expect(await pub.verifyArchiveAgainstLocal(archive({
            price_snapshots: archived
        }))).to.equal(false);
    });

    it('refuses a tombstone over a live local row', async () => {
        const live = copy(vectors.P.inputs.prices.find(row => row.round_number === 12));
        const pub = buildPub({ prices: [live] });
        expect(await pub.verifyArchiveAgainstLocal(archive({
            price_tombstones: [{ round_number: live.round_number, coin_pair: live.coin_pair }]
        }))).to.equal(false);
    });
});
