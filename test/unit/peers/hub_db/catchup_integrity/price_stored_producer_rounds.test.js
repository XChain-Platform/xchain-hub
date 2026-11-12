'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

// The price catch-up verifier over rows in the form price_snapshots actually stores
// and serves them. A round the federation finalized itself is inserted without a
// source_chain, so the column default ('DOGE') sits beside reference_chain 'BTC'. A
// follower that restarts and walks a peer's table sees that form, never NULL, and must
// verify the missed round from its own signature set rather than refuse it for want of
// a pushed source transaction it can never be given.

const crypto = require('crypto');
const sinon = require('sinon');
const { expect } = require('chai');
const PriceAggregator = require('../../../../../src/oracle/price_aggregator.js');
const { verifyPriceSnapshot } = require('../../../../../src/oracle/price_aggregator/catchup_verifiers.js');
const { rememberCatchupHub } = require('../../../../../src/peers/hub_db/catchup_context.js');
const { createMockHub } = require('../../../../helpers/mockHub.js');
const { HUB_SCHEMA_VERSION } = require('../../../../../src/hub_schema_version.js');
const { priceDb, makeCatchup } = require('../helpers/peer_catchup_harness.js');

const REFERENCE_BLOCK = 65689;
// The price_snapshots.source_chain column default, which a producer insert inherits.
const STORED_DEFAULT_SOURCE_CHAIN = 'DOGE';

function validator() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        pubkey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
        sign: payload => crypto.sign(null, Buffer.from(payload), privateKey).toString('hex')
    };
}

function setup() {
    const validators = [validator(), validator(), validator(), validator()];
    const db = Object.assign(priceDb(), {
        setPushedPriceSnapshotRound: sinon.stub().resolves({ affectedRows: 1 }),
        setBatchPriceSnapshotRound: sinon.stub().resolves({ affectedRows: 1 })
    });
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

// One finalized round exactly as SELECT * serves it from the producer's table.
function storedRoundRows(env, round, firstId, options) {
    const opts = options || {};
    const pairs = [{ pair: 'BTC/USD', price: '50000' }, { pair: 'LTC/USD', price: '80' },
        { pair: 'DOGE/USD', price: '0.12' }];
    const timestamp = 1700000000 + round;
    const payload = env.aggregator.buildPriceV0Payload(round, timestamp, pairs, REFERENCE_BLOCK, null);
    const sigs = env.validators.slice(0, 3).map(item => ({
        pubkey: item.pubkey, sig: opts.forged ? 'ab'.repeat(64) : item.sign(payload)
    }));
    const referenceChain = opts.referenceChain || 'BTC';
    return pairs.map((pair, index) => ({
        id: firstId + index,
        round_number: round,
        coin_pair: pair.pair,
        price: pair.price,
        reference_block: REFERENCE_BLOCK,
        reference_chain: referenceChain,
        block_timestamp: timestamp,
        validator_count: 3,
        consensus_round: 1,
        consensus_proof: JSON.stringify(sigs),
        status: 'finalized',
        source_chain: opts.sourceChain || STORED_DEFAULT_SOURCE_CHAIN,
        source_action_index: opts.sourceActionIndex === undefined ? null : opts.sourceActionIndex,
        push_generation: 0,
        admit_block_btc: null,
        admit_block_ltc: null,
        admit_block_doge: null,
        batch_block_time: 0,
        batch_seq: null,
        archived_status: null,
        archived_batch_block_time: null,
        archived_proof_sha: null,
        created_at: '2026-11-11T07:32:00.000Z'
    }));
}

function contextFor(env, rows) {
    return { peer: 'ws://peer', hub: env.hub, priceRoundRows: rows };
}

describe('price catch-up verifier over stored producer rounds', function () {
    afterEach(function () { sinon.restore(); });

    it('accepts every pair of a missed round stored with the default source_chain, given only its round rows', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 157812, 1101118);
        for (const row of rows) {
            expect(await verifyPriceSnapshot(row, contextFor(env, rows))).to.deep.equal({ ok: true });
        }
    });

    it('accepts a stored round whose landing clock was stamped after it finalized', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 157813, 1101121).map(row =>
            Object.assign(row, { batch_block_time: 1700000500 }));
        expect(await verifyPriceSnapshot(rows[1], contextFor(env, rows))).to.deep.equal({ ok: true });
    });

    it('refuses a stored round with one tampered price', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 157812, 1101118);
        rows[2].price = '0.13';
        const verdict = await verifyPriceSnapshot(rows[0], contextFor(env, rows));
        expect(verdict.ok).to.equal(false);
    });

    it('refuses a stored round whose signatures do not sign it', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 157812, 1101118, { forged: true });
        const verdict = await verifyPriceSnapshot(rows[0], contextFor(env, rows));
        expect(verdict.ok).to.equal(false);
    });
});

describe('price catch-up verifier refusals around stored producer rounds', function () {
    afterEach(function () { sinon.restore(); });

    it('refuses a lone pair row of a multi-pair round', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 157812, 1101118);
        const verdict = await verifyPriceSnapshot(rows[0], { peer: 'ws://peer', hub: env.hub });
        expect(verdict.ok).to.equal(false);
    });

    it('refuses a row offered with a different round as its group', async function () {
        const env = setup();
        const missed = storedRoundRows(env, 157812, 1101118);
        const other = storedRoundRows(env, 157813, 1101121);
        const verdict = await verifyPriceSnapshot(missed[0], contextFor(env, other));
        expect(verdict.ok).to.equal(false);
    });

    it('still refuses a pushed round, whose source_chain equals reference_chain, without its signed source', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 7, 1, { sourceChain: 'BTC', sourceActionIndex: 42 });
        const verdict = await verifyPriceSnapshot(rows[0], contextFor(env, rows));
        expect(verdict).to.deep.equal({ ok: false, reason: 'complete signed round unavailable' });
    });

    it('does not treat a stored round that names a source action as a producer round', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 7, 1, { sourceActionIndex: 42 });
        const verdict = await verifyPriceSnapshot(rows[0], contextFor(env, rows));
        expect(verdict).to.deep.equal({ ok: false, reason: 'complete signed round unavailable' });
    });
});

function feed(rows) {
    return sinon.stub().callsFake(async (peer, table, after, limit) => ({
        table, schema_version: HUB_SCHEMA_VERSION, rows: rows.filter(row => row.id > after).slice(0, limit)
    }));
}

describe('price catch-up walk over missed stored producer rounds', function () {
    afterEach(function () { sinon.restore(); });

    it('stores every missed round as its producer stored it and remembers no refusal', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 157812, 1101118)
            .concat(storedRoundRows(env, 157813, 1101121), storedRoundRows(env, 157814, 1101124));
        const logger = { warn: sinon.stub(), error: sinon.stub() };
        const catchup = makeCatchup({ db: env.db, getVerifier: () => verifyPriceSnapshot,
            fetchPage: feed(rows), pageSize: 4, indexerReadIntervalMs: 0, logger });
        await catchup.run();
        expect(logger.warn.calledWithMatch('refused')).to.equal(false);
        const stored = env.db.setFinalizedPriceSnapshotRound.getCalls().map(call =>
            [call.args[0], call.args[1][0].coinPair, call.args[1][0].price].join('|'));
        expect(stored.sort()).to.deep.equal(
            rows.map(row => [row.round_number, row.coin_pair, row.price].join('|')).sort());
        expect(env.db.setPushedPriceSnapshotRound.called).to.equal(false);
        expect(env.db.setBatchPriceSnapshotRound.called).to.equal(false);
        expect(catchup.refusals.size()).to.equal(0);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });
});
