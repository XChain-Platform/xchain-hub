'use strict';
const { HUB_SCHEMA_VERSION } = require('../../../../src/hub_schema_version.js');

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const sinon = require('sinon');
const { expect } = require('chai');
const PriceAggregator = require('../../../../src/oracle/price_aggregator.js');
const { verifyPriceSnapshot } = require('../../../../src/oracle/price_aggregator/catchup_verifiers.js');
const { storePriceSnapshot, ROUND_AGREEMENT_KEYS } = require('../../../../src/peers/hub_db/price_round_groups.js');
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
        table, schema_version: HUB_SCHEMA_VERSION, rows: rows.filter(row => row.id > cursor).slice(0, limit)
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

function localRecordRow(id, round, status) {
    return Object.assign(producerRows({ aggregator: { buildPriceV0Payload: () => '' }, validators: [] }, round, id)[0], {
        id, coin_pair: 'DOGE/USD', price: null, validator_count: 0, consensus_proof: '[]', status
    });
}

describe('price catch-up agreement of a round group', function () {
    afterEach(function () { sinon.restore(); });

    it('refuses a group whose rows disagree on any field the round signs', async function () {
        const env = setup();
        for (const key of ROUND_AGREEMENT_KEYS) {
            const rows = producerRows(env, 7, 1);
            rows[1][key] = key === 'consensus_proof' ? '[]' : 99;
            const verdict = await verifyPriceSnapshot(rows[0], { peer: 'ws://peer', db: env.db, priceRoundRows: rows });
            expect(verdict, key).to.deep.equal({ ok: false, reason: 'price round rows disagree on the signed round' });
        }
        const agreed = producerRows(env, 7, 1);
        expect(await verifyPriceSnapshot(agreed[0], { peer: 'ws://peer', db: env.db, priceRoundRows: agreed }))
            .to.deep.equal({ ok: true });
    });

    it('refuses a group that repeats a coin pair', async function () {
        const env = setup();
        const rows = producerRows(env, 7, 1);
        rows[1].coin_pair = rows[0].coin_pair;
        const verdict = await verifyPriceSnapshot(rows[0], { peer: 'ws://peer', db: env.db, priceRoundRows: rows });
        expect(verdict.reason).to.equal('price round rows disagree on the signed round');
    });
});

describe('price catch-up holding of the round that ends a full page', function () {
    afterEach(function () { sinon.restore(); });

    it('verifies a round whole when its pair rows are not adjacent on the page', async function () {
        const env = setup();
        const [sevenBtc, sevenLtc] = producerRows(env, 7, 1);
        const [eightBtc, eightLtc] = producerRows(env, 8, 3);
        Object.assign(sevenBtc, { id: 1 });
        Object.assign(eightBtc, { id: 2 });
        Object.assign(eightLtc, { id: 3 });
        Object.assign(sevenLtc, { id: 4 });
        const { catchup, logger } = walkOf(env, [sevenBtc, eightBtc, eightLtc, sevenLtc], 4);
        await catchup.run();
        expect(storedPairs(env.db)).to.deep.equal(['BTC/USD', 'BTC/USD', 'LTC/USD', 'LTC/USD']);
        expect(logger.warn.called).to.equal(false);
    });
});

describe('price catch-up of rows another hub recorded as its own outcome', function () {
    afterEach(function () { sinon.restore(); });

    it('marks a skipped or disputed row as not mirrored instead of refusing it as unsigned', async function () {
        for (const status of ['skipped', 'disputed']) {
            const verdict = await verifyPriceSnapshot(localRecordRow(1, 5, status), { peer: 'ws://peer' });
            expect(verdict).to.deep.equal({ ok: false, reason: 'price snapshot is not finalized', notMirrored: true });
        }
    });

    it('stores the finalized rounds of a walk without counting, logging or remembering skipped rows', async function () {
        const env = setup();
        const rows = [localRecordRow(1, 5, 'skipped'), localRecordRow(2, 6, 'disputed')]
            .concat(producerRows(env, 7, 3));
        const { catchup, logger } = walkOf(env, rows, 10);
        await catchup.run();
        expect(storedPairs(env.db)).to.deep.equal(['BTC/USD', 'LTC/USD']);
        expect(logger.warn.called).to.equal(false);
        expect(catchup.refusals.size()).to.equal(0);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });

    it('still counts and remembers a row the verifier refuses for a lasting reason', async function () {
        const env = setup();
        const { catchup, logger } = walkOf(env, producerRows(env, 7, 1, { forged: true }), 10);
        await catchup.run();
        expect(logger.warn.calledWithMatch('refused (0 already known)')).to.equal(true);
        expect(catchup.refusals.size()).to.equal(1);
    });

    it('refuses to write a skipped or disputed row if a verifier ever lets one through', function () {
        const db = priceDb();
        for (const status of ['skipped', 'disputed']) {
            expect(() => storePriceSnapshot(db, localRecordRow(1, 5, status))).to.throw('finalized');
        }
        expect(db.setFinalizedPriceSnapshotRound.called).to.equal(false);
    });
});
