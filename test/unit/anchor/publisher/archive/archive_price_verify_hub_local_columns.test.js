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

const PRICE_BLOCK = 111;
const IDENTITIES = ['11', '22', '33'].map(seed => new ValidatorIdentity(seed.repeat(32)));
const SET = IDENTITIES.map((identity, index) => ({
    pubkey: identity.getPubkeyHex().toLowerCase(), amount: '1', source: 'stake-' + index
}));

function copy(value){
    return JSON.parse(JSON.stringify(value));
}

function buildPub(prices){
    const pub = new StateAnchorPublisher({
        db: {
            ...DB_METHODS,
            findPriceSnapshotsForRound: async round =>
                prices.filter(row => Number(row.round_number) === Number(round))
        },
        network: 'regtest',
        getIdentity: () => IDENTITIES[0],
        getPeerManager: () => ({ broadcast() {} }),
        p2pConfig: {}
    });
    pub.resolveCapabilitySet = async (capability, block) =>
        capability === 'price' && block === PRICE_BLOCK ? SET : [];
    return pub;
}

function signaturePrices(){
    return copy(vectors.P.inputs.prices.filter(row => row.round_number === 11));
}

function signPrices(pub, rows, identities){
    const canonical = pub.priceSnapshotCanonical(rows);
    const proof = JSON.stringify(identities.map(identity => ({
        pubkey: identity.getPubkeyHex().toLowerCase(), sig: identity.sign(canonical)
    })));
    for(const row of rows) row.consensus_proof = proof;
    return rows;
}

describe('archive price follower hub-local columns', () => {
    it('accepts a signature-proofed round with different held proof and validator count', async () => {
        const held = signaturePrices();
        const pub = buildPub(held);
        signPrices(pub, held, [IDENTITIES[2], IDENTITIES[1]]);
        for(const row of held) row.validator_count = 2;
        const archived = signaturePrices();
        signPrices(pub, archived, IDENTITIES);
        for(const row of archived) row.validator_count = 3;

        expect(await pub.verifyArchivedPriceGroup(archived, { network: 'regtest' }))
            .to.equal(true);
    });

    it('refuses a signature-proofed round with a different held price', async () => {
        const held = signaturePrices();
        const pub = buildPub(held);
        signPrices(pub, held, [IDENTITIES[1], IDENTITIES[2]]);
        held[0].price = String(Number(held[0].price) + 1);
        const archived = signaturePrices();
        signPrices(pub, archived, IDENTITIES);

        expect(await pub.verifyArchivedPriceGroup(archived, { network: 'regtest' }))
            .to.equal(false);
    });

    it('recognizes only parsed signature entries as signature proofs', () => {
        const pub = buildPub([]);
        expect(pub.isSignatureProofedPrice({
            consensus_proof: JSON.stringify([SET[0].pubkey, SET[1].pubkey])
        })).to.equal(false);
        expect(pub.isSignatureProofedPrice({
            consensus_proof: JSON.stringify([{ pubkey: SET[0].pubkey, sig: 'aa' }])
        })).to.equal(true);
    });

    it('refuses a batch-proofed row with a different held validator count', async () => {
        const archived = copy(vectors.P.inputs.prices.find(row => row.round_number === 12));
        const held = copy(archived);
        held.validator_count = Number(held.validator_count) + 1;
        const pub = buildPub([held]);

        expect(await pub.verifyArchivedPriceGroup([archived], { network: 'regtest' }))
            .to.equal(false);
    });
});
