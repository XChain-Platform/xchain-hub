'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const sinon = require('sinon');
const { expect } = require('chai');
const PriceAggregator = require('../../../../src/oracle/price_aggregator.js');
const { verifyPriceSnapshot } = require('../../../../src/oracle/price_aggregator/catchup_verifiers.js');
const { rememberCatchupHub } = require('../../../../src/peers/hub_db/catchup_context.js');
const { createMockHub } = require('../../../helpers/mockHub.js');
const { priceDb, makeCatchup } = require('./helpers/peer_catchup_harness.js');

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

function producerRows(env, round, firstId, options) {
    const opts = options || {};
    const pairs = [{ pair: 'BTC/USD', price: '50000' }, { pair: 'LTC/USD', price: '80' }];
    const timestamp = 1700000000 + round;
    const payload = env.aggregator.buildPriceV0Payload(round, timestamp, pairs, REFERENCE_BLOCK, null);
    const sigs = env.validators.slice(0, 3).map(item => ({
        pubkey: item.pubkey, sig: opts.forged ? 'ab'.repeat(64) : item.sign(payload)
    }));
    return pairs.map((pair, index) => ({
        id: firstId + index,
        round_number: round,
        coin_pair: pair.pair,
        price: pair.price,
        reference_block: REFERENCE_BLOCK,
        reference_chain: 'BTC',
        block_timestamp: timestamp,
        validator_count: 3,
        consensus_round: 1,
        consensus_proof: JSON.stringify(sigs),
        status: 'finalized',
        source_chain: opts.sourceChain || null,
        source_action_index: null,
        push_generation: 0,
        batch_block_time: null,
        created_at: null,
        admit_block_btc: null,
        admit_block_ltc: null,
        admit_block_doge: null
    }));
}

function feed(rows) {
    return sinon.stub().callsFake(async (peer, table, cursor, limit) => ({
        table, rows: rows.filter(row => row.id > cursor).slice(0, limit)
    }));
}

function walkOf(env, rows, pageSize) {
    const logger = { warn: sinon.stub(), error: sinon.stub() };
    const catchup = makeCatchup({
        db: env.db, getVerifier: () => verifyPriceSnapshot, fetchPage: feed(rows),
        pageSize, indexerReadIntervalMs: 0, logger
    });
    return { catchup, logger };
}

function storedPairs(db) {
    return db.setFinalizedPriceSnapshotRound.getCalls().map(call => call.args[1][0].coinPair).sort();
}

describe('price catch-up of producer round groups', function () {
    afterEach(function () { sinon.restore(); });

    it('accepts a signed producer price round from a signer peer on catch-up', async function () {
        const env = setup();
        const { catchup } = walkOf(env, producerRows(env, 7, 1), 2);
        await catchup.run();
        expect(storedPairs(env.db)).to.deep.equal(['BTC/USD', 'LTC/USD']);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });

    it('verifies a round whose pair rows straddle a page boundary', async function () {
        const env = setup();
        const { catchup } = walkOf(env, producerRows(env, 7, 1), 1);
        await catchup.run();
        expect(storedPairs(env.db)).to.deep.equal(['BTC/USD', 'LTC/USD']);
    });

    it('still refuses a price round whose signatures do not verify', async function () {
        const env = setup();
        const { catchup, logger } = walkOf(env, producerRows(env, 7, 1, { forged: true }), 2);
        await catchup.run();
        expect(env.db.setFinalizedPriceSnapshotRound.called).to.equal(false);
        expect(logger.warn.calledWithMatch('insufficient quorum')).to.equal(true);
    });

    it('resolves the aggregator from the catch-up db when the context carries no hub', async function () {
        const env = setup();
        const rows = producerRows(env, 7, 1);
        const context = { peer: 'ws://peer', db: env.db, priceRoundRows: rows };
        expect(await verifyPriceSnapshot(rows[0], context)).to.deep.equal({ ok: true });
        expect(await verifyPriceSnapshot(rows[0], { peer: 'ws://peer', db: {}, priceRoundRows: rows }))
            .to.deep.equal({ ok: false, reason: 'complete signed round unavailable' });
    });

    it('reads the price snapshot once per round through the walk reader', async function () {
        const env = setup();
        const rows = producerRows(env, 7, 1).concat(producerRows(env, 8, 3));
        const { catchup } = walkOf(env, rows, 10);
        await catchup.run();
        expect(storedPairs(env.db)).to.have.length(4);
        expect(env.hub.capabilitySnapshot.getSnapshot.callCount).to.be.at.most(1);
    });

    it('leaves a pushed row without a proof refused and the table caught up', async function () {
        const env = setup();
        const { catchup, logger } = walkOf(env, producerRows(env, 7, 1, { sourceChain: 'BTC' }), 2);
        await catchup.run();
        expect(env.db.setFinalizedPriceSnapshotRound.called).to.equal(false);
        expect(logger.warn.calledWithMatch('complete signed round unavailable')).to.equal(true);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });
});
