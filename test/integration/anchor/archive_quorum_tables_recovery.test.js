'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { expect } = require('chai');

const StateAnchorPublisher = require('../../../src/anchor/publisher');
const StateCheckpointEngine = require('../../../src/anchor/checkpoint_engine.js');
const ValidatorIdentity = require('../../../src/validators/identity');
const rewardGate = require('../../../src/consensus/gates/anchor_reward_gate.js');
const { BRIDGE_KEYS, POLICY_KEYS, CHECKPOINT_KEYS, PRICE_KEYS } =
    require('../../../src/anchor/publisher/constants.js');
const vectors = require('../../fixtures/anchor_archive_vectors.json');

const INDEXER_ROOT = [
    path.resolve(__dirname, '../../../../xchain-indexer'),
    path.resolve(__dirname, '../../../../../../../xchain-indexer')
].find(candidate => fs.existsSync(path.join(candidate, 'bin/recovery.js')));

if(!INDEXER_ROOT)
    throw new Error('required xchain-indexer sibling checkout is missing');

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const AnchorRecovery = require(path.join(INDEXER_ROOT, 'bin/recovery.js'));
const indexerFixture = require(path.join(INDEXER_ROOT, 'test/fixtures/anchor-archive.js'));
const recoveryStubs = require(path.join(INDEXER_ROOT, 'test/helpers/recovery_stubs.js'));
const indexerBridge = require(path.join(INDEXER_ROOT, 'src/consensus/bridge_settle.js'));
const indexerEd25519 = require(path.join(INDEXER_ROOT, 'src/consensus/ed25519.js'));

const WRAPPER_BLOCK = indexerFixture.SNAPSHOT_BLOCK;
const TXID = 'ab'.repeat(32);

function copy(value){
    return JSON.parse(JSON.stringify(value));
}

function sourceFor(key){
    return 'src_' + key.pubkey.slice(0, 16);
}

function capabilitySet(keys){
    return keys.map(key => ({ pubkey: key.pubkey, amount: '5', source: sourceFor(key) }));
}

function signatures(keys, canonical){
    return JSON.stringify(keys.slice(0, 3).map(key => ({
        pubkey: key.pubkey,
        sig: indexerFixture.signHex(key, canonical)
    })));
}

function signRows(rows, keys, canonical){
    return rows.map(input => {
        const row = copy(input);
        row.validator_signatures = signatures(keys, canonical(row));
        return row;
    });
}

function policyHash(row){
    const allow = indexerBridge.parseMembership(row.allow_list);
    const block = indexerBridge.parseMembership(row.block_list);
    return indexerBridge.policyHash(allow, block, !!row.sleeping);
}

function priceAdmitBlocks(row){
    if(row.admit_block_btc == null && row.admit_block_ltc == null &&
       row.admit_block_doge == null) return null;
    return {
        BTC: row.admit_block_btc,
        LTC: row.admit_block_ltc,
        DOGE: row.admit_block_doge
    };
}

function signPriceRound(rows, keys){
    const first = rows[0];
    const canonical = indexerEd25519.buildPriceV0Payload(
        first.round_number, first.block_timestamp,
        rows.map(row => ({ coinPair: row.coin_pair, price: row.price })),
        first.network || 'regtest', first.reference_block, priceAdmitBlocks(first));
    const proof = signatures(keys, canonical);
    return rows.map(input => Object.assign({}, input, { consensus_proof: proof }));
}

function signPriceBatch(row, keys){
    const batchBlock = 111;
    const canonical = indexerEd25519.buildPriceBatchPayload(
        row.round_number, row.round_number, batchBlock, [{
            round: row.round_number,
            timestamp: row.block_timestamp,
            btcBlockHeight: row.admit_block_btc == null ? row.reference_block : row.admit_block_btc,
            pairs: [{ coinPair: row.coin_pair, price: row.price }],
            admitBlocks: priceAdmitBlocks(row)
        }], 'regtest');
    const proof = {
        batch: {
            first_round: row.round_number,
            last_round: row.round_number,
            btc_block_height: batchBlock
        },
        sigs: JSON.parse(signatures(keys, canonical))
    };
    return Object.assign({}, row, { consensus_proof: JSON.stringify(proof) });
}

function buildPublisher(db, sets, rewardSource){
    const identity = new ValidatorIdentity('11'.repeat(32));
    const hub = {
        db,
        network: 'regtest',
        p2pConfig: {},
        getIdentity: () => identity,
        getPeerManager: () => ({ broadcast() {} }),
        rewardTracker: {
            anchorReward: rewardGate.ARCHIVE_REWARD_AMOUNT,
            resolveSourceByPubkey: async () => rewardSource || null
        }
    };
    const publisher = new StateAnchorPublisher(hub);
    publisher.resolveCapabilitySet = async (capability, block) =>
        sets[capability + '@' + Number(block)] || [];
    return publisher;
}

function rowDb(held, stamps){
    held = held || {};
    stamps = stamps || [];
    return {
        getCrossChainMatchByMatchId: async id =>
            (held.matches || []).filter(row => row.match_id === id),
        getCrossChainCallByCallIdAndPhase: async (id, phase) =>
            (held.calls || []).filter(row => row.call_id === id && row.phase === phase),
        getBridgeTransferByTransferId: async id =>
            (held.bridges || []).filter(row => row.transfer_id === id),
        getPolicySnapshotBySnapshotId: async id =>
            (held.policies || []).filter(row => row.snapshot_id === id),
        getStateCheckpointByChainAndNetworkAndCheckpointSeq: async (chain, network, seq) =>
            (held.checkpoints || []).filter(row => row.chain === chain &&
                row.network === network && Number(row.checkpoint_seq) === Number(seq)),
        findPriceSnapshotsForRound: async round =>
            (held.prices || []).filter(row => Number(row.round_number) === Number(round)),
        findValidatorRewardsByRewardType: async () => [],
        updateCrossChainMatchByMatchIdAndBatchSeq: async (...args) => stamps.push(['match', ...args]),
        updateCrossChainCall: async (...args) => stamps.push(['call', ...args]),
        updateValidatorRewardArchiveBatchSeqByQualifier: async (...args) =>
            stamps.push(['reward-qualified', ...args]),
        updateValidatorRewardArchiveBatchSeq: async (...args) => stamps.push(['reward', ...args]),
        updateBridgeTransferArchiveBatchSeq: async (...args) => stamps.push(['bridge', ...args]),
        updatePolicySnapshotArchiveBatchSeq: async (...args) => stamps.push(['policy', ...args]),
        updateStateCheckpointArchiveBatchSeq: async (...args) => stamps.push(['checkpoint', ...args]),
        updatePriceSnapshotArchiveBatchSeq: async (...args) => stamps.push(['price', ...args]),
        updatePriceTombstoneArchiveBatchSeq: async (...args) => stamps.push(['tombstone', ...args])
    };
}

function archiveRows(inputs){
    return {
        bridges: inputs.bridges || [],
        policies: inputs.policies || [],
        checkpoints: inputs.checkpoints || [],
        prices: inputs.prices || [],
        tombstones: inputs.tombstones || []
    };
}

async function buildArchive(publisher, inputs){
    return publisher.buildArchive(
        inputs.network, inputs.batch_seq, inputs.matches || [], WRAPPER_BLOCK,
        inputs.calls || [], inputs.rewards || [], archiveRows(inputs));
}

function headAndChunks(publisher, json, batchSeq, matchCount, oracleKeys){
    const b64 = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url');
    const chunks = [];
    const chunkSize = Math.max(1, Math.ceil(b64.length / 3));
    for(let offset = 0; offset < b64.length; offset += chunkSize)
        chunks.push(b64.slice(offset, offset + chunkSize));
    const crc = publisher.crc32Hex(json);
    const cp = Object.assign({}, indexerFixture.CP, { snapshot_block: WRAPPER_BLOCK });
    const canonical = publisher.archiveCanonical(cp, batchSeq, matchCount, crc, chunks.length);
    const v1 = Object.assign({}, cp, {
        version: 1,
        action_index: batchSeq * 10 + 1,
        snapshot_block: WRAPPER_BLOCK,
        match_batch_seq: batchSeq,
        match_count: matchCount,
        batch_crc32: crc,
        total_chunks: chunks.length,
        archive_b64: chunks[0],
        validator_signatures: signatures(oracleKeys, canonical)
    });
    const v2s = chunks.slice(1).map((archiveB64, index) => ({
        version: 2,
        action_index: batchSeq * 10 + index + 2,
        match_batch_seq: batchSeq,
        chunk_index: index + 1,
        total_chunks: chunks.length,
        archive_b64: archiveB64
    }));
    return { v1, v2s };
}

function fixtureArchive(batch){
    const joined = [batch.v1.archive_b64]
        .concat(batch.v2s.sort((a, b) => a.chunk_index - b.chunk_index).map(row => row.archive_b64))
        .join('');
    return JSON.parse(zlib.gunzipSync(Buffer.from(joined, 'base64url')).toString('utf8'));
}

function project(row, columns){
    const out = {};
    for(const column of columns) out[column] = row[column];
    return out;
}

function expectRows(dbRows, hubRows, columns){
    expect(dbRows.map(row => project(row, columns)))
        .to.deep.equal(hubRows.map(row => project(row, columns)));
}

function setFor(archive, capability, block){
    return archive.capability_snapshots
        .filter(row => row.capability === capability && Number(row.snapshot_block) === Number(block))
        .map(row => ({
            pubkey: row.signing_pubkey,
            source: row.source,
            weight: row.amount
        }));
}

function expectIndexerQuorum(recovery, canonical, rawSignatures, set){
    expect(recovery.quorumVerified(canonical, recovery.parseSigs(rawSignatures), set, true))
        .to.equal(true);
}

async function finalize(publisher, inputs){
    const priceIds = (inputs.prices || []).map(row => ({
        round_number: row.round_number,
        coin_pair: row.coin_pair,
        status: row.status,
        batch_block_time: row.batch_block_time,
        proof_sha: crypto.createHash('sha256').update(row.consensus_proof).digest('hex')
    }));
    const quorumRows = {
        bridges: (inputs.bridges || []).map(row => ({
            transfer_id: row.transfer_id,
            status: row.status
        })),
        policies: (inputs.policies || []).map(row => ({ snapshot_id: row.snapshot_id })),
        checkpoints: (inputs.checkpoints || []).map(row => ({
            chain: row.chain,
            network: row.network,
            checkpoint_seq: row.checkpoint_seq
        })),
        prices: priceIds,
        tombstones: copy(inputs.tombstones || [])
    };
    publisher.verifyArchiveCheckpointOnChain = async () => 'verified';
    await publisher.stageFinalizedBackfill({
        batch_seq: inputs.batch_seq,
        txid: TXID,
        matches: (inputs.matches || []).map(row => ({
            match_id: row.match_id,
            status: row.status
        }))
    }, 'sender', (inputs.calls || []).map(row => ({
        call_id: row.call_id,
        phase: row.phase,
        status: row.status
    })), (inputs.rewards || []).map(entry => entry.row), quorumRows);
}

async function recover(publisher, result, inputs, oracleKeys){
    const wire = headAndChunks(
        publisher, result.json, inputs.batch_seq, (inputs.matches || []).length, oracleKeys);
    const db = recoveryStubs.memDb([wire.v1], wire.v2s);
    const btcDb = (inputs.rewards || []).length
        ? recoveryStubs.rewardBtcDbStub()
        : null;
    const recovery = new AnchorRecovery(db, {
        log: () => {},
        util: recoveryStubs.util,
        btcDb
    });
    const report = await recovery.run();
    expect(report.failed).to.deep.equal([]);
    expect(report.verified).to.equal(1);
    return { db, recovery, report, archive: JSON.parse(result.json) };
}

function signedBridgePolicyInputs(crossKeys, oracleKeys){
    const inputs = copy(vectors.B.inputs);
    inputs.matches = signRows(inputs.matches, crossKeys, indexerFixture.matchCanonical);
    inputs.calls = signRows(inputs.calls, crossKeys, indexerFixture.callCanonical);
    inputs.bridges = signRows(inputs.bridges, crossKeys, indexerBridge.transferCanonical);
    inputs.policies = inputs.policies.map(row => Object.assign({}, row, {
        policy_hash: policyHash(row)
    }));
    inputs.policies = signRows(inputs.policies, crossKeys, indexerBridge.policyCanonical);
    const reward = inputs.rewards[0];
    reward.row.validator_pubkey = oracleKeys[0].pubkey;
    reward.row.amount = rewardGate.ARCHIVE_REWARD_AMOUNT;
    reward.source = sourceFor(oracleKeys[0]);
    return inputs;
}

function signedCheckpointInputs(oracleKeys){
    const inputs = copy(vectors.C.inputs);
    inputs.checkpoints = signRows(inputs.checkpoints, oracleKeys,
        row => StateCheckpointEngine.canonicalCheckpoint(row));
    return inputs;
}

function signedPriceInputs(oracleKeys){
    const inputs = copy(vectors.P.inputs);
    const signatureRound = inputs.prices.filter(row => row.round_number === 11);
    const batchRow = inputs.prices.find(row => row.round_number === 12);
    const skipped = inputs.prices.filter(row => row.round_number === 13);
    inputs.prices = signPriceRound(signatureRound, oracleKeys)
        .concat([signPriceBatch(batchRow, oracleKeys)], skipped);
    return inputs;
}

function setsFor(oracleKeys, crossKeys){
    const sets = {};
    for(const block of [70, 80, 90, WRAPPER_BLOCK])
        sets['oracle_publish@' + block] = capabilitySet(oracleKeys);
    sets['cross_chain@100'] = capabilitySet(crossKeys);
    sets['price@111'] = capabilitySet(oracleKeys);
    return sets;
}

describe('archive quorum table recovery round trip', function(){
    let oracleKeys;
    let crossKeys;
    let sets;

    beforeEach(function(){
        oracleKeys = Array.from({ length: 4 }, () => indexerFixture.makeKeypair());
        crossKeys = Array.from({ length: 4 }, () => indexerFixture.makeKeypair());
        sets = setsFor(oracleKeys, crossKeys);
    });

    it('round trips the bridge and policy vector through follower verification, FINALIZED, and recovery', async function(){
        const inputs = signedBridgePolicyInputs(crossKeys, oracleKeys);
        const stamps = [];
        const publisher = buildPublisher(rowDb(inputs, stamps), sets, inputs.rewards[0].source);
        const result = await buildArchive(publisher, inputs);
        const archive = JSON.parse(result.json);

        expect(await publisher.verifyArchiveAgainstLocal(archive, WRAPPER_BLOCK)).to.equal(true);
        await finalize(publisher, inputs);
        expect(stamps.map(stamp => stamp[0])).to.deep.equal([
            'match', 'call', 'reward', 'bridge', 'bridge', 'policy'
        ]);

        const recovered = await recover(publisher, result, inputs, oracleKeys);
        expectRows(recovered.db.bridges, archive.bridge_transfers, BRIDGE_KEYS);
        expectRows(recovered.db.policies, archive.policy_snapshots, POLICY_KEYS);
        for(const row of recovered.db.bridges){
            const canonical = indexerBridge.transferCanonical(row);
            expect(canonical).to.equal(publisher.bridgeTransferCanonical(row));
            expectIndexerQuorum(recovered.recovery, canonical, row.validator_signatures,
                setFor(archive, 'cross_chain', row.snapshot_block));
        }
        for(const row of recovered.db.policies){
            const canonical = indexerBridge.policyCanonical(row);
            expect(canonical).to.equal(publisher.policySnapshotCanonical(row));
            expectIndexerQuorum(recovered.recovery, canonical, row.validator_signatures,
                setFor(archive, 'cross_chain', row.snapshot_block));
        }
    });

    it('round trips both checkpoint forms and preserves their hub canonicals', async function(){
        const inputs = signedCheckpointInputs(oracleKeys);
        const stamps = [];
        const publisher = buildPublisher(rowDb(inputs, stamps), sets);
        const result = await buildArchive(publisher, inputs);
        const archive = JSON.parse(result.json);

        expect(await publisher.verifyArchiveAgainstLocal(archive, WRAPPER_BLOCK)).to.equal(true);
        await finalize(publisher, inputs);
        expect(stamps.map(stamp => stamp[0])).to.deep.equal(['checkpoint', 'checkpoint']);

        const recovered = await recover(publisher, result, inputs, oracleKeys);
        expectRows(recovered.db.checkpoints, archive.state_checkpoints, CHECKPOINT_KEYS);
        expect(recovered.db.checkpoints).to.have.length(2);
        for(const row of recovered.db.checkpoints){
            const canonical = recovered.recovery.checkpointCanonical(row);
            expect(canonical).to.equal(StateCheckpointEngine.canonicalCheckpoint(row));
            expectIndexerQuorum(recovered.recovery, canonical, row.validator_signatures,
                setFor(archive, 'oracle_publish', row.snapshot_block));
        }
    });

    it('round trips signature, batch, skipped, and tombstoned price rows', async function(){
        const inputs = signedPriceInputs(oracleKeys);
        const stamps = [];
        const publisher = buildPublisher(rowDb(inputs, stamps), sets);
        const result = await buildArchive(publisher, inputs);
        const archive = JSON.parse(result.json);

        expect(await publisher.verifyArchiveAgainstLocal(archive, WRAPPER_BLOCK)).to.equal(true);
        await finalize(publisher, inputs);
        expect(stamps.map(stamp => stamp[0])).to.deep.equal([
            'price', 'price', 'price', 'price', 'tombstone'
        ]);

        const recovered = await recover(publisher, result, inputs, oracleKeys);
        expectRows(recovered.db.prices, archive.price_snapshots, PRICE_KEYS);
        expect(recovered.report.tombstones).to.equal(1);
        const signedRound = recovered.db.prices.filter(row => row.round_number === 11);
        const first = signedRound[0];
        const canonical = indexerEd25519.buildPriceV0Payload(
            first.round_number, first.block_timestamp,
            signedRound.map(row => ({ coinPair: row.coin_pair, price: row.price })),
            'regtest', first.reference_block, priceAdmitBlocks(first));
        expect(canonical).to.equal(publisher.priceSnapshotCanonical(signedRound));
        expectIndexerQuorum(recovered.recovery, canonical, first.consensus_proof,
            setFor(archive, 'price', first.reference_block));
    });

    it('keeps the indexer fixture byte-exact for every quorum-table vector row', function(){
        const emptyKeys = [];
        const expectedB = JSON.parse(vectors.B.json);
        const expectedC = JSON.parse(vectors.C.json);
        const expectedP = JSON.parse(vectors.P.json);
        const orderer = buildPublisher(rowDb(), {});

        const fixtureB = fixtureArchive(indexerFixture.buildBatch(
            vectors.B.inputs.batch_seq, [], emptyKeys, emptyKeys, {
                bridges: orderer.sortedArchiveRows(vectors.B.inputs.bridges, 'transfer_id'),
                policies: orderer.sortedArchiveRows(vectors.B.inputs.policies, 'snapshot_id')
            }));
        const fixtureC = fixtureArchive(indexerFixture.buildBatch(
            vectors.C.inputs.batch_seq, [], emptyKeys, emptyKeys, {
                checkpoints: orderer.sortedStateCheckpoints(vectors.C.inputs.checkpoints)
            }));
        const fixtureP = fixtureArchive(indexerFixture.buildBatch(
            vectors.P.inputs.batch_seq, [], emptyKeys, emptyKeys, {
                prices: orderer.sortedPriceSnapshots(vectors.P.inputs.prices),
                tombstones: orderer.sortedPriceTombstones(vectors.P.inputs.tombstones)
            }));

        expect(Buffer.from(JSON.stringify(fixtureB.bridge_transfers)))
            .to.deep.equal(Buffer.from(JSON.stringify(expectedB.bridge_transfers)));
        expect(Buffer.from(JSON.stringify(fixtureB.policy_snapshots)))
            .to.deep.equal(Buffer.from(JSON.stringify(expectedB.policy_snapshots)));
        expect(Buffer.from(JSON.stringify(fixtureC.state_checkpoints)))
            .to.deep.equal(Buffer.from(JSON.stringify(expectedC.state_checkpoints)));
        expect(Buffer.from(JSON.stringify(fixtureP.price_snapshots)))
            .to.deep.equal(Buffer.from(JSON.stringify(expectedP.price_snapshots)));
        expect(Buffer.from(JSON.stringify(fixtureP.price_tombstones)))
            .to.deep.equal(Buffer.from(JSON.stringify(expectedP.price_tombstones)));
    });
});
