'use strict';

// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const crypto = require('crypto');
const sinon = require('sinon');
const { expect } = require('chai');
const PriceAggregator = require('../../../../../../src/oracle/price_aggregator.js');
const roundIngest = require('../../../../../../src/oracle/price_aggregator/round_ingest.js');
const { createMockHub } = require('../../../../../helpers/mockHub.js');
const { answerRoundRereadFromInserts } = require('../../../../../helpers/prices/inserted_round_rows.js');

function validator() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        pubkey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
        sign: payload => crypto.sign(null, Buffer.from(payload), privateKey).toString('hex')
    };
}

const validators = [validator(), validator(), validator(), validator()];
const pairs = [{ pair: 'BTC/USD', price: '50000' }, { pair: 'LTC/USD', price: '80' }];

function signedRound(agg, overrides) {
    const base = {
        round: 5, timestamp: 1700000000, btc_block_height: 799000,
        block_index: 800000, action_index: 42, pairs
    };
    const payload = agg.buildPriceV0Payload(base.round, base.timestamp, base.pairs, base.btc_block_height);
    return Object.assign(base, {
        sigs: validators.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: v.sign(payload) }))
    }, overrides);
}

function setup(heldRows) {
    const hub = createMockHub({ network: 'mainnet' });
    const agg = new PriceAggregator(hub);
    const inserts = [];
    const insertSql = [];
    hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves({
        count: validators.length,
        validators: validators.map(v => ({ pubkey: v.pubkey, amount: '1' }))
    }) };
    answerRoundRereadFromInserts(hub.db);
    hub.db.doQuery.callsFake(async (sql, params) => {
        if (/^SELECT coin_pair, status FROM price_snapshots/.test(sql)) return heldRows;
        if (/^INSERT INTO price_snapshots/.test(sql)) { inserts.push(params); insertSql.push(sql); return {}; }
        return [];
    });
    return { hub, agg, inserts, insertSql };
}

function registerPartialRoundFillTests() {
    it('verifies the complete round and writes only its missing pair', async function () {
        const { agg, inserts } = setup([{ coin_pair: 'BTC/USD', status: 'finalized' }]);
        const result = await agg.receiveValidatedRound('BTC', signedRound(agg));
        expect(result).to.deep.equal({ accepted: true });
        expect(inserts).to.have.length(1);
        expect(inserts[0][1]).to.equal('LTC/USD');
        expect(inserts[0]).not.to.include('BTC/USD');
    });

    it('replaces a skipped placeholder beside a finalized held pair', async function () {
        const held = [
            { coin_pair: 'BTC/USD', status: 'finalized' },
            { coin_pair: 'LTC/USD', status: 'skipped' }
        ];
        const visible = held.filter(row => row.status !== 'skipped');
        const { agg, inserts } = setup(visible);
        const result = await agg.receiveValidatedRound('BTC', signedRound(agg));
        expect(result).to.deep.equal({ accepted: true });
        expect(inserts).to.have.length(1);
        expect(inserts[0][1]).to.equal('LTC/USD');
        expect(inserts[0]).not.to.include('BTC/USD');
    });

    it('does not rewrite a disputed held pair while filling another pair', async function () {
        const { agg, inserts } = setup([{ coin_pair: 'BTC/USD', status: 'disputed' }]);
        const result = await agg.receiveValidatedRound('BTC', signedRound(agg));
        expect(result).to.deep.equal({ accepted: true });
        expect(inserts).to.have.length(1);
        expect(inserts[0][1]).to.equal('LTC/USD');
    });
}

function registerPartialRoundGuardTests() {
    it('guards a pair another writer can fill after the presence read', async function () {
        const { agg, insertSql } = setup([{ coin_pair: 'BTC/USD', status: 'finalized' }]);
        const result = await agg.receiveValidatedRound('BTC', signedRound(agg));
        expect(result).to.deep.equal({ accepted: true });
        expect(insertSql).to.have.length(1);
        expect(insertSql[0]).to.match(
            /price\s*=\s*IF\(status\s*=\s*'skipped',\s*VALUES\(price\),\s*price\)/);
        expect(insertSql[0]).to.match(
            /status\s*=\s*IF\(status\s*=\s*'skipped',\s*'finalized',\s*status\)/);
    });

    it('rejects an unverified partial-round fill without writing', async function () {
        const { agg, hub, inserts } = setup([{ coin_pair: 'BTC/USD', status: 'finalized' }]);
        const forged = signedRound(agg, {
            sigs: validators.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: 'ab'.repeat(64) }))
        });
        const result = await agg.receiveValidatedRound('BTC', forged);
        expect(result).to.deep.equal({ accepted: false, reason: 'insufficient quorum (0/3)' });
        expect(inserts).to.deep.equal([]);
        expect(hub.db.doQuery.getCalls().some(call => /^INSERT/.test(call.args[0]))).to.equal(false);
    });

    it('does not perform a presence read when duplicate checking is disabled', async function () {
        const { agg, hub } = setup([]);
        hub.db.doQuery.resetHistory();
        const result = await roundIngest.verifyValidatedRound.call(agg, 'BTC', signedRound(agg), false);
        expect(result.accepted).to.equal(true);
        expect(hub.db.doQuery.called).to.equal(false);
    });
}

describe('PriceAggregator partial pushed-round repair', function () {
    afterEach(function () { sinon.restore(); });
    registerPartialRoundFillTests();
    registerPartialRoundGuardTests();
});
