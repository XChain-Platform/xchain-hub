'use strict';

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../src/validators/identity');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');
const { CP_ROW } = require('../../../../helpers/anchor_mesh_db.js');
const vectors = require('../../../../fixtures/anchor_archive_vectors.json');
const { XANC_SIGN } = require('../../../../../src/anchor/publisher/constants.js');

const PRICE_BLOCK = 111;
const ELECTION_BLOCK = 200;
const BATCH_SEQ = 7;
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

function publisher(held, broadcasts){
    const pub = new StateAnchorPublisher({
        db: {
            ...DB_METHODS,
            getStateCheckpointByChainAndNetwork: async () => [CP_ROW],
            findPriceSnapshotsForRound: async () => held
        },
        network: 'regtest',
        getIdentity: () => IDENTITIES[0],
        getPeerManager: () => ({
            broadcast(type, data){ broadcasts.push({ type, data }); }
        }),
        resolveBtcLatestBlock: async () => ELECTION_BLOCK,
        p2pConfig: {}
    });
    pub.resolveCapabilitySet = async (capability, block) =>
        ((capability === 'price' && block === PRICE_BLOCK) ||
         (capability === 'oracle_publish' && block === CP_ROW.snapshot_block)) ? SET : [];
    pub.getActiveOraclePublishPubkeys = async () => SET.map(member => member.pubkey);
    pub.getNextBatchSeq = async () => BATCH_SEQ;
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
    it('co-signs the leader row only after the follower replaces its stale batch_block_time', async function () {
        const held = priceRound();
        const broadcasts = [];
        const pub = publisher(held, broadcasts);
        const archived = priceRound();
        sign(pub, archived);
        for(const row of archived) row.batch_block_time = RELANDED_TIME;
        const built = await pub.buildArchive('regtest', BATCH_SEQ, [], CP_ROW.snapshot_block,
            [], [], { prices: archived });
        const wire = pub.archiveWire(built.json);
        const checkpoint = pub.cpFromRow(CP_ROW);
        const canonical = pub.archiveCanonical(
            checkpoint, BATCH_SEQ, built.count, wire.crc, wire.chunks.length);
        const request = { data: {
            checkpoint,
            election_block: ELECTION_BLOCK,
            batch_seq: BATCH_SEQ,
            match_count: built.count,
            batch_crc32: wire.crc,
            total_chunks: wire.chunks.length,
            archive_b64: wire.b64,
            sig_pubkey: SET[1].pubkey,
            sig: IDENTITIES[1].sign(canonical)
        }};

        for(const row of held) row.batch_block_time = ORPHANED_LANDING_TIME;
        await pub.handleSignReq(request);
        expect(broadcasts).to.deep.equal([]);

        for(const row of held) row.batch_block_time = 0;
        await pub.handleSignReq(request);
        expect(broadcasts).to.deep.equal([]);

        for(const row of held) row.batch_block_time = RELANDED_TIME;
        expect(await pub.verifyArchivedPriceGroup(archived, { network: 'regtest' }))
            .to.equal(true);
        await pub.handleSignReq(request);

        expect(broadcasts).to.have.length(1);
        expect(broadcasts[0]).to.deep.include({ type: XANC_SIGN });
        expect(broadcasts[0].data).to.include({
            batch_seq: BATCH_SEQ,
            sig_pubkey: SET[0].pubkey
        });
        expect(ValidatorIdentity.verify(
            canonical, broadcasts[0].data.sig, SET[0].pubkey)).to.equal(true);
    });
});
