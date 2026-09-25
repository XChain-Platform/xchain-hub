'use strict';

const crypto = require('crypto');
const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../src/validators/identity');
const { XANC_FINALIZED } = require('../../../../../src/anchor/publisher/constants.js');

const TXID = 'ab'.repeat(32);
const PROOF = '[{"pubkey":"aa","sig":"bb"}]';

function ids(){
    return {
        matchIds: [], callIds: [], rewardIds: [],
        bridgeIds: [{ transfer_id: 'bridge-1', status: 'finalized' }],
        policyIds: [{ snapshot_id: 'policy-1' }],
        checkpointIds: [{ chain: 'BTC', network: 'regtest', checkpoint_seq: 4 }],
        priceIds: [{
            round_number: 8, coin_pair: 'BTC/USD', status: 'finalized',
            batch_block_time: 1234,
            proof_sha: crypto.createHash('sha256').update(PROOF).digest('hex')
        }],
        tombstoneIds: [{ round_number: 3, coin_pair: 'DOGE/USD' }]
    };
}

function publisher(db, broadcast){
    const identity = new ValidatorIdentity('11'.repeat(32));
    const pub = new StateAnchorPublisher({
        db: db || {}, network: 'regtest', p2pConfig: {},
        getIdentity: () => identity,
        getPeerManager: () => ({ broadcast: broadcast || (() => {}) })
    });
    return { pub, identity };
}

describe('archive quorum-table FINALIZED announcements', function () {
    it('announces all five optional row lists', function () {
        const sent = [];
        const { pub } = publisher({}, (type, data) => sent.push({ type, data }));
        const all = ids();
        const round = { batchSeq: 7, cp: { snapshot_block: 44 } };

        pub.announceArchiveFinalized(round, TXID, all);

        expect(sent).to.have.length(1);
        expect(sent[0].type).to.equal(XANC_FINALIZED);
        expect(sent[0].data).to.include({ batch_seq: 7, txid: TXID });
        expect(sent[0].data.bridges).to.equal(all.bridgeIds);
        expect(sent[0].data.policies).to.equal(all.policyIds);
        expect(sent[0].data.checkpoints).to.equal(all.checkpointIds);
        expect(sent[0].data.prices).to.equal(all.priceIds);
        expect(sent[0].data.tombstones).to.equal(all.tombstoneIds);
    });

    it('keeps immutable rows pending and stages mutable rows as partial', function () {
        const { pub } = publisher();
        const all = ids();
        const round = {
            matchIds: [], callIds: [], rewardIds: [], bridgeIds: all.bridgeIds,
            policyIds: all.policyIds, checkpointIds: all.checkpointIds,
            priceIds: all.priceIds, tombstoneIds: all.tombstoneIds,
            batchSeq: 7, cp: { snapshot_block: 44 }
        };

        const partial = pub.archiveBackfillIds(round, 1, true, false);

        expect(partial.bridgeIds[0].status).to.equal('__partial__');
        expect(partial.priceIds[0].status).to.equal('__partial__');
        expect(partial.policyIds).to.deep.equal([]);
        expect(partial.checkpointIds).to.deep.equal([]);
        expect(partial.tombstoneIds).to.deep.equal([]);
    });

});

describe('archive quorum-table FINALIZED back-fill', function () {
    it('delegates every new stamp to its guarded DB method', async function () {
        const calls = [];
        const db = {
            updateBridgeTransferArchiveBatchSeq: async (...a) => calls.push(['bridge', ...a]),
            updatePolicySnapshotArchiveBatchSeq: async (...a) => calls.push(['policy', ...a]),
            updateStateCheckpointArchiveBatchSeq: async (...a) => calls.push(['checkpoint', ...a]),
            updatePriceSnapshotArchiveBatchSeq: async (...a) => calls.push(['price', ...a]),
            updatePriceTombstoneArchiveBatchSeq: async (...a) => calls.push(['tombstone', ...a])
        };
        const { pub } = publisher(db);
        const all = ids();

        await pub.backfillBatch(7, [], TXID, [], [], all.bridgeIds, all.policyIds,
                                all.checkpointIds, all.priceIds, all.tombstoneIds);

        expect(calls).to.deep.equal([
            ['bridge', 7, 'finalized', TXID, 'bridge-1'],
            ['policy', 7, TXID, 'policy-1'],
            ['checkpoint', 7, 'BTC', 'regtest', 4],
            ['price', 7, 'finalized', 1234, all.priceIds[0].proof_sha, 8, 'BTC/USD'],
            ['tombstone', 7, 3, 'DOGE/USD']
        ]);
    });

});

describe('archive quorum-table FINALIZED observation binding', function () {
    it('binds all five announcements to the observed archive body', function () {
        const { pub, identity } = publisher();
        const sender = identity.getPubkeyHex().toLowerCase();
        const all = ids();
        pub.recordObservedArchiveContent(7, sender, {
            bridge_transfers: [{ transfer_id: 'bridge-1' }],
            policy_snapshots: [{ snapshot_id: 'policy-1' }],
            state_checkpoints: [{ chain: 'BTC', network: 'regtest', checkpoint_seq: 4 }],
            price_snapshots: [{ round_number: 8, coin_pair: 'BTC/USD' }],
            price_tombstones: [{ round_number: 3, coin_pair: 'DOGE/USD' }]
        });

        expect(pub.finalizedOutsideObservedArchive(
            7, sender, [], [], [], all.bridgeIds, all.policyIds,
            all.checkpointIds, all.priceIds, all.tombstoneIds)).to.equal(null);
        expect(pub.finalizedOutsideObservedArchive(
            7, sender, [], [], [], [{ transfer_id: 'stray' }], [], [], [], []))
            .to.match(/^bridge /);
        expect(pub.finalizedOutsideObservedArchive(
            7, sender, [], [], [], [], [{ snapshot_id: 'stray' }], [], [], []))
            .to.match(/^policy /);
        expect(pub.finalizedOutsideObservedArchive(
            7, sender, [], [], [], [], [],
            [{ chain: 'LTC', network: 'regtest', checkpoint_seq: 4 }], [], []))
            .to.match(/^checkpoint /);
        expect(pub.finalizedOutsideObservedArchive(
            7, sender, [], [], [], [], [], [],
            [{ round_number: 9, coin_pair: 'BTC/USD' }], []))
            .to.match(/^price /);
        expect(pub.finalizedOutsideObservedArchive(
            7, sender, [], [], [], [], [], [], [],
            [{ round_number: 4, coin_pair: 'DOGE/USD' }]))
            .to.match(/^tombstone /);
    });

});

describe('archive quorum-table deferred FINALIZED staging', function () {
    it('extends deferred staging to mutable rows only', async function () {
        const { pub } = publisher();
        const all = ids();
        const staged = [];
        const deferred = [];
        pub.verifyArchiveCheckpointOnChain = async () => 'shallow';
        pub.backfillBatch = async (...a) => staged.push(a);
        pub.deferFinalized = (...a) => deferred.push(a);

        await pub.stageFinalizedBackfill(
            { batch_seq: 7, txid: TXID, matches: [] }, 'sender', [], [], {
                bridges: all.bridgeIds, policies: all.policyIds,
                checkpoints: all.checkpointIds, prices: all.priceIds,
                tombstones: all.tombstoneIds
            });

        expect(staged).to.have.length(1);
        expect(staged[0][5][0].status).to.equal('__partial__');
        expect(staged[0][6]).to.deep.equal([]);
        expect(staged[0][7]).to.deep.equal([]);
        expect(staged[0][8][0].status).to.equal('__partial__');
        expect(staged[0][9]).to.deep.equal([]);
        expect(deferred).to.have.length(1);
    });

});

describe('archive quorum-table received FINALIZED handling', function () {
    it('treats missing optional fields as empty and stamps none of them', async function () {
        const leader = new ValidatorIdentity('22'.repeat(32));
        const sender = leader.getPubkeyHex().toLowerCase();
        const { pub } = publisher();
        const stamped = [];
        pub.getActiveOraclePublishPubkeys = async () => [sender];
        pub.isObservedArchiveLeader = () => true;
        pub.verifyArchiveCheckpointOnChain = async () => 'verified';
        pub.backfillBatch = async (...a) => stamped.push(a);
        const d = {
            batch_seq: 7, txid: TXID, matches: [], calls: [], rewards: [],
            sig_pubkey: sender
        };
        d.sig = leader.sign(pub.finalizedCanonical(7, TXID, 0));

        await pub.handleFinalized({ data: d });

        expect(stamped).to.have.length(1);
        expect(stamped[0].slice(5)).to.deep.equal([[], [], [], [], []]);
    });

    it('rejects null-txid terminal or immutable quorum-table announcements', function () {
        const { pub } = publisher();
        const empty = { bridges: [], policies: [], checkpoints: [], prices: [], tombstones: [] };
        expect(pub.finalizedNullTxidForged(
            { batch_seq: 7, txid: null, matches: [] }, [], [],
            Object.assign({}, empty, { bridges: [{ transfer_id: 'b', status: 'finalized' }] })))
            .to.equal(true);
        expect(pub.finalizedNullTxidForged(
            { batch_seq: 7, txid: null, matches: [] }, [], [],
            Object.assign({}, empty, { policies: [{ snapshot_id: 'p' }] })))
            .to.equal(true);
        expect(pub.finalizedNullTxidForged(
            { batch_seq: 7, txid: null, matches: [] }, [], [],
            Object.assign({}, empty, { prices: [{ status: '__partial__' }] })))
            .to.equal(false);
    });
});
