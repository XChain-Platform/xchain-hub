'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');

const LEADER_PROOF = '["aa","bb","cc"]';
const FOLLOWER_PROOF = '["bb","aa","cc"]';

function digest(proof){
    return crypto.createHash('sha256').update(proof).digest('hex');
}

function announcedPrice(extra){
    return Object.assign({
        round_number: 11,
        coin_pair: 'BTC/USD',
        status: 'finalized',
        batch_block_time: 1234,
        proof_sha: digest(LEADER_PROOF)
    }, extra);
}

function quorumRows(prices){
    return { bridges: [], policies: [], checkpoints: [], prices, tombstones: [] };
}

function publisher(db){
    return new StateAnchorPublisher({
        db,
        network: 'regtest',
        p2pConfig: {},
        getIdentity: () => null,
        getPeerManager: () => null
    });
}

function heldPrice(extra){
    return Object.assign({
        coin_pair: 'BTC/USD',
        status: 'finalized',
        batch_block_time: 1234,
        consensus_proof: FOLLOWER_PROOF
    }, extra);
}

describe('verifyFinalizedAgainstLocal follower price proofs', function () {
    it('accepts a leader proof digest that differs from the follower proof', async function () {
        const pub = publisher({
            findPriceSnapshotsForRound: async () => [heldPrice()]
        });

        const verified = await pub.verifyFinalizedAgainstLocal(
            [], [], [], quorumRows([announcedPrice()]));

        expect(verified).to.equal(true);
    });

    it('rejects a status mismatch against the follower row', async function () {
        const pub = publisher({
            findPriceSnapshotsForRound: async () => [heldPrice({ status: 'pending' })]
        });

        const verified = await pub.verifyFinalizedAgainstLocal(
            [], [], [], quorumRows([announcedPrice()]));

        expect(verified).to.equal(false);
    });

    it('rejects a batch block time mismatch against the follower row', async function () {
        const pub = publisher({
            findPriceSnapshotsForRound: async () => [heldPrice({ batch_block_time: 1235 })]
        });

        const verified = await pub.verifyFinalizedAgainstLocal(
            [], [], [], quorumRows([announcedPrice()]));

        expect(verified).to.equal(false);
    });
});

describe('applyFinalized follower price proof stamp', function () {
    it('stamps only held pairs with the follower proof digest', async function () {
        const stamps = [];
        const pub = publisher({
            findPriceSnapshotsForRound: async () => [heldPrice()],
            updatePriceSnapshotArchiveBatchSeq: async (...args) => stamps.push(args)
        });
        const prices = [
            announcedPrice(),
            announcedPrice({ coin_pair: 'ETH/USD' })
        ];

        await pub.applyFinalized({
            batch_seq: 7,
            txid: null,
            matches: []
        }, 'sender', [], [], quorumRows(prices));

        expect(stamps).to.deep.equal([[
            7, 'finalized', 1234, digest(FOLLOWER_PROOF), 11, 'BTC/USD'
        ]]);
    });
});
