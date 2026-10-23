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
//
// Two hubs (a leader and a follower), each over its own in-memory price_snapshots table
// answering the real ingest, stamp, retraction and archive-verify statements, for the
// follower landing-clock suites under test/unit/oracle/price/aggregator/batch/.

const crypto               = require('crypto');
const sinon                = require('sinon');
const PriceAggregator      = require('../../src/oracle/price_aggregator');
const StateAnchorPublisher = require('../../src/anchor/publisher');
const ValidatorIdentity    = require('../../src/validators/identity');
const { createMockHub, DB_METHODS } = require('./mockHub');
const { CP_ROW }           = require('./anchor_mesh_db.js');
const vectors              = require('../fixtures/anchor_archive_vectors.json');

const HELD_ROUND   = 200;          // finalized on both hubs over P2P before the batch lands
const BATCH_ROUND  = 201;          // carried only by the batch, so ingest inserts it
const BATCH_ANCHOR = 799101;
const BLOCK_INDEX  = 800500;
const ACTION_INDEX = 91;
const BLOCK_TIME   = 1700009000;   // the landing block's protocol time on the DOGE indexer
const PRICE_BLOCK  = 111;          // reference_block of the held round's signed rows

const IDENTITIES = ['11', '22', '33'].map(seed => new ValidatorIdentity(seed.repeat(32)));
const PRICE_SET  = IDENTITIES.map((identity, index) => ({
    pubkey: identity.getPubkeyHex().toLowerCase(), amount: '1', source: 'stake-' + index
}));

function makeBatchSigner() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let pubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    return { pubkey, sign: (payload) => crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex') };
}

const BATCH_SIGNERS = [makeBatchSigner(), makeBatchSigner(), makeBatchSigner()];

function copy(value) {
    return JSON.parse(JSON.stringify(value));
}

function isBatchProof(proof) {
    return String(proof).startsWith('{"batch":');
}

function batchBounds(proof) {
    let batch = JSON.parse(proof).batch;
    return { first: Number(batch.first_round), last: Number(batch.last_round) };
}

// The retraction range and generation fence the SQL binds, as one predicate.
function inRetraction(row, sourceChain, from, to, gen, bounded, fenced) {
    return row.source_chain === sourceChain && Number(row.source_action_index) >= from &&
        (!bounded || Number(row.source_action_index) <= to) &&
        (!fenced || Number(row.push_generation) <= gen);
}

// The upsert rule of setBatchPriceSnapshotRound for one pair.
function upsertBatchRow(rows, fields) {
    let held = rows.find(r => r.round_number === fields.round_number && r.coin_pair === fields.coin_pair);
    if (!held) {
        rows.push(Object.assign({ id: rows.length + 1000 }, fields));
        return;
    }
    let landed = held.batch_block_time;
    Object.assign(held, fields, {
        batch_block_time: (landed === 0 || fields.batch_block_time < landed) ? fields.batch_block_time : landed
    });
}

// Self-finalized rows a retracted batch landing stamped (orphanedLandingQuery in
// src/db/prices/index.js): same clock, round inside a retracted batch row's window.
function orphanedLandings(rows, args) {
    let landed = rows.filter(b => isBatchProof(b.consensus_proof) && inRetraction(b, ...args));
    return rows.filter(s => s.source_action_index === null && !isBatchProof(s.consensus_proof) &&
        s.batch_block_time > 0 && landed.some(b => {
            let w = batchBounds(b.consensus_proof);
            return b.batch_block_time === s.batch_block_time && s.round_number >= w.first && s.round_number <= w.last;
        }));
}

// One hub's price_snapshots, answering each price query the ingest, retraction and archive
// verify paths issue with that statement's own semantics.
function priceTable(rows) {
    return Object.assign({ rows }, ingestQueries(rows), retractionQueries(rows));
}

// The ingest, stamp and archive-verify statements.
function ingestQueries(rows) {
    return {
        async getPriceSnapshotByRoundNumber(round) {
            return rows.filter(r => r.round_number === round && r.status !== 'skipped').slice(0, 1).map(r => ({ id: r.id }));
        },
        async setBatchPriceSnapshotRound(round, pairs, referenceBlock, referenceChain, timestamp, validatorCount,
                                         proofJson, sourceActionIndex, pushGeneration, blockTime, createdAt, admitCols) {
            for (let p of pairs) {
                upsertBatchRow(rows, Object.assign({
                    round_number: round, coin_pair: p.pair, price: p.price, reference_block: referenceBlock,
                    reference_chain: referenceChain, block_timestamp: timestamp, validator_count: validatorCount,
                    consensus_round: 1, consensus_proof: proofJson, status: 'finalized', source_chain: referenceChain,
                    source_action_index: sourceActionIndex, push_generation: pushGeneration,
                    batch_block_time: blockTime, created_at: createdAt
                }, admitCols));
            }
            return {};
        },
        async updatePriceSnapshotByRoundNumber(landed, round, bound) {
            for (let r of rows) {
                if (r.round_number === round && r.status !== 'skipped' && (r.batch_block_time === 0 || r.batch_block_time > bound))
                    r.batch_block_time = landed;
            }
            return {};
        },
        async findPriceSnapshotsByRoundNumberAndBatchBlockTime(round, landed) {
            return copy(rows.filter(r => r.round_number === round && r.batch_block_time === landed));
        },
        async findPriceSnapshotsForRound(round) {
            return copy(rows.filter(r => r.round_number === round)
                .sort((a, b) => String(a.coin_pair).localeCompare(String(b.coin_pair))));
        },
        async getPriceIngestWatermark() { return null; }
    };
}

// The retraction statements: the fence, the deletes and both landing-clock resets.
function retractionQueries(rows) {
    return {
        async bumpPriceIngestWatermark() { return {}; },
        async insertPriceTombstonesForRetraction() { return {}; },
        async deleteOraclePricesForRetraction() { return { affectedRows: 0 }; },
        async findBatchPriceSnapshotRoundsForRetraction(...args) {
            return rows.filter(r => isBatchProof(r.consensus_proof) && inRetraction(r, ...args))
                .map(r => ({ round_number: r.round_number }));
        },
        async findSelfFinalizedRoundsForBatchRetraction(...args) {
            return orphanedLandings(rows, args).map(r => ({ round_number: r.round_number }));
        },
        async resetSelfFinalizedBatchBlockTimeForRetraction(...args) {
            for (let r of orphanedLandings(rows, args)) r.batch_block_time = 0;
            return {};
        },
        async findPriceSnapshotRoundsLandedBetween(first, last) {
            let rounds = rows.filter(r => r.round_number >= first && r.round_number <= last &&
                r.status !== 'skipped' && r.batch_block_time > 0).map(r => r.round_number);
            return [...new Set(rounds)].map(round_number => ({ round_number }));
        },
        async updatePriceSnapshotsClearBatchBlockTimeBetween(first, last) {
            for (let r of rows) {
                if (r.round_number >= first && r.round_number <= last && r.status !== 'skipped' && r.batch_block_time > 0)
                    r.batch_block_time = 0;
            }
            return {};
        },
        async deletePriceSnapshotsForRetraction(...args) {
            let kept = rows.filter(r => !inRetraction(r, ...args));
            let affectedRows = rows.length - kept.length;
            rows.splice(0, rows.length, ...kept);
            return { affectedRows };
        }
    };
}

// The archive co-sign side of a hub: its verify reads the same table its ingest writes.
function archivePublisher(table) {
    let pub = new StateAnchorPublisher({
        db: Object.assign({}, DB_METHODS, {
            getStateCheckpointByChainAndNetwork: async () => [CP_ROW],
            findPriceSnapshotsForRound: (round) => table.findPriceSnapshotsForRound(round)
        }),
        network: 'regtest',
        getIdentity: () => IDENTITIES[0],
        getPeerManager: () => ({ broadcast() {} }),
        resolveBtcLatestBlock: async () => 200,
        p2pConfig: {}
    });
    pub.resolveCapabilitySet = async (capability, block) =>
        (capability === 'price' && block === PRICE_BLOCK) ? PRICE_SET : [];
    return pub;
}

function snapshotOf(signers) {
    return {
        capability: 'price', blockIndex: BLOCK_INDEX, count: signers.length,
        validators: signers.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' }))
    };
}

function makeHub(rows) {
    let hub = createMockHub({ network: 'mainnet' });
    let table = priceTable(rows);
    Object.assign(hub.db, table);
    hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves(snapshotOf(BATCH_SIGNERS)) };
    let agg = new PriceAggregator(hub);
    let pub = archivePublisher(table);
    pub.hub.priceAggregator = agg;
    return { agg, table, pub };
}

// The held round as both hubs finalized it over P2P: one signed proof, no source action,
// no landing yet. Only the id and validator_count differ, as on the rail.
function heldRound(idBase, validatorCount, proof) {
    let rows = copy(vectors.P.inputs.prices.filter(row => row.round_number === 11));
    return rows.map((row, index) => Object.assign(row, {
        id: idBase + index, round_number: HELD_ROUND, consensus_proof: proof, validator_count: validatorCount,
        source_chain: null, source_action_index: null, push_generation: 0, batch_block_time: 0
    }));
}

function signedProof(pub) {
    let rows = heldRound(0, 0, '[]');
    let canonical = pub.priceSnapshotCanonical(rows);
    return JSON.stringify(IDENTITIES.map(identity => ({
        pubkey: identity.getPubkeyHex().toLowerCase(), sig: identity.sign(canonical)
    })));
}

function batchRounds() {
    return [HELD_ROUND, BATCH_ROUND].map((round, i) => ({
        round, timestamp: 1700000000 + (i * 600), btc_block_height: 799100 + i,
        pairs: [{ pair: 'BTC/USD', price: String(50000 + i) }]
    }));
}

// The pushpricebatch payload the DOGE indexer sends, identical for every hub it reaches.
function pushPriceBatch(agg) {
    let rounds = batchRounds();
    let payload = agg.buildPriceBatchPayload(HELD_ROUND, BATCH_ROUND, BATCH_ANCHOR, rounds.map(r => ({
        round: r.round, timestamp: r.timestamp, btcBlockHeight: r.btc_block_height, pairs: r.pairs
    })));
    return {
        first_round: HELD_ROUND, last_round: BATCH_ROUND, btc_block_height: BATCH_ANCHOR, rounds,
        block_time: BLOCK_TIME, action_index: ACTION_INDEX, block_index: BLOCK_INDEX, push_generation: 0,
        sigs: BATCH_SIGNERS.map(v => ({ pubkey: v.pubkey, sig: v.sign(payload) }))
    };
}

// What the leader archives for the held round: its own rows, serialized for the wire.
async function leaderArchive(leader) {
    let rows = await leader.table.findPriceSnapshotsForRound(HELD_ROUND);
    return rows.map(row => leader.pub.serializePriceSnapshot(row));
}

function stamps(hub, round) {
    return hub.table.rows.filter(r => r.round_number === round).map(r => r.batch_block_time);
}

// A leader and a follower holding the same finalized round, console quieted.
function makeHubs() {
    let proof = signedProof(archivePublisher(priceTable([])));
    let hubs = { leader: makeHub(heldRound(1, 0, proof)), follower: makeHub(heldRound(51, 1, proof)) };
    sinon.stub(console, 'log');
    sinon.stub(console, 'warn');
    sinon.stub(console, 'info');
    return hubs;
}

module.exports = {
    HELD_ROUND, BATCH_ROUND, BATCH_ANCHOR, BLOCK_INDEX, ACTION_INDEX, BLOCK_TIME, BATCH_SIGNERS,
    copy, isBatchProof, pushPriceBatch, leaderArchive, stamps, makeHubs
};
