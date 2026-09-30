'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../../src/validators/identity');
const { DB_METHODS } = require('../../../../../helpers/mockHub.js');
const vectors = require('../../../../../fixtures/anchor_archive_vectors.json');

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

function signPrices(pub, rows){
    const canonical = pub.priceSnapshotCanonical(rows);
    const proof = JSON.stringify(IDENTITIES.map(identity => ({
        pubkey: identity.getPubkeyHex().toLowerCase(), sig: identity.sign(canonical)
    })));
    for(const row of rows) row.consensus_proof = proof;
    return rows;
}

describe('archive price local skipped rows', () => {
    it('accepts a signature-proofed round over a held skipped marker', async () => {
        const archived = signaturePrices();
        const held = copy(archived[0]);
        held.price = null;
        held.consensus_proof = '[]';
        held.status = 'skipped';
        held.reference_block = Number(held.reference_block) + 10;
        held.block_timestamp = Number(held.block_timestamp) + 1000;
        const pub = buildPub([held]);
        signPrices(pub, archived);

        expect(await pub.verifyArchivedPriceGroup(archived, { network: 'regtest' }))
            .to.equal(true);
    });

    it('refuses a signature-proofed round over a different finalized price', async () => {
        const archived = signaturePrices();
        const held = copy(archived[0]);
        held.price = String(Number(held.price) + 1);
        const pub = buildPub([held]);
        signPrices(pub, archived);

        expect(await pub.verifyArchivedPriceGroup(archived, { network: 'regtest' }))
            .to.equal(false);
    });

    it('refuses a non-signature-proofed group when the held row differs', async () => {
        const archived = copy(vectors.P.inputs.prices.find(row => row.round_number === 12));
        const held = copy(archived);
        held.price = String(Number(held.price) + 1);
        const pub = buildPub([held]);

        expect(pub.isSignatureProofedPrice(archived)).to.equal(false);
        expect(await pub.verifyArchivedPriceGroup([archived], { network: 'regtest' }))
            .to.equal(false);
    });
});
