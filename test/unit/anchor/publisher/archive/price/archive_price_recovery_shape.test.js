'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../../src/validators/identity');
const { priceRecoveryRefusal } =
    require('../../../../../../src/anchor/publisher/archive/checkpoint_price/price_recovery_shape.js');
const { DB_METHODS } = require('../../../../../helpers/mockHub.js');
const vectors = require('../../../../../fixtures/anchor_archive_vectors.json');

const PRICE_BLOCK = 111;
const IDENTITIES = ['11', '22', '33'].map(seed => new ValidatorIdentity(seed.repeat(32)));
const SET = IDENTITIES.map((identity, index) => ({
    pubkey: identity.getPubkeyHex().toLowerCase(), amount: '1', source: 'stake-' + index
}));
const JUNK = { pubkey: '00', sig: '00' };

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

function signedRound(pub, extraEntries){
    const rows = copy(vectors.P.inputs.prices.filter(row => row.round_number === 11));
    const canonical = pub.priceSnapshotCanonical(rows);
    const proof = JSON.stringify(IDENTITIES.map(identity => ({
        pubkey: identity.getPubkeyHex().toLowerCase(), sig: identity.sign(canonical)
    })).concat(extraEntries || []));
    for(const row of rows) row.consensus_proof = proof;
    return rows;
}

function mutations(){
    return [
        ['a junk proof entry', rows => {
            const proof = JSON.parse(rows[0].consensus_proof).concat([JUNK]);
            for(const row of rows) row.consensus_proof = JSON.stringify(proof);
        }],
        ['a negative validator count', rows => rows.forEach(row => { row.validator_count = -1; })],
        ['a fractional validator count', rows => rows.forEach(row => { row.validator_count = 1.5; })],
        ['a string id', rows => rows.forEach(row => { row.id = '7'; })],
        ['a missing id', rows => rows.forEach(row => { delete row.id; })],
        ['a negative id', rows => rows.forEach(row => { row.id = -1; })]
    ];
}

// Rows in the types the database driver returns: BigInt columns, NULLs and a disputed row
function storedRows(){
    return [
        { id: 9n, round_number: 20n, coin_pair: 'BTC/USD', price: null, reference_block: 120n,
          reference_chain: 'DOGE', block_timestamp: 1200n, validator_count: 3, consensus_round: null,
          consensus_proof: JSON.stringify({ batch: { first_round: 20, last_round: 25, btc_block_height: 119 },
              sigs: [{ pubkey: 'ab'.repeat(32), sig: 'cd'.repeat(64) }] }),
          status: 'disputed', source_chain: 'DOGE', source_action_index: null, batch_block_time: 0n,
          admit_block_btc: null, admit_block_ltc: 7n, admit_block_doge: null },
        { id: 10, round_number: 21, coin_pair: 'LTC/USD', price: '81.25', reference_block: 121,
          reference_chain: 'BTC', block_timestamp: 1210, validator_count: 1, consensus_round: 1,
          consensus_proof: JSON.stringify([{ pubkey: 'ab'.repeat(32), sig: 'cd'.repeat(64) }]),
          status: 'finalized', source_chain: 'BTC', source_action_index: 8, batch_block_time: 5,
          admit_block_btc: 1, admit_block_ltc: null, admit_block_doge: null }
    ];
}

function registerMutationTests(){
    for(const [label, mutate] of mutations()){
        it('refuses a held signature-proofed round with ' + label, async () => {
            const pub = buildPub([]);
            const held = signedRound(pub);
            const archived = signedRound(pub);
            mutate(archived);
            const holder = buildPub(held);
            expect(await holder.verifyArchivedPriceGroup(archived, { network: 'regtest' })).to.equal(false);
        });

        it('refuses an unheld signature-proofed round with ' + label, async () => {
            const pub = buildPub([]);
            const archived = signedRound(pub);
            mutate(archived);
            expect(await pub.verifyArchivedPriceGroup(archived, { network: 'regtest' })).to.equal(false);
        });
    }
}

describe('archive price row recovery shape', () => {
    registerMutationTests();

    it('still co-signs an honest round whose hub-local columns differ from the held ones', async () => {
        const pub = buildPub([]);
        const held = signedRound(pub);
        for(const row of held){ row.validator_count = 2; row.id += 100; }
        const archived = signedRound(pub);
        expect(await buildPub(held).verifyArchivedPriceGroup(archived, { network: 'regtest' }))
            .to.equal(true);
        expect(await pub.verifyArchivedPriceGroup(archived, { network: 'regtest' })).to.equal(true);
    });

    it('refuses a batch proof with a malformed range, signature or round placement', async () => {
        const base = copy(vectors.P.inputs.prices.find(row => row.round_number === 12));
        expect(priceRecoveryRefusal(base)).to.equal(null);
        const proofs = [
            [{ batch: { first_round: 12, last_round: 11, btc_block_height: 119 }, sigs: [] },
                'has malformed proof shape'],
            [{ batch: { first_round: 12, last_round: 17, btc_block_height: 119 }, sigs: [JUNK] },
                'has malformed proof shape'],
            [{ batch: { first_round: 13, last_round: 17, btc_block_height: 119 }, sigs: [] },
                'falls outside its batch proof range']
        ];
        for(const [proof, reason] of proofs){
            const row = Object.assign(copy(base), { consensus_proof: JSON.stringify(proof) });
            expect(priceRecoveryRefusal(row)).to.equal(reason);
            expect(await buildPub([copy(base)]).verifyArchivedPriceGroup([row], { network: 'regtest' }))
                .to.equal(false);
        }
    });

    it('admits rows shaped as the database returns them through the archive serializer', () => {
        const pub = buildPub([]);
        const stored = storedRows();
        for(const row of stored)
            expect(priceRecoveryRefusal(pub.serializePriceSnapshot(row)), row.coin_pair).to.equal(null);
    });

    it('mirrors the recovery column contract on a bare row', () => {
        const row = copy(vectors.P.inputs.prices.find(item => item.round_number === 11));
        expect(priceRecoveryRefusal(row)).to.equal(null);
        const cases = [['status', 'open', 'has malformed status'],
            ['price', 5, 'has malformed price'], ['coin_pair', '', 'has malformed coin_pair'],
            ['reference_chain', '', 'has malformed reference_chain'],
            ['admit_block_ltc', -1, 'has malformed admit_block_ltc'],
            ['consensus_proof', '{', 'has malformed consensus_proof']];
        for(const [key, value, reason] of cases)
            expect(priceRecoveryRefusal(Object.assign(copy(row), { [key]: value })), key).to.equal(reason);
        expect(priceRecoveryRefusal(Object.assign(copy(row), { consensus_proof: '[]' })))
            .to.equal('has empty finalized proof');
        expect(priceRecoveryRefusal(null)).to.equal('has malformed shape');
    });
});
