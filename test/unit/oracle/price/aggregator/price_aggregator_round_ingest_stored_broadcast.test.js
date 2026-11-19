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

// A pushed round whose duplicate read ran before local consensus finalized the
// same round: the upsert keeps the producer row, so the mirror stream must carry
// the row the hub holds rather than the row the push built.

const crypto            = require('crypto');
const sinon             = require('sinon');
const { expect }        = require('chai');
const PriceAggregator   = require('../../../../../src/oracle/price_aggregator');
const { createMockHub } = require('../../../../helpers/mockHub');

function makeValidator() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        pubkey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
        sign: (payload) => crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex')
    };
}

const V = [makeValidator(), makeValidator(), makeValidator(), makeValidator()];
const ROUND = 5;
const BTC_HEIGHT = 799000;
const PAIRS = [{ pair: 'BTC/USD', price: '50000' }, { pair: 'LTC/USD', price: '80' }];
const PRODUCER_BLOCK = 798990;
const PRODUCER_PROOF = '["producer-sig"]';

function signedRound() {
    const payload = JSON.stringify({ round: ROUND, timestamp: 1700000000, btc_block_height: BTC_HEIGHT,
        pairs: PAIRS.map(p => ({ pair: p.pair, price: p.price })) });
    return {
        round: ROUND, timestamp: 1700000000, btc_block_height: BTC_HEIGHT, block_index: 800000,
        action_index: 42, pairs: PAIRS, sigs: V.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: v.sign(payload) }))
    };
}

const heldRows = () => [
    { id: 1, round_number: ROUND, coin_pair: 'BTC/USD', price: '49990', status: 'finalized',
        reference_block: PRODUCER_BLOCK, reference_chain: 'BTC', source_chain: null,
        source_action_index: null, push_generation: 0, consensus_proof: PRODUCER_PROOF },
    { id: 2, round_number: ROUND, coin_pair: 'LTC/USD', price: '80', status: 'finalized',
        reference_block: 800000, reference_chain: 'BTC', source_chain: 'BTC',
        source_action_index: 42, push_generation: 0, consensus_proof: '["pushed"]' }
];

describe('PriceAggregator pushed round broadcasts the rows it holds', function () {
    let hub, agg, inserts, emitted, reread;

    beforeEach(function () {
        hub = createMockHub({ network: 'mainnet' });
        agg = new PriceAggregator(hub);
        hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves({
            capability: 'price', blockIndex: 800000, count: V.length,
            validators: V.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' }))
        }) };
        inserts = [];
        emitted = [];
        reread = async () => heldRows();
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^INSERT INTO price_snapshots/.test(sql)) { inserts.push(params); return {}; }
            if (/^SELECT \* FROM price_snapshots WHERE round_number=\?/.test(sql)) return reread();
            return [];
        });
        agg.on('row:inserted', event => emitted.push(event.row));
    });

    afterEach(function () { sinon.restore(); });

    it('emits the held producer row when consensus finalized the round after the duplicate read', async function () {
        const result = await agg.receiveValidatedRound('BTC', signedRound());
        expect(result).to.deep.equal({ accepted: true });
        expect(inserts).to.have.length(1);
        const own = emitted.find(row => row.coin_pair === 'BTC/USD');
        expect(own.reference_block).to.equal(PRODUCER_BLOCK);
        expect(own.consensus_proof).to.equal(PRODUCER_PROOF);
        expect(own.price).to.equal('49990');
        expect(emitted.map(row => row.coin_pair)).to.deep.equal(['BTC/USD', 'LTC/USD']);
    });

    it('keeps a stored round accepted and emits the built rows when the re-read fails', async function () {
        reread = async () => { throw new Error('read lost'); };
        const result = await agg.receiveValidatedRound('BTC', signedRound());
        expect(result).to.deep.equal({ accepted: true });
        expect(emitted.map(row => row.coin_pair)).to.deep.equal(['BTC/USD', 'LTC/USD']);
        expect(emitted.every(row => row.source_action_index === 42)).to.equal(true);
    });
});
