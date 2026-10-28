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
//
// A source-chain reorg that re-mines the SAME PRICE batch, with the re-push reaching
// the hub before the retraction for the rolled-back action finishes. The re-push is a
// duplicate of every round, so before the fix the batch-sourced row kept its pre-reorg
// push_generation, the generation-fenced retraction then deleted it, and the publisher
// kept its markers (the chain still carries the round), so nothing ever restored it.
//
// The invariant: once the reorg settles, every round the canonical batch carries still
// has a finalized price_snapshots row, and its publish marker stands. A plain duplicate
// delivery (no rollback) still retracts exactly as before, and an overlapping later
// batch never takes over a round an earlier, untouched batch carries.

const crypto            = require('crypto');
const sinon             = require('sinon');
const { expect }        = require('chai');
const PriceAggregator   = require('../../../../../../src/oracle/price_aggregator');
const queueMethods      = require('../../../../../../src/oracle/publisher/queue.js');
const { createMockHub } = require('../../../../../helpers/mockHub');

function makeValidator() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let pubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    return {
        pubkey,
        sign: (payload) => crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex')
    };
}

const V = [makeValidator(), makeValidator(), makeValidator(), makeValidator()];

const CHAIN         = 'DOGE';
const BATCH_ROUND   = 200;      // stored on this hub from the batch itself
const SELF_ROUND    = 201;      // finalized here first, so the batch only stamps it
const BATCH_ANCHOR  = 799101;
const ACTION_INDEX  = 91;
const OLD_BLOCK     = 800500;
const OLD_TIME      = 1700009000;
const NEW_BLOCK     = 800500;   // re-mined at the same height
const NEW_TIME      = 1700009600;

let hub, agg, table, watermark, markerDeletes, publisher;

function makeRounds() {
    return [BATCH_ROUND, SELF_ROUND].map((round, i) => ({
        round,
        timestamp:        1700000000 + (i * 600),
        btc_block_height: 799100 + i,
        pairs: [{ pair: 'BTC/USD', price: String(50000 + i) }, { pair: 'LTC/USD', price: String(70 + i) }]
    }));
}

function makeBatch(overrides) {
    let rounds = makeRounds();
    let payload = agg.buildPriceBatchPayload(BATCH_ROUND, SELF_ROUND, BATCH_ANCHOR,
        rounds.map(r => ({ round: r.round, timestamp: r.timestamp, btcBlockHeight: r.btc_block_height, pairs: r.pairs })));
    return Object.assign({
        first_round: BATCH_ROUND, last_round: SELF_ROUND, btc_block_height: BATCH_ANCHOR,
        rounds, sigs: V.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: v.sign(payload) })),
        block_time: OLD_TIME, block_index: OLD_BLOCK, action_index: ACTION_INDEX, push_generation: 3
    }, overrides);
}

function snapshotOf(validators) {
    return {
        capability: 'price', blockIndex: OLD_BLOCK, count: validators.length,
        validators: validators.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' }))
    };
}

const live = (r) => r.status !== 'skipped';
const isBatchRow = (r) => typeof r.consensus_proof === 'string' && r.consensus_proof.startsWith('{"batch":');

// The retraction tail every price_snapshots retraction statement shares.
function inRetraction(r, chain, from, to, gen, bounded, fenced) {
    if (r.source_chain !== chain || r.source_action_index === null) return false;
    if (Number(r.source_action_index) < from) return false;
    if (bounded && Number(r.source_action_index) > to) return false;
    if (fenced && Number(r.push_generation) > gen) return false;
    return true;
}

// An in-memory price_snapshots behind the named DB methods both paths call, with the
// SQL semantics the paths rely on: the per-round upsert keyed on (round, pair) that
// keeps the EARLIER landing clock, the fenced delete, and the landing-clock resets.
function installFakeDb() {
    let db = hub.db;
    db.getPriceIngestWatermark = async () => watermark;
    db.bumpPriceIngestWatermark = async (chain, gen, from) => {
        watermark = watermark
            ? { retraction_generation: Math.max(watermark.retraction_generation, gen),
                from_action_index: Math.min(watermark.from_action_index, from) }
            : { retraction_generation: gen, from_action_index: from };
    };
    db.getPriceSnapshotByRoundNumber = async (round) =>
        table.filter(r => r.round_number === round && live(r)).slice(0, 1).map(r => ({ id: r.id }));
    db.findPriceSnapshotsForRound = async (round) =>
        table.filter(r => r.round_number === round).map(r => Object.assign({}, r));
    db.setBatchPriceSnapshotRound = async (round, pairs, referenceBlock, referenceChain, timestamp,
                                           validatorCount, proofJson, sourceActionIndex, pushGeneration, blockTime) => {
        for (let p of pairs) {
            let row = table.find(r => r.round_number === round && r.coin_pair === p.pair);
            if (!row) {
                row = { id: table.length + 1, round_number: round, coin_pair: p.pair, batch_block_time: 0 };
                table.push(row);
            }
            Object.assign(row, {
                price: p.price, reference_block: referenceBlock, reference_chain: referenceChain,
                block_timestamp: timestamp, validator_count: validatorCount, consensus_proof: proofJson,
                status: 'finalized', source_chain: referenceChain, source_action_index: sourceActionIndex,
                push_generation: pushGeneration,
                batch_block_time: (row.batch_block_time === 0 || blockTime < row.batch_block_time) ? blockTime : row.batch_block_time
            });
        }
        return { affectedRows: pairs.length };
    };
    db.updatePriceSnapshotByRoundNumber = async (landed, round) => {
        for (let r of table) {
            if (r.round_number === round && live(r) && (r.batch_block_time === 0 || r.batch_block_time > landed)) r.batch_block_time = landed;
        }
        return {};
    };
    db.findPriceSnapshotsByRoundNumberAndBatchBlockTime = async (round, landed) =>
        table.filter(r => r.round_number === round && r.batch_block_time === landed).map(r => Object.assign({}, r));
    db.findBatchPriceSnapshotRoundsForRetraction = async (...q) =>
        [...new Set(table.filter(r => isBatchRow(r) && inRetraction(r, ...q)).map(r => r.round_number))]
            .map(round_number => ({ round_number }));
    db.findSelfFinalizedRoundsForBatchRetraction = async () => [];
    db.resetSelfFinalizedBatchBlockTimeForRetraction = async () => ({ affectedRows: 0 });
    db.insertPriceTombstonesForRetraction = async () => ({});
    db.deletePriceSnapshotsForRetraction = async (...q) => {
        let before = table.length;
        table = table.filter(r => !inRetraction(r, ...q));
        return { affectedRows: before - table.length };
    };
    db.deleteOraclePricesForRetraction = async () => ({ affectedRows: 0 });
    db.findPriceSnapshotRoundsLandedBetween = async (first, last) =>
        [...new Set(table.filter(r => r.round_number >= first && r.round_number <= last && live(r) && r.batch_block_time > 0)
            .map(r => r.round_number))].map(round_number => ({ round_number }));
    db.updatePriceSnapshotsClearBatchBlockTimeBetween = async (first, last) => {
        for (let r of table) if (r.round_number >= first && r.round_number <= last && live(r)) r.batch_block_time = 0;
        return {};
    };
}

// The real retraction seam from the publisher's queue mixin over a fake publisher
// whose chain reader reports which rounds a valid batch on the active chain carries.
function installPublisher(carried) {
    markerDeletes = [];
    publisher = Object.assign({}, queueMethods, {
        _publishedRounds: new Set([BATCH_ROUND, SELF_ROUND]),
        _assembledWindows: new Set([0]),
        _landed: [],
        roundsCarriedByChain: async (rounds) => new Set(rounds.filter(r => carried.includes(r))),
        markRoundLanded(r) { this._landed.push(r); },
        windowIndexOf: () => 0,
        restoreBufferedRounds: async () => {},
        db: { deleteOraclePublishedRoundsByRounds: async (rounds) => { markerDeletes.push(rounds); return { affectedRows: rounds.length }; } }
    });
    hub.oraclePublisher = publisher;
}

function rowsOf(round) {
    return table.filter(r => r.round_number === round && r.status === 'finalized');
}

async function aReMinedBatchKeepsItsBatchSourcedRound() {
    installPublisher([BATCH_ROUND, SELF_ROUND]);

    // Landed at generation 3; the indexer's generation then sits at 4.
    let first = await agg.receiveValidatedBatch(CHAIN, makeBatch());
    expect(first).to.deep.equal({ accepted: true, stored: 1, duplicates: 1, rejected: 0 });
    expect(rowsOf(BATCH_ROUND).map(r => r.push_generation)).to.deep.equal([3, 3]);

    // The rollback bumps the generation to 5 and retracts at 4; the re-mined batch
    // re-pushes at 5 and reaches the hub before the retraction does.
    let again = await agg.receiveValidatedBatch(CHAIN,
        makeBatch({ push_generation: 5, block_time: NEW_TIME, block_index: NEW_BLOCK }));
    expect(again.accepted).to.equal(true);

    let res = await agg.retractFromActionIndex(CHAIN, ACTION_INDEX, ACTION_INDEX + 1, 4,
        [{ first_round: BATCH_ROUND, last_round: SELF_ROUND }]);
    expect(res.error).to.equal(undefined);

    // The canonical batch still carries the round, so the hub still serves it.
    let kept = rowsOf(BATCH_ROUND);
    expect(kept.length).to.equal(2);
    expect(kept.every(r => r.push_generation === 5 && r.source_action_index === ACTION_INDEX)).to.equal(true);
    expect(rowsOf(SELF_ROUND).length).to.equal(2);

    // And its publish marker stands: re-arming it would put a duplicate wire on chain.
    expect(markerDeletes).to.deep.equal([]);
    expect(publisher._publishedRounds.has(BATCH_ROUND)).to.equal(true);
}

async function aPlainDuplicateDeliveryStillRetracts() {
    installPublisher([]);

    await agg.receiveValidatedBatch(CHAIN, makeBatch());
    // The same push delivered twice, no rollback in between: a true duplicate.
    let again = await agg.receiveValidatedBatch(CHAIN, makeBatch());
    expect(again).to.deep.equal({ accepted: true, stored: 0, duplicates: 2, rejected: 0 });
    expect(rowsOf(BATCH_ROUND).map(r => r.push_generation)).to.deep.equal([3, 3]);

    let res = await agg.retractFromActionIndex(CHAIN, ACTION_INDEX, ACTION_INDEX + 1, 3,
        [{ first_round: BATCH_ROUND, last_round: SELF_ROUND }]);
    expect(res.retracted.price_snapshots).to.equal(2);

    // The batch is gone from the chain: the row goes and the recovery re-publish is armed.
    expect(rowsOf(BATCH_ROUND).length).to.equal(0);
    expect(markerDeletes).to.deep.equal([[BATCH_ROUND]]);
    expect(publisher._publishedRounds.has(BATCH_ROUND)).to.equal(false);
}

async function aLaterOverlappingBatchNeverTakesOverTheRound() {
    installPublisher([]);

    await agg.receiveValidatedBatch(CHAIN, makeBatch());
    // A later window's batch re-carries the round after an unrelated generation bump:
    // its action index is HIGHER, so the earlier batch is still canonical.
    await agg.receiveValidatedBatch(CHAIN, makeBatch({ push_generation: 6, action_index: ACTION_INDEX + 4 }));

    let kept = rowsOf(BATCH_ROUND);
    expect(kept.every(r => r.push_generation === 3 && r.source_action_index === ACTION_INDEX)).to.equal(true);
}

describe('PriceAggregator batch re-landed after a reorg survives the late retraction', function () {
    beforeEach(function () {
        hub = createMockHub({ network: 'mainnet' });
        agg = new PriceAggregator(hub);
        hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves(snapshotOf(V)) };
        sinon.stub(console, 'log');
        sinon.stub(console, 'warn');
        table = makeRounds()[1].pairs.map((p, i) => ({
            id: i + 1, round_number: SELF_ROUND, coin_pair: p.pair, price: p.price, status: 'finalized',
            source_chain: null, source_action_index: null, push_generation: 0,
            consensus_proof: '[]', batch_block_time: 0
        }));
        watermark = null;
        installFakeDb();
    });
    afterEach(function () {
        sinon.restore();
    });

    it('keeps the batch-sourced round of a re-mined batch and its publish marker', aReMinedBatchKeepsItsBatchSourcedRound);
    it('still deletes the round and clears the marker on a plain duplicate delivery', aPlainDuplicateDeliveryStillRetracts);
    it('never moves a round onto a later overlapping batch', aLaterOverlappingBatchNeverTakesOverTheRound);
});
