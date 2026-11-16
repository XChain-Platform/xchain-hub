'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// Signed producer price rounds and a walkable peer feed, for the price catch-up walk suites.

const crypto = require('crypto');
const sinon = require('sinon');
const PriceAggregator = require('../../../../../src/oracle/price_aggregator.js');
const { verifyPriceSnapshot } = require('../../../../../src/oracle/price_aggregator/catchup_verifiers.js');
const { rememberCatchupHub } = require('../../../../../src/peers/hub_db/catchup_context.js');
const { createMockHub } = require('../../../../helpers/mockHub.js');
const { HUB_SCHEMA_VERSION } = require('../../../../../src/hub_schema_version.js');
const { priceDb, makeCatchup } = require('./peer_catchup_harness.js');

const REFERENCE_BLOCK = 800000;

function validator() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        pubkey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
        sign: payload => crypto.sign(null, Buffer.from(payload), privateKey).toString('hex')
    };
}

function setup() {
    const validators = [validator(), validator(), validator(), validator()];
    const db = priceDb();
    const hub = createMockHub();
    hub.db = db;
    const aggregator = new PriceAggregator(hub);
    hub.priceAggregator = aggregator;
    hub.capabilitySnapshot = {
        getSnapshot: sinon.stub().resolves({
            count: validators.length,
            validators: validators.map(item => ({ pubkey: item.pubkey, amount: '1' }))
        })
    };
    rememberCatchupHub(hub);
    return { validators, db, hub, aggregator };
}

// The two pair rows of one signed producer round, with ids firstId and firstId + 1.
function producerRows(env, round, firstId, options) {
    const opts = options || {};
    const pairs = [{ pair: 'BTC/USD', price: '50000' }, { pair: 'LTC/USD', price: '80' }];
    const timestamp = 1700000000 + round;
    const payload = env.aggregator.buildPriceV0Payload(round, timestamp, pairs, REFERENCE_BLOCK, null);
    const sigs = env.validators.slice(0, 3).map(item => ({
        pubkey: item.pubkey, sig: opts.forged ? 'ab'.repeat(64) : item.sign(payload)
    })).sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1));
    return pairs.map((pair, index) => ({
        id: firstId + index, round_number: round, coin_pair: pair.pair, price: pair.price,
        reference_block: REFERENCE_BLOCK, reference_chain: 'BTC', block_timestamp: timestamp,
        validator_count: 3, consensus_round: 1, consensus_proof: JSON.stringify(sigs), status: 'finalized',
        source_chain: null, source_action_index: null, push_generation: 0, batch_block_time: null,
        created_at: null, admit_block_btc: null, admit_block_ltc: null, admit_block_doge: null
    }));
}

// Serves the rows of a list read at call time, so a test can change what a peer serves between walks.
function feed(rows) {
    return sinon.stub().callsFake(async (peer, table, cursor, limit) => ({
        table, schema_version: HUB_SCHEMA_VERSION, rows: rows.filter(row => row.id > cursor).slice(0, limit)
    }));
}

function walkOf(env, rows, pageSize, extra) {
    const logger = { warn: sinon.stub(), error: sinon.stub() };
    const catchup = makeCatchup(Object.assign({
        db: env.db, getVerifier: () => verifyPriceSnapshot, fetchPage: feed(rows),
        pageSize, indexerReadIntervalMs: 0, logger
    }, extra));
    return { catchup, logger };
}

function storedPairs(db) {
    return db.setFinalizedPriceSnapshotRound.getCalls()
        .map(call => call.args[0] + '|' + call.args[1][0].coinPair).sort();
}

// A producer pair row of another round, standing for a per-pair marker or any row between two halves of a round.
function withId(row, id) {
    return Object.assign({}, row, { id });
}

module.exports = { setup, producerRows, feed, walkOf, storedPairs, withId, REFERENCE_BLOCK };
