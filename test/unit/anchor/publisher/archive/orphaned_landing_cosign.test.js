'use strict';

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../src/validators/identity');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');
const vectors = require('../../../../fixtures/anchor_archive_vectors.json');

const PRICE_BLOCK = 111;
const ORPHANED_LANDING_TIME = 1700000000;
const RELANDED_TIME = 1700000600;
const IDENTITIES = ['11', '22', '33'].map(seed => new ValidatorIdentity(seed.repeat(32)));
const SET = IDENTITIES.map((identity, index) => ({
    pubkey: identity.getPubkeyHex().toLowerCase(), amount: '1', source: 'stake-' + index
}));

function copy(value){
    return JSON.parse(JSON.stringify(value));
}

function priceRound(){
    return copy(vectors.P.inputs.prices.filter(row => row.round_number === 11));
}

function publisher(held){
    const pub = new StateAnchorPublisher({
        db: {
            ...DB_METHODS,
            findPriceSnapshotsForRound: async () => held
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

function sign(pub, rows){
    const canonical = pub.priceSnapshotCanonical(rows);
    const proof = JSON.stringify(IDENTITIES.map(identity => ({
        pubkey: identity.getPubkeyHex().toLowerCase(), sig: identity.sign(canonical)
    })));
    for(const row of rows) row.consensus_proof = proof;
}

describe('archive co-sign after an orphaned PRICE landing re-lands', function () {
    it('accepts the leader row only after the follower replaces its stale batch_block_time', async function () {
        const held = priceRound();
        const pub = publisher(held);
        const archived = priceRound();
        sign(pub, archived);
        for(const row of archived) row.batch_block_time = RELANDED_TIME;

        for(const row of held) row.batch_block_time = ORPHANED_LANDING_TIME;
        expect(await pub.verifyArchivedPriceGroup(archived, { network: 'regtest' }))
            .to.equal(false);

        for(const row of held) row.batch_block_time = 0;
        expect(await pub.verifyArchivedPriceGroup(archived, { network: 'regtest' }))
            .to.equal(false);

        for(const row of held) row.batch_block_time = RELANDED_TIME;
        expect(await pub.verifyArchivedPriceGroup(archived, { network: 'regtest' }))
            .to.equal(true);
    });
});
