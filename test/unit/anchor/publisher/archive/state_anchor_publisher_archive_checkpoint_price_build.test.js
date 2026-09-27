'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const StateAnchorPublisher = require('../../../../../src/anchor/publisher');
const StateCheckpointEngine = require('../../../../../src/anchor/checkpoint_engine.js');
const OracleConsensus = require('../../../../../src/oracle/consensus.js');
const admissionHeight = require('../../../../../src/lib/admission_height.js');
const ValidatorIdentity = require('../../../../../src/validators/identity');
const { CHECKPOINT_KEYS, PRICE_KEYS, ARCHIVE_MAX_PRICE_ROUNDS } =
    require('../../../../../src/anchor/publisher/constants.js');
const { DB_METHODS } = require('../../../../helpers/mockHub.js');
const vectors = require('../../../../fixtures/anchor_archive_vectors.json');

function buildPub(sets){
    const identity = new ValidatorIdentity('11'.repeat(32));
    const pub = new StateAnchorPublisher({
        db: { ...DB_METHODS }, network: 'regtest',
        getIdentity: () => identity, getPeerManager: () => ({ broadcast() {} }), p2pConfig: {}
    });
    pub.resolveCapabilitySet = async (capability, block) => sets[capability + '@' + block] || [];
    return pub;
}

async function build(pub, inputs, rows){
    return pub.buildArchive(inputs.network, inputs.batch_seq, inputs.matches,
        inputs.wrapper_snapshot_block, inputs.calls, inputs.rewards, rows);
}

function vectorRows(inputs){
    return {
        checkpoints: inputs.checkpoints || [],
        prices: inputs.prices || [],
        tombstones: inputs.tombstones || []
    };
}

describe('archive checkpoint and price build', () => {
    it('exports the fixed row key orders and price-round cap', () => {
        expect(CHECKPOINT_KEYS).to.deep.equal([
            'id', 'chain', 'network', 'block_index', 'block_hash', 'ledger_hash',
            'actions_hash', 'contract_hash', 'checkpoint_seq', 'snapshot_block',
            'state_root', 'state_root_version', 'block_merkle_root',
            'block_merkle_version', 'validator_signatures'
        ]);
        expect(PRICE_KEYS).to.deep.equal([
            'id', 'round_number', 'coin_pair', 'price', 'reference_block',
            'reference_chain', 'block_timestamp', 'validator_count', 'consensus_round',
            'consensus_proof', 'status', 'source_chain', 'source_action_index',
            'batch_block_time', 'admit_block_btc', 'admit_block_ltc', 'admit_block_doge'
        ]);
        expect(ARCHIVE_MAX_PRICE_ROUNDS).to.equal(288);
    });

    it('vector L stays byte-identical when every added stream is empty', async () => {
        const { inputs, json, crc32 } = vectors.L;
        const pub = buildPub(inputs.capability_sets);
        const result = await build(pub, inputs, { bridges: [], policies: [],
            checkpoints: [], prices: [], tombstones: [] });
        expect(result.json).to.equal(json);
        expect(pub.crc32Hex(result.json)).to.equal(crc32);
    });

    it('vector C carries sorted rootless and rooted checkpoints exactly', async () => {
        const { inputs, json, crc32 } = vectors.C;
        const pub = buildPub(inputs.capability_sets);
        const result = await build(pub, inputs, vectorRows(inputs));
        const body = JSON.parse(result.json);
        expect(result.json).to.equal(json);
        expect(pub.crc32Hex(result.json)).to.equal(crc32);
        expect(Object.keys(body)).to.deep.equal(['v', 'network', 'batch_seq', 'matches',
            'calls', 'rewards', 'state_checkpoints', 'capability_snapshots']);
        expect(body.state_checkpoints.map(row => row.chain)).to.deep.equal(['BTC', 'LTC']);
        expect(body.state_checkpoints.map(row => Object.keys(row)))
            .to.deep.equal([CHECKPOINT_KEYS, CHECKPOINT_KEYS]);
        expect(body.state_checkpoints[0].state_root_version).to.equal(1);
        expect(body.state_checkpoints[1].state_root).to.equal(null);
    });

    it('vector P carries proof types, a skipped pair and a tombstone exactly', async () => {
        const { inputs, json, crc32 } = vectors.P;
        const pub = buildPub(inputs.capability_sets);
        const result = await build(pub, inputs, vectorRows(inputs));
        const body = JSON.parse(result.json);
        expect(result.json).to.equal(json);
        expect(pub.crc32Hex(result.json)).to.equal(crc32);
        expect(Object.keys(body)).to.deep.equal(['v', 'network', 'batch_seq', 'matches',
            'calls', 'rewards', 'price_snapshots', 'price_tombstones', 'capability_snapshots']);
        expect(body.price_snapshots.map(row => row.round_number + '|' + row.coin_pair))
            .to.deep.equal(['11|BTC/USD', '11|LTC/USD', '12|BTC/USD', '13|DOGE/USD']);
        expect(body.price_snapshots.map(row => Object.keys(row)))
            .to.deep.equal([PRICE_KEYS, PRICE_KEYS, PRICE_KEYS, PRICE_KEYS]);
        expect(body.price_snapshots[2].consensus_proof).to.contain('{"batch"');
        expect(body.price_snapshots[3]).to.include({ price: null, status: 'skipped' });
        expect(body.price_tombstones).to.deep.equal([{ round_number: 10, coin_pair: 'XCP/USD' }]);
    });
});

describe('archive checkpoint and price rows', () => {
    it('adds checkpoint and signature-proofed price capability groups only', async () => {
        const ci = vectors.C.inputs;
        const pi = vectors.P.inputs;
        const sets = { ...ci.capability_sets, ...pi.capability_sets };
        const inputs = { ...pi, capability_sets: sets };
        const rows = { checkpoints: ci.checkpoints, prices: pi.prices, tombstones: [] };
        const result = await build(buildPub(sets), inputs, rows);
        const groups = JSON.parse(result.json).capability_snapshots
            .map(row => row.capability + '@' + row.snapshot_block);
        expect(groups).to.deep.equal(['oracle_publish@70', 'oracle_publish@80', 'price@111']);
        expect(groups).to.not.include('price@120').and.not.include('price@130');
    });

    it('normalizes integers and nullable values without changing proofs', () => {
        const pub = buildPub({});
        const checkpoint = pub.serializeStateCheckpoint({
            ...vectors.C.inputs.checkpoints[0], id: '5', state_root_version: null
        });
        const price = pub.serializePriceSnapshot({
            ...vectors.P.inputs.prices[0], id: '6', source_action_index: null, price: null
        });
        expect(checkpoint).to.include({ id: 5, block_index: 700, state_root_version: null });
        expect(price).to.include({ id: 6, round_number: 12, source_action_index: null, price: null });
        expect(price.consensus_proof).to.equal(vectors.P.inputs.prices[0].consensus_proof);
        expect(pub.serializePriceTombstone({ round_number: '14', coin_pair: 7 }))
            .to.deep.equal({ round_number: 14, coin_pair: '7' });
    });

    it('delegates checkpoint and signature price canonicals to hub builders', () => {
        const pub = buildPub({});
        const checkpoint = vectors.C.inputs.checkpoints[1];
        const prices = vectors.P.inputs.prices.filter(row => row.round_number === 11);
        const expectedPrice = OracleConsensus.prototype.buildPriceV0Payload.call(
            { hub: { network: 'regtest' } }, 11, 1100,
            prices.map(row => ({ coinPair: row.coin_pair, price: row.price })), 111,
            admissionHeight.rowAdmitBlocks(prices[0]));
        expect(pub.stateCheckpointCanonical(checkpoint))
            .to.equal(StateCheckpointEngine.canonicalCheckpoint(checkpoint));
        expect(pub.priceSnapshotCanonical(prices)).to.equal(expectedPrice);
    });
});
