'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A round whose pairs differ in origin: one pair this hub finalized itself (a BTC-anchored
// producer row carrying a signature array), another stored from a landed batch. Moving the
// batch-sourced pair onto a re-landed or repaired batch must leave the self-finalized pair on
// its own anchor and proof, because the batch upsert replaces both.

const crypto            = require('crypto');
const sinon             = require('sinon');
const { expect }        = require('chai');
const PriceAggregator   = require('../../../../../../src/oracle/price_aggregator');
const { isProducerRoundRow } = require('../../../../../../src/peers/hub_db/price_round_groups');
const { createMockHub } = require('../../../../../helpers/mockHub');
const { projectPresenceRows } = require('../../../../../helpers/prices/presence_projection');

function makeValidator() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        pubkey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
        sign: (payload) => crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex')
    };
}

const V = [makeValidator(), makeValidator(), makeValidator(), makeValidator()];
const CHAIN = 'DOGE';
const ROUND = 300;
const ANCHOR = 799301;
const ACTION = 91;
const PRODUCER_BLOCK = 799300;
const PRODUCER_PROOF = '["sig-a","sig-b"]';
const PAIRS = [{ pair: 'BTC/USD', price: '50000' }, { pair: 'LTC/USD', price: '70' }];
let agg, table, upserts, resync;

function makeBatch(overrides) {
    const rounds = [{ round: ROUND, timestamp: 1700000000, btc_block_height: ANCHOR, pairs: PAIRS }];
    const payload = agg.buildPriceBatchPayload(ROUND, ROUND, ANCHOR,
        rounds.map(r => ({ round: r.round, timestamp: r.timestamp, btcBlockHeight: r.btc_block_height, pairs: r.pairs })));
    return Object.assign({
        first_round: ROUND, last_round: ROUND, btc_block_height: ANCHOR, rounds,
        sigs: V.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: v.sign(payload) })),
        block_time: 1700009000, block_index: 800500, action_index: ACTION, push_generation: 3
    }, overrides);
}

const producerRow = (pair) => ({
    id: 1, round_number: ROUND, coin_pair: pair, price: '50000', status: 'finalized',
    reference_block: PRODUCER_BLOCK, reference_chain: 'BTC', source_chain: 'DOGE',
    source_action_index: null, push_generation: 0, consensus_proof: PRODUCER_PROOF, batch_block_time: 0
});
const batchRow = (pair, generation) => ({
    id: 2, round_number: ROUND, coin_pair: pair, price: '70', status: 'finalized',
    reference_block: 800500, reference_chain: CHAIN, source_chain: CHAIN,
    source_action_index: ACTION, push_generation: generation, consensus_proof: '{"batch":{}}', batch_block_time: 1700009000
});

function installDb(db) {
    db.findPriceSnapshotRowsForRounds = async () => projectPresenceRows(table);
    db.setBatchPriceSnapshotRound = async (round, pairs, referenceBlock, referenceChain, timestamp, validatorCount,
        proofJson, actionIndex, generation, blockTime) => {
        upserts.push(pairs.map(p => p.pair));
        for (const p of pairs) {
            let row = table.find(r => r.coin_pair === p.pair);
            if (!row) { row = { id: table.length + 1, round_number: round, coin_pair: p.pair, batch_block_time: 0 }; table.push(row); }
            if (isProducerRoundRow(row)) continue;
            Object.assign(row, { price: p.price, reference_block: referenceBlock, reference_chain: referenceChain,
                status: 'finalized', source_chain: referenceChain, source_action_index: actionIndex,
                push_generation: generation, consensus_proof: proofJson, batch_block_time: blockTime });
        }
        return {};
    };
    db.findPriceSnapshotsForRound = async () => table.map(r => Object.assign({}, r));
    db.updatePriceSnapshotByRoundNumber = async () => ({});
    db.findPriceSnapshotsByRoundNumberAndBatchBlockTime = async () => [];
}

function registerHooks() {
    beforeEach(function () {
        const hub = createMockHub({ network: 'mainnet' });
        resync = sinon.stub();
        hub.hubDbBroadcaster = { subscribers: new Set([{}]), dropAllForResync: resync };
        agg = new PriceAggregator(hub);
        hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves({
            capability: 'price', blockIndex: 800500, count: V.length,
            validators: V.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' }))
        }) };
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        table = [producerRow('BTC/USD'), batchRow('LTC/USD', 3)];
        upserts = [];
        installDb(hub.db);
    });
    afterEach(function () { sinon.restore(); });
}

describe('PriceAggregator batch re-land over a round of mixed origin', function () {
    registerHooks();

    it('moves the batch-sourced pair of a re-landed round and leaves the self-finalized pair alone', async function () {
        const result = await agg.receiveValidatedBatch(CHAIN, makeBatch({ push_generation: 5 }));
        expect(result).to.deep.equal({ accepted: true, stored: 0, duplicates: 1, rejected: 0 });
        expect(upserts).to.deep.equal([['LTC/USD']]);
        const own = table.find(r => r.coin_pair === 'BTC/USD');
        expect(own.reference_block).to.equal(PRODUCER_BLOCK);
        expect(own.reference_chain).to.equal('BTC');
        expect(own.consensus_proof).to.equal(PRODUCER_PROOF);
        expect(table.find(r => r.coin_pair === 'LTC/USD').push_generation).to.equal(5);
    });

    it('leaves the self-finalized pair alone when a repair targets the round', async function () {
        const result = await agg.receiveValidatedBatch(CHAIN, makeBatch({ push_generation: 5 }),
            { targetRounds: new Set([ROUND]) });
        expect(result.accepted).to.equal(true);
        expect(upserts).to.deep.equal([['LTC/USD']]);
        expect(table.find(r => r.coin_pair === 'BTC/USD').reference_chain).to.equal('BTC');
    });

    it('skips the upsert when every pair of the round is self-finalized', async function () {
        table = [producerRow('BTC/USD'), Object.assign(producerRow('LTC/USD'), { id: 2 })];
        const result = await agg.receiveValidatedBatch(CHAIN, makeBatch({ push_generation: 5 }),
            { targetRounds: new Set([ROUND]) });
        expect(result.accepted).to.equal(true);
        expect(upserts).to.deep.equal([]);
        expect(table.every(r => r.consensus_proof === PRODUCER_PROOF)).to.equal(true);
    });

    it('still moves every pair of a round the batch alone carries', async function () {
        table = [batchRow('BTC/USD', 3), batchRow('LTC/USD', 3)];
        await agg.receiveValidatedBatch(CHAIN, makeBatch({ push_generation: 5 }));
        expect(upserts).to.deep.equal([['BTC/USD', 'LTC/USD']]);
        expect(table.every(r => r.push_generation === 5)).to.equal(true);
    });

    it('fills only a signed pair missing from an ordinary duplicate round', async function () {
        table = [producerRow('BTC/USD'), {
            id: 2, round_number: ROUND, coin_pair: 'LTC/USD', status: 'skipped', price: null
        }];
        const result = await agg.receiveValidatedBatch(CHAIN, makeBatch({ push_generation: 5 }));
        expect(result).to.deep.equal({ accepted: true, stored: 1, duplicates: 0, rejected: 0 });
        expect(upserts).to.deep.equal([['LTC/USD']]);
        expect(table.find(row => row.coin_pair === 'BTC/USD').consensus_proof).to.equal(PRODUCER_PROOF);
        expect(table.find(row => row.coin_pair === 'LTC/USD').status).to.equal('finalized');
    });
});

describe('PriceAggregator batch ingest mirrors the rows it holds', function () {
    registerHooks();

    it('broadcasts held producer data when the presence read loses a finalize race', async function () {
        table = [producerRow('BTC/USD')];
        agg.db.findPriceSnapshotRowsForRounds = async () => [];
        const emitted = [];
        agg.on('row:inserted', event => emitted.push(event.row));
        const result = await agg.receiveValidatedBatch(CHAIN, makeBatch({ push_generation: 5 }));
        expect(result.accepted).to.equal(true);
        const own = emitted.find(row => row.coin_pair === 'BTC/USD');
        expect(own.reference_block).to.equal(PRODUCER_BLOCK);
        expect(own.consensus_proof).to.equal(PRODUCER_PROOF);
    });

    it('counts a stored batch round as stored when its post-write re-read fails', async function () {
        table = [];
        agg.db.findPriceSnapshotsForRound = async () => { throw new Error('read lost'); };
        const emitted = [];
        agg.on('row:inserted', event => emitted.push(event.row));
        const result = await agg.receiveValidatedBatch(CHAIN, makeBatch({ push_generation: 5 }));
        expect(result).to.deep.equal({ accepted: true, stored: 1, duplicates: 0, rejected: 0 });
        expect(emitted).to.deep.equal([]);
        expect(resync.calledOnce).to.equal(true);
    });

    it('rejects a malformed batch generation before storing', async function () {
        table = [];
        for (const generation of ['6junk', null]) {
            const result = await agg.receiveValidatedBatch(CHAIN, makeBatch({ push_generation: generation }));
            expect(result).to.deep.equal({
                accepted: false, stored: 0, duplicates: 0, rejected: 1, reason: 'invalid push_generation'
            });
        }
        expect(upserts).to.deep.equal([]);
    });
});
