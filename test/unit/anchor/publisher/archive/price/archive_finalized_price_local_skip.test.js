'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');

const PROOF = '["aa","bb","cc"]';

function digest(proof){
    return crypto.createHash('sha256').update(proof).digest('hex');
}

function announcedPrice(extra){
    return Object.assign({
        round_number: 11,
        coin_pair: 'BTC/USD',
        status: 'finalized',
        batch_block_time: 1234,
        proof_sha: digest(PROOF)
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
        consensus_proof: PROOF
    }, extra);
}

describe('FINALIZED follower local skipped price marker', function () {
    it('accepts a finalized announcement over a local skipped marker', async function () {
        const pub = publisher({
            findPriceSnapshotsForRound: async () => [heldPrice({
                status: 'skipped',
                batch_block_time: 0
            })]
        });

        const verified = await pub.verifyFinalizedAgainstLocal(
            [], [], [], quorumRows([announcedPrice()]));

        expect(verified).to.equal(true);
    });

    it('backfills announced matches without stamping the skipped marker', async function () {
        const matchStamps = [];
        const priceStamps = [];
        const pub = publisher({
            findPriceSnapshotsForRound: async () => [heldPrice({
                status: 'skipped',
                batch_block_time: 0
            })],
            updateCrossChainMatchByMatchIdAndBatchSeq: async (...args) => matchStamps.push(args),
            updatePriceSnapshotArchiveBatchSeq: async (...args) => priceStamps.push(args)
        });
        const backfills = [];
        const backfillBatch = pub.backfillBatch.bind(pub);
        pub.backfillBatch = async (...args) => {
            backfills.push(args);
            return backfillBatch(...args);
        };
        const matches = [{ match_id: 'match-1', status: 'finalized' }];

        await pub.applyFinalized({
            batch_seq: 7,
            txid: null,
            matches
        }, 'sender', [], [], quorumRows([announcedPrice()]));

        expect(backfills).to.have.length(1);
        expect(backfills[0][1]).to.deep.equal(matches);
        expect(matchStamps).to.deep.equal([[7, 'finalized', null, 'match-1']]);
        expect(priceStamps).to.deep.equal([]);
    });

    it('still rejects finalized rows with a mismatched status or block time', async function () {
        const pub = publisher({
            findPriceSnapshotsForRound: async () => [heldPrice()]
        });

        const statusVerified = await pub.verifyFinalizedAgainstLocal(
            [], [], [], quorumRows([announcedPrice({ status: 'disputed' })]));
        const timeVerified = await pub.verifyFinalizedAgainstLocal(
            [], [], [], quorumRows([announcedPrice({ batch_block_time: 1235 })]));

        expect(statusVerified).to.equal(false);
        expect(timeVerified).to.equal(false);
    });
});
