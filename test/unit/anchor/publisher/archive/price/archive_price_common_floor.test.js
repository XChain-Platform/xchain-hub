'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pins the archive price common floor. The rail case: the leader's oldest pending
// price round predates every follower's history, so a follower that does not hold it
// can judge it only by its signature quorum over the shared price set at its reference
// block, which does not resolve there; it declined the whole batch on every flush. The
// leader now omits such rounds (and reads the next page above them), so the follower
// co-signs a batch made only of rounds it can check, and still declines the old round.

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../../src/validators/identity');
const { DB_METHODS } = require('../../../../../helpers/mockHub.js');
const priceBookkeeping = require('../../../../../../src/db/prices/archive_bookkeeping.js');
const vectors = require('../../../../../fixtures/anchor_archive_vectors.json');

const SHARED_BLOCK = 111;      // the shared source answers here, and not at the old round's block
const OLD_BLOCK = 101;
const IDENTITIES = ['11', '22', '33'].map(seed => new ValidatorIdentity(seed.repeat(32)));
const SET = IDENTITIES.map((identity, index) => ({
    pubkey: identity.getPubkeyHex().toLowerCase(), weight: '1', amount: '1', source: 'stake-' + index
}));

function copy(value){
    return JSON.parse(JSON.stringify(value));
}

// The shared snapshot source every hub reads alike: it has no price set at OLD_BLOCK.
const sharedSnapshots = {
    getSnapshot: async (capability, block) =>
        (capability === 'price' && block === SHARED_BLOCK ? { validators: SET } : null),
    getWeightSnapshot: async (capability, block) =>
        (capability === 'price' && block === SHARED_BLOCK ? { validators: SET } : null)
};

// A regtest hub holding `held` price rows. The leader also holds the set at OLD_BLOCK
// in its own capability_snapshots table, which no follower shares.
function hub(held, ownTableSet, queries){
    const pub = new StateAnchorPublisher({
        db: {
            ...DB_METHODS,
            ...priceBookkeeping,
            doQuery: async (sql, params) => { if(queries) queries.push({ sql, params }); return []; },
            findPriceSnapshotsForRound: async round => held.filter(row => Number(row.round_number) === Number(round)),
            findCapabilitySnapshotsBySnapshotBlock: async (block, capability) =>
                (ownTableSet && capability === 'price' && block === OLD_BLOCK
                    ? SET.map(v => ({ signing_pubkey: v.pubkey, amount: v.amount, source: v.source })) : [])
        },
        network: 'regtest',
        capabilitySnapshot: sharedSnapshots,
        getIdentity: () => IDENTITIES[0],
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {}
    });
    pub.network = 'regtest';
    return pub;
}

function signRound(pub, rows){
    const canonical = pub.priceSnapshotCanonical(rows, 'regtest');
    const proof = JSON.stringify(IDENTITIES.map(identity => ({
        pubkey: identity.getPubkeyHex().toLowerCase(), sig: identity.sign(canonical)
    })));
    for(const row of rows) row.consensus_proof = proof;
    return rows;
}

// Round 11 from the vectors at the shared block, and an older round 9 at OLD_BLOCK.
function rounds(pub){
    const recent = copy(vectors.P.inputs.prices.filter(row => row.round_number === 11));
    const old = copy(recent).map(row => Object.assign(row, { round_number: 9, reference_block: OLD_BLOCK }));
    return { old: signRound(pub, old), recent: signRound(pub, recent) };
}

describe('archive price rounds below the federation common floor', () => {
    it('the leader omits a round a co-signer without it could not verify, and reads past it', async () => {
        const queries = [];
        const leader = hub([], true, queries);
        const { old, recent } = rounds(leader);

        const kept = await leader.priceRoundsAboveCommonFloor(old.concat(recent));
        expect(kept.map(row => row.round_number)).to.deep.equal(recent.map(() => 11));
        expect(leader.priceArchiveFloor()).to.equal(10);
        await leader.pendingPriceRounds(5);
        expect(queries[queries.length - 1].params).to.deep.equal([10, 5]);
    });

    it('a follower whose history starts after the old round co-signs the leader batch, not the old round', async () => {
        const leader = hub([], true);
        const { old, recent } = rounds(leader);
        const batch = await leader.priceRoundsAboveCommonFloor(old.concat(recent));
        const follower = hub(copy(recent), false);

        expect(await follower.verifyArchivedPriceSnapshots(batch, { network: 'regtest' })).to.equal(true);
        expect(await follower.verifyArchivedPriceSnapshots(old.concat(recent), { network: 'regtest' }))
            .to.equal(false);
    });

    it('keeps every round when no shared snapshot source exists', async () => {
        const leader = hub([], true);
        leader.capSnapshot = null;
        const { old, recent } = rounds(leader);
        expect(await leader.priceRoundsAboveCommonFloor(old.concat(recent))).to.have.length(old.length + recent.length);
        expect(leader.priceArchiveFloor()).to.equal(0);
    });
});
