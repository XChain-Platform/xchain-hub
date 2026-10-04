'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const sinon = require('sinon');
const { expect } = require('chai');
const PriceAggregator = require('../../../../src/oracle/price_aggregator.js');
const registry = require('../../../../src/peers/hub_db/catchup_verifiers.js');
const { verifyPriceSnapshot, verifyOraclePrice } =
    require('../../../../src/oracle/price_aggregator/catchup_verifiers.js');
const { createMockHub } = require('../../../helpers/mockHub.js');

function validator() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        pubkey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
        sign: payload => crypto.sign(null, Buffer.from(payload), privateKey).toString('hex')
    };
}

function setupAggregator(validators) {
    const hub = createMockHub();
    const aggregator = new PriceAggregator(hub);
    hub.priceAggregator = aggregator;
    hub.capabilitySnapshot = {
        getSnapshot: sinon.stub().resolves({
            count: validators.length,
            validators: validators.map(item => ({ pubkey: item.pubkey, amount: '1' }))
        })
    };
    return { hub, aggregator };
}

function signedRound(aggregator, validators) {
    const data = {
        round: 7,
        timestamp: 1700000000,
        btc_block_height: 799000,
        block_index: 800000,
        action_index: 42,
        push_generation: 3,
        pairs: [{ pair: 'BTC/USD', price: '50000' }, { pair: 'LTC/USD', price: '80' }]
    };
    const payload = aggregator.buildPriceV0Payload(
        data.round, data.timestamp, data.pairs, data.btc_block_height, null);
    data.sigs = validators.slice(0, 3).map(item => ({ pubkey: item.pubkey, sig: item.sign(payload) }));
    return data;
}

function roundRow(data) {
    return {
        id: 11,
        round_number: data.round,
        coin_pair: data.pairs[0].pair,
        price: data.pairs[0].price,
        reference_block: data.block_index,
        reference_chain: 'BTC',
        block_timestamp: data.timestamp,
        validator_count: 3,
        consensus_round: 1,
        consensus_proof: JSON.stringify(data.sigs),
        status: 'finalized',
        source_chain: 'BTC',
        source_action_index: data.action_index,
        push_generation: data.push_generation,
        batch_block_time: 0,
        admit_block_btc: null,
        admit_block_ltc: null,
        admit_block_doge: null
    };
}

function signedBatch(aggregator, validators) {
    const round = {
        round: 9,
        timestamp: 1700000600,
        btc_block_height: 799100,
        pairs: [{ pair: 'BTC/USD', price: '51000' }]
    };
    const data = {
        first_round: 9,
        last_round: 9,
        btc_block_height: 799100,
        block_index: 900000,
        block_time: 1700000700,
        action_index: 51,
        push_generation: 4,
        rounds: [round]
    };
    const canonicalRounds = [{
        round: round.round,
        timestamp: round.timestamp,
        btcBlockHeight: round.btc_block_height,
        pairs: round.pairs
    }];
    const payload = aggregator.buildPriceBatchPayload(9, 9, 799100, canonicalRounds);
    data.sigs = validators.slice(0, 3).map(item => ({ pubkey: item.pubkey, sig: item.sign(payload) }));
    return data;
}

function batchRow(data) {
    const proof = JSON.stringify({
        batch: { first_round: 9, last_round: 9, btc_block_height: 799100 },
        sigs: data.sigs
    });
    return {
        id: 12,
        round_number: 9,
        coin_pair: 'BTC/USD',
        price: '51000',
        reference_block: data.block_index,
        reference_chain: 'BTC',
        block_timestamp: data.rounds[0].timestamp,
        validator_count: 3,
        consensus_round: 1,
        consensus_proof: proof,
        status: 'finalized',
        source_chain: 'BTC',
        source_action_index: data.action_index,
        push_generation: data.push_generation,
        batch_block_time: data.block_time,
        admit_block_btc: null,
        admit_block_ltc: null,
        admit_block_doge: null
    };
}

function validOracleRow() {
    return {
        id: 21,
        source_address: 'oracle-address',
        source_chain: 'BTC',
        coin: 'BTC',
        tick: 'TOKEN',
        fiat: 'USD',
        value: '1.25',
        fee: '0.01',
        memo: null,
        block_time: 1700000000,
        effective_at: 1700086400,
        action_index: 42,
        push_generation: 3,
        admit_block: null
    };
}

afterEach(function () { sinon.restore(); });

describe('price snapshot catch-up verifier', function () {
    it('registers both mirrored price tables', function () {
        expect(registry.getCatchupVerifier('price_snapshots')).to.equal(verifyPriceSnapshot);
        expect(registry.getCatchupVerifier('oracle_prices')).to.equal(verifyOraclePrice);
    });

    it('accepts only a row bound to a fully verified PRICE round', async function () {
        const validators = [validator(), validator(), validator(), validator()];
        const { hub, aggregator } = setupAggregator(validators);
        const data = signedRound(aggregator, validators);
        const row = roundRow(data);
        const context = { peer: 'ws://peer', hub, priceProof: { sourceChain: 'BTC', roundData: data } };

        expect(await verifyPriceSnapshot(row, context)).to.deep.equal({ ok: true });
        expect(await verifyPriceSnapshot(Object.assign({}, row, { price: '1' }), context))
            .to.deep.equal({ ok: false, reason: 'row does not match signed round' });
        expect(await verifyPriceSnapshot(Object.assign({}, row, { consensus_round: 2 }), context))
            .to.deep.equal({ ok: false, reason: 'row does not match signed round' });

        const forgedProof = data.sigs.map(item => ({ pubkey: item.pubkey, sig: 'ab'.repeat(64) }));
        const forgedRow = Object.assign({}, row, { consensus_proof: JSON.stringify(forgedProof) });
        expect((await verifyPriceSnapshot(forgedRow, context)).reason).to.match(/^insufficient quorum/);
    });

    it('verifies batch rows against the signed batch header and body', async function () {
        const validators = [validator(), validator(), validator(), validator()];
        const { hub, aggregator } = setupAggregator(validators);
        const data = signedBatch(aggregator, validators);
        const row = batchRow(data);
        const context = { peer: 'ws://peer', hub, priceProof: { sourceChain: 'BTC', batchData: data } };

        expect(await verifyPriceSnapshot(row, context)).to.deep.equal({ ok: true });
        expect(await verifyPriceSnapshot(Object.assign({}, row, { consensus_round: 2 }), context))
            .to.deep.equal({ ok: false, reason: 'row does not match signed batch' });
        const forged = Object.assign({}, row, { consensus_proof: row.consensus_proof.replace(/.$/, '0') });
        expect((await verifyPriceSnapshot(forged, context)).ok).to.equal(false);
    });

    it('requires complete signed price material instead of trusting a snapshot row', async function () {
        const validators = [validator(), validator(), validator(), validator()];
        const { aggregator } = setupAggregator(validators);
        const row = roundRow(signedRound(aggregator, validators));

        expect(await verifyPriceSnapshot(row, { peer: 'ws://peer' }))
            .to.deep.equal({ ok: false, reason: 'complete signed round unavailable' });
    });
});

describe('oracle price catch-up verifier', function () {
    it('applies authentication, field, effective-time, and generation guards to oracle rows', async function () {
        const row = validOracleRow();
        const db = { getPriceIngestWatermark: sinon.stub().resolves(null) };
        const context = {
            peer: 'ws://peer', authenticated: true, signerSetPeer: true,
            db, network: 'testnet'
        };

        expect(await verifyOraclePrice(row, context)).to.deep.equal({ ok: true });
        for (const untrusted of [
            { peer: 'ws://peer', db },
            { peer: 'ws://peer', authenticated: true, db },
            { peer: 'ws://peer', signerSetPeer: true, db },
            { peer: 'ws://peer', authenticated: false, signerSetPeer: true, db },
            { peer: 'ws://peer', authenticated: true, signerSetPeer: false, db }
        ]) {
            expect((await verifyOraclePrice(row, untrusted)).reason)
                .to.contain('authenticated signer-set peer');
        }
        expect((await verifyOraclePrice(Object.assign({}, row, { value: '0' }), context)).reason)
            .to.equal('invalid value');
        expect((await verifyOraclePrice(Object.assign({}, row, { effective_at: row.effective_at - 1 }), context)).reason)
            .to.equal('invalid effective_at');

        db.getPriceIngestWatermark.resolves({ retraction_generation: 3, from_action_index: 40 });
        expect(await verifyOraclePrice(row, context))
            .to.deep.equal({ ok: false, reason: 'stale (retracted generation)' });
    });
});
