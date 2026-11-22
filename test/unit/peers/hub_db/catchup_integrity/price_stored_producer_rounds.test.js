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
const { producerProofReason } = require('../../../../../src/oracle/price_aggregator/producer_proof.js');
const consensusCommit = require('../../../../../src/oracle/consensus/commit.js');
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
    const signers = env.validators.slice(0, 3).concat(opts.extraSigner ? [opts.extraSigner] : []);
    let sigs = signers.map(item => ({
        pubkey: item.pubkey, sig: opts.forged ? 'ab'.repeat(64) : item.sign(payload)
    })).sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1));
    if (opts.proofEdit) sigs = opts.proofEdit(sigs);
    const referenceChain = opts.referenceChain || 'BTC';
    return pairs.map((pair, index) => ({
        id: firstId + index,
        round_number: round,
        coin_pair: pair.pair,
        price: pair.price,
        reference_block: REFERENCE_BLOCK,
        reference_chain: referenceChain,
        block_timestamp: timestamp,
        validator_count: opts.validatorCount === undefined ? 3 : opts.validatorCount,
        consensus_round: 1,
        consensus_proof: typeof sigs === 'string' ? sigs : JSON.stringify(sigs),
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

async function verdictOf(env, rows, index) {
    return verifyPriceSnapshot(rows[index || 0], contextFor(env, rows));
}

describe('price catch-up verifier over the stored proof and count of a producer round', function () {
    afterEach(function () { sinon.restore(); });

    it('accepts an honest round whose proof carries a validly signed non-qualified key and a larger voter count', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 157820, 1101200, { extraSigner: validator(), validatorCount: 4 });
        expect(JSON.parse(rows[0].consensus_proof)).to.have.length(4);
        for (let index = 0; index < rows.length; index++) {
            expect(await verdictOf(env, rows, index)).to.deep.equal({ ok: true });
        }
    });

    it('refuses a proof padded with a qualified pubkey and a junk signature', async function () {
        const env = setup();
        const junk = { pubkey: env.validators[3].pubkey, sig: 'cd'.repeat(64) };
        const rows = storedRoundRows(env, 157821, 1101203, { proofEdit: sigs =>
            sigs.concat(junk).sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1)) });
        expect(await verdictOf(env, rows)).to.deep.equal(
            { ok: false, reason: 'stored round proof carries an unverified signature' });
    });

    it('refuses a proof that repeats an entry', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 157822, 1101206, { proofEdit: sigs => [sigs[0]].concat(sigs) });
        expect(await verdictOf(env, rows)).to.deep.equal(
            { ok: false, reason: 'stored round proof is not in strict lowercase pubkey order' });
    });

    it('refuses a proof whose entries are out of pubkey order', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 157823, 1101209, { proofEdit: sigs => sigs.slice().reverse() });
        expect(await verdictOf(env, rows)).to.deep.equal(
            { ok: false, reason: 'stored round proof is not in strict lowercase pubkey order' });
    });

});

describe('price catch-up verifier over the canonical form of a stored producer proof', function () {
    afterEach(function () { sinon.restore(); });

    it('refuses a proof that repeats a key in another letter case', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 157824, 1101212, { proofEdit: sigs => {
            const first = sigs[0];
            const upper = { pubkey: first.pubkey.toUpperCase(), sig: first.sig };
            return [first, upper, ...sigs.slice(1)].sort((a, b) => (a.pubkey < b.pubkey ? -1 : 1));
        } });
        const verdict = await verdictOf(env, rows);
        expect(verdict.ok).to.equal(false);
        expect(verdict.reason).to.equal('stored round proof is not in strict lowercase pubkey order');
    });

    it('refuses a proof entry with an extra field and a proof with added whitespace', async function () {
        const env = setup();
        const extra = storedRoundRows(env, 157825, 1101215, { proofEdit: sigs =>
            sigs.map((entry, index) => (index === 0 ? Object.assign({ note: 'x' }, entry) : entry)) });
        expect(await verdictOf(env, extra)).to.deep.equal(
            { ok: false, reason: 'stored round proof is not in canonical form' });
        const spaced = storedRoundRows(env, 157826, 1101218, { proofEdit: sigs => JSON.stringify(sigs, null, 1) });
        expect(await verdictOf(env, spaced)).to.deep.equal(
            { ok: false, reason: 'stored round proof is not in canonical form' });
    });

    it('refuses an oversized proof before verifying its entries', function () {
        const proof = Array.from({ length: 1025 }, () => ({ pubkey: 'a', sig: 'b' }));
        const reason = producerProofReason({ consensus_proof: JSON.stringify(proof), validator_count: 1 }, proof, {});
        expect(reason).to.equal('stored round proof has too many entries');
    });

    it('refuses a proof carrying a single uppercased pubkey that no other entry repeats', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 157830, 1101230, { proofEdit: sigs =>
            sigs.map((entry, index) => (index === 0 ? { pubkey: entry.pubkey.toUpperCase(), sig: entry.sig } : entry)) });
        expect(JSON.parse(rows[0].consensus_proof)[0].pubkey).to.match(/[A-F]/);
        expect(await verdictOf(env, rows)).to.deep.equal(
            { ok: false, reason: 'stored round proof is not in strict lowercase pubkey order' });
    });

});

describe('price catch-up verifier over the stored count of a producer round', function () {
    afterEach(function () { sinon.restore(); });

    it('refuses a validator_count that is not a whole number', async function () {
        const env = setup();
        for (const bad of ['3.5', -1, 'many', '1e3']) {
            const rows = storedRoundRows(env, 157827, 1101221, { validatorCount: bad });
            expect(await verdictOf(env, rows), String(bad)).to.deep.equal(
                { ok: false, reason: 'stored round validator_count is not a whole number' });
        }
    });

    it('refuses a group whose rows disagree on validator_count', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 157828, 1101224);
        rows[1].validator_count = 4;
        expect(await verdictOf(env, rows)).to.deep.equal(
            { ok: false, reason: 'price round rows disagree on the signed round' });
    });

    it('refuses a validator_count above both the snapshot and proof sizes', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 157829, 1101227, { validatorCount: 99999999 });
        expect(await verdictOf(env, rows)).to.deep.equal(
            { ok: false, reason: 'stored round validator_count exceeds the round signer bound' });
    });

    it('refuses a zero validator_count beside a fully signed proof', async function () {
        const env = setup();
        for (const zero of [0, '0', '00']) {
            const rows = storedRoundRows(env, 157831, 1101233, { validatorCount: zero });
            expect(JSON.parse(rows[0].consensus_proof)).to.have.length(3);
            expect(await verdictOf(env, rows), String(zero)).to.deep.equal(
                { ok: false, reason: 'stored round validator_count is below the proposer floor' });
        }
    });

    it('accepts the smallest honest validator_count, the single proposer a solo or federated round records', async function () {
        const env = setup();
        const rows = storedRoundRows(env, 157832, 1101236, { validatorCount: 1 });
        expect(await verdictOf(env, rows)).to.deep.equal({ ok: true });
    });

    it('accepts one signed proof beside each PREPARE tally the producer writer can record for it', async function () {
        const env = setup();
        const pending = { memberPubkeys: new Set(env.validators.map(item => item.pubkey)) };
        const proposerOnly = consensusCommit.countDistinctMembers(pending, new Set([env.validators[0].pubkey]));
        const everyMember = consensusCommit.countDistinctMembers(pending, pending.memberPubkeys);
        expect([proposerOnly, everyMember]).to.deep.equal([1, 4]);
        for (const [offset, count] of [[0, proposerOnly], [3, everyMember]]) {
            const rows = storedRoundRows(env, 157833, 1101239 + offset, { validatorCount: count });
            expect(await verdictOf(env, rows), String(count)).to.deep.equal({ ok: true });
        }
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
        const stored = env.db.setFinalizedPriceSnapshotRound.getCalls().flatMap(call => call.args[1].map(pair =>
            [call.args[0], pair.coinPair, pair.price].join('|')));
        expect(stored.sort()).to.deep.equal(
            rows.map(row => [row.round_number, row.coin_pair, row.price].join('|')).sort());
        expect(env.db.setPushedPriceSnapshotRound.called).to.equal(false);
        expect(env.db.setBatchPriceSnapshotRound.called).to.equal(false);
        expect(catchup.refusals.size()).to.equal(0);
        expect(catchup.tableCaughtUp('price_snapshots')).to.equal(true);
    });
});
