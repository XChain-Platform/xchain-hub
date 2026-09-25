'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const ValidatorIdentity = require('../../../../../src/validators/identity');
const { ARCHIVE_MAX_POLICY_ROWS, ARCHIVE_MAX_PRICE_ROUNDS, ARCHIVE_MAX_JSON_BYTES } =
    require('../../../../../src/anchor/publisher/constants.js');

const BLOCK = 100;
const CP_ROW = {
    id: 1, chain: 'BTC', network: 'regtest', block_index: 500,
    block_hash: 'c0'.repeat(32), ledger_hash: 'a1'.repeat(32),
    actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
    checkpoint_seq: BLOCK, snapshot_block: BLOCK, state_root: null,
    state_root_version: null, block_merkle_root: null, block_merkle_version: null,
    validator_signatures: '[]'
};

function emptyDb(overrides){
    return Object.assign({
        findCrossChainMatchesByBatchSeq: async () => [],
        findCrossChainCallsByBatchSeq: async () => [],
        findArchivableAnchorRewardsBelowFlagDays: async () => [],
        findArchivableAnchorRewards: async () => [],
        findBridgeTransfersByBatchSeq: async () => [],
        findPolicySnapshotsByBatchSeq: async () => [],
        findStateCheckpointsByBatchSeq: async () => [],
        findPriceSnapshotRoundsByBatchSeq: async () => [],
        findPriceSnapshotsForArchiveRounds: async () => [],
        findPriceTombstonesByBatchSeq: async () => []
    }, overrides || {});
}

function buildPub(db){
    const identity = new ValidatorIdentity('11'.repeat(32));
    const pub = new StateAnchorPublisher({
        db: db || emptyDb(), network: 'regtest', p2pConfig: {},
        getIdentity: () => identity,
        getPeerManager: () => ({ broadcast() {} })
    });
    return { pub, identity };
}

describe('archive quorum-table selection', function () {
    it('gathers every stream, caps policies, and loads complete capped price rounds', async function () {
        const policies = Array.from({ length: ARCHIVE_MAX_POLICY_ROWS + 1 }, (_, i) => ({ snapshot_id: 'p' + i }));
        const priceRounds = Array.from({ length: ARCHIVE_MAX_PRICE_ROUNDS + 1 }, (_, i) => ({ round_number: i + 1 }));
        const requested = [];
        const db = emptyDb({
            findBridgeTransfersByBatchSeq: async () => [{ transfer_id: 'b1' }],
            findPolicySnapshotsByBatchSeq: async (limit) => {
                expect(limit).to.equal(ARCHIVE_MAX_POLICY_ROWS + 1);
                return policies;
            },
            findStateCheckpointsByBatchSeq: async () => [CP_ROW],
            findPriceSnapshotRoundsByBatchSeq: async (limit) => {
                expect(limit).to.equal(ARCHIVE_MAX_PRICE_ROUNDS + 1);
                return priceRounds;
            },
            findPriceSnapshotsForArchiveRounds: async (rounds) => {
                requested.push(...rounds);
                return rounds.flatMap(round_number => [
                    { round_number, coin_pair: 'BTC/USD' },
                    { round_number, coin_pair: 'DOGE/USD' }
                ]);
            },
            findPriceTombstonesByBatchSeq: async () => [{ round_number: 0, coin_pair: 'XCP/USD' }]
        });
        const { pub } = buildPub(db);
        const rows = await pub.gatherArchiveRows();
        expect(rows.bridges).to.have.length(1);
        expect(rows.policies).to.have.length(ARCHIVE_MAX_POLICY_ROWS);
        expect(rows.checkpoints).to.have.length(1);
        expect(rows.prices).to.have.length(ARCHIVE_MAX_PRICE_ROUNDS * 2);
        expect(rows.tombstones).to.have.length(1);
        expect(requested).to.have.length(ARCHIVE_MAX_PRICE_ROUNDS);
        expect(requested[0]).to.equal(1);
        expect(requested[requested.length - 1]).to.equal(ARCHIVE_MAX_PRICE_ROUNDS);
        expect(rows.cappedOrTrimmed).to.equal(true);
    });

    it('treats any new stream as archive cargo after reward resolution', function () {
        const { pub } = buildPub();
        const rows = pub.archiveRows([], [], [{ reward_type: 'unresolved' }], {
            tombstones: [{ round_number: 9, coin_pair: 'BTC/USD' }]
        });
        expect(pub.archiveEmptyAfterResolution(rows, [])).to.equal(false);
        expect(pub.archiveRowCount(rows)).to.equal(2);
    });

    it('trims whole trailing price rounds, then policy, checkpoint, and bridge rows', async function () {
        const { pub } = buildPub();
        const rows = pub.archiveRows([], [], [], {
            prices: [
                { round_number: 1, coin_pair: 'BTC/USD' },
                { round_number: 2, coin_pair: 'BTC/USD' },
                { round_number: 2, coin_pair: 'DOGE/USD' }
            ],
            policies: [{ snapshot_id: 'p1' }, { snapshot_id: 'p2' }],
            checkpoints: [
                { chain: 'BTC', network: 'regtest', checkpoint_seq: 1 },
                { chain: 'LTC', network: 'regtest', checkpoint_seq: 2 }
            ],
            bridges: [{ transfer_id: 'b1' }, { transfer_id: 'b2' }]
        });
        const tooLarge = 'x'.repeat(ARCHIVE_MAX_JSON_BYTES + 1);
        const states = [];
        pub.buildArchive = async (network, batchSeq, matches, wrapper, calls, rewards, selected) => {
            states.push({
                prices: selected.prices.map(r => r.round_number),
                policies: selected.policies.map(r => r.snapshot_id),
                checkpoints: selected.checkpoints.map(r => r.checkpoint_seq),
                bridges: selected.bridges.map(r => r.transfer_id)
            });
            const remaining = selected.prices.length + selected.policies.length +
                selected.checkpoints.length + selected.bridges.length;
            return { json: remaining ? tooLarge : '{}', count: 0 };
        };
        await pub.buildSizedArchive('regtest', 7, rows, BLOCK, []);
        expect(states.map(s => s.prices)).to.deep.equal([[1, 2, 2], [1], [], [], [], [], [], [], []]);
        expect(states[3].policies).to.deep.equal(['p1']);
        expect(states[5].checkpoints).to.deep.equal([1]);
        expect(states[7].bridges).to.deep.equal(['b1']);
        expect(rows.cappedOrTrimmed).to.equal(true);
    });
});

describe('archive quorum-table round', function () {
    it('carries every selected row identifier and price proof digest', function () {
        const { pub, identity } = buildPub();
        const proof = '[{"pubkey":"aa","sig":"bb"}]';
        const rows = pub.archiveRows([], [], [], {
            bridges: [{ transfer_id: 'b1', status: 'finalized' }],
            policies: [{ snapshot_id: 'p1' }],
            checkpoints: [{ chain: 'BTC', network: 'regtest', checkpoint_seq: 7 }],
            prices: [{ round_number: 8, coin_pair: 'BTC/USD', status: 'disputed',
                batch_block_time: 1234, consensus_proof: proof }],
            tombstones: [{ round_number: 6, coin_pair: 'LTC/USD' }]
        });
        const me = identity.getPubkeyHex().toLowerCase();
        const round = pub.openArchiveRound({
            cp: pub.cpFromRow(CP_ROW), batchSeq: 9,
            wire: { crc: 'deadbeef', b64: 'x', chunks: ['x'] }, canonical: 'canonical',
            signer: null, electionBlock: BLOCK, archive: { count: 0 }, rows, rewardRows: [],
            signingSet: [{ pubkey: me, amount: '1', source: '' }], myPubkey: me, mySig: 'sig'
        });
        expect(round.bridgeIds).to.deep.equal([{ transfer_id: 'b1', status: 'finalized' }]);
        expect(round.policyIds).to.deep.equal([{ snapshot_id: 'p1' }]);
        expect(round.checkpointIds).to.deep.equal([{ chain: 'BTC', network: 'regtest', checkpoint_seq: 7 }]);
        expect(round.priceIds).to.deep.equal([{ round_number: 8, coin_pair: 'BTC/USD',
            status: 'disputed', batch_block_time: 1234,
            proof_sha: crypto.createHash('sha256').update(proof).digest('hex') }]);
        expect(round.tombstoneIds).to.deep.equal([{ round_number: 6, coin_pair: 'LTC/USD' }]);
    });

    it('publishes a batch containing only a capped new stream and opens the next wake', async function () {
        const { pub, identity } = buildPub();
        const rows = pub.archiveRows([], [], [], {
            policies: [{ snapshot_id: 'p1' }], cappedOrTrimmed: true
        });
        const me = identity.getPubkeyHex().toLowerCase();
        const published = [];
        pub.gatherArchiveRows = async () => rows;
        pub.getActiveOraclePublishPubkeys = async () => [me];
        pub.latestArchiveWrapperRows = async () => [CP_ROW];
        pub.getLiveArchiveIntent = async () => null;
        pub.getNextBatchSeq = async () => 7;
        pub.archiveRankLocked = () => false;
        pub.buildSizedArchive = async () => ({ json: '{}', count: 0 });
        pub.archiveSigningSet = async () => [{ pubkey: me, amount: '1', source: '' }];
        pub.publishArchive = async round => { published.push(round); };
        expect(await pub.startArchiveRound(null, BLOCK, false)).to.equal('published');
        expect(published).to.have.length(1);
        expect(published[0].policyIds).to.deep.equal([{ snapshot_id: 'p1' }]);
        expect(pub.wakeFlushOpts()).to.deep.equal({ failoverOnly: false });
    });
});
