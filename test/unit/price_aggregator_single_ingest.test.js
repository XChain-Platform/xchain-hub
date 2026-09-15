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

const crypto           = require('crypto');
const sinon            = require('sinon');
const { expect }       = require('chai');
const PriceAggregator  = require('../../src/oracle/price_aggregator');
const { createMockHub } = require('../helpers/mockHub');

// Mirror of the canonical PRICE v0 payload (xchain-indexer/src/consensus/ed25519.js)
// buildPriceV0Payload. Tests sign these exact bytes. The mockHub has no `network`,
// so the EQUIV header is OFF (unknown network) and this is the bare-JSON branch;
// btc_block_height still rides in the signed content (#4232).
function buildPriceV0Payload(round, timestamp, pairs, btcBlockHeight) {
    let sortedPairs = pairs
        .map(p => ({ pair: p.pair, price: String(p.price) }))
        .sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0));
    return JSON.stringify({
        round:            parseInt(round),
        timestamp:        parseInt(timestamp),
        btc_block_height: parseInt(btcBlockHeight),
        pairs:            sortedPairs
    });
}

// Generate a real Ed25519 validator keypair: { pubkey (64-hex), sign(payload) → 128-hex }
function makeValidator() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let pubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    return {
        pubkey,
        sign: (payload) => crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex')
    };
}



    let hub, agg;


    const VALID = {
        source_address: 'addr1', coin: 'BTC', tick: 'GOLD', fiat: 'USD',
        value: '1.23', block_time: 1700000000, action_index: 7
    };

function registerPriceaggregatorReceiveoraclepriceValidationPersistence1Hooks() {

    beforeEach(function () {
        hub = createMockHub();
        agg = new PriceAggregator(hub);
    });

    afterEach(function () {
        sinon.restore();
    });
}

function registerPriceaggregatorReceiveoraclepriceValidationPersistence1Tests1() {

    ['source_address', 'coin', 'tick', 'fiat', 'value'].forEach(function (field) {
        it('rejects priceData missing ' + field + ' without touching the DB', async function () {
            let bad = { ...VALID };
            delete bad[field];
            let result = await agg.receiveOraclePrice('BTC', bad);
            expect(result).to.deep.equal({ accepted: false, reason: 'invalid priceData' });
            expect(hub.db.doQuery.called).to.equal(false);
        });
    });

    it('rejects a null priceData', async function () {
        let result = await agg.receiveOraclePrice('BTC', null);
        expect(result).to.deep.equal({ accepted: false, reason: 'invalid priceData' });
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('rejects a duplicate (source_address + source_chain + action_index already present)', async function () {
        // First doQuery is the dedup check: return an existing row.
        hub.db.doQuery.onFirstCall().resolves([{ id: 1 }]);
        let result = await agg.receiveOraclePrice('BTC', VALID);
        expect(result).to.deep.equal({ accepted: false, reason: 'duplicate' });
        // Dedup SELECT only; no lock-window check, no INSERT.
        expect(hub.db.doQuery.callCount).to.equal(1);
    });

    it('returns a db error and does not emit when the INSERT throws', async function () {
        let events = [];
        agg.on('row:inserted', e => events.push(e));
        hub.db.doQuery.callsFake(async (sql) => {
            if (/^INSERT INTO oracle_prices/.test(sql)) throw new Error('boom');
            return []; // both SELECTs miss
        });
        let result = await agg.receiveOraclePrice('BTC', VALID);
        expect(result).to.deep.equal({ accepted: false, reason: 'db error' });
        expect(events).to.deep.equal([]);
    });
}

function registerPriceaggregatorReceiveoraclepriceValidationPersistence1Tests5() {

    it('accepts a fresh price, persists every column, and emits row:inserted', async function () {
        let insertArgs = null;
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^INSERT INTO oracle_prices/.test(sql)) { insertArgs = params; return {}; }
            return []; // dedup + lock-window both miss
        });
        let events = [];
        agg.on('row:inserted', e => events.push(e));

        let result = await agg.receiveOraclePrice('BTC', {
            source_address: 'addr1', coin: 'BTC', tick: 'GOLD', fiat: 'USD',
            value: '1.23', fee: '0.01', memo: 'hi', block_time: 1700000000, action_index: 7,
            push_generation: 4
        });

        expect(result).to.deep.equal({ accepted: true });
        // Uniform 24h delay applies to every publish, first included. push_generation (item 5308)
        // is the 12th column, stamped from the push payload. admit_block is the 13th and is NULL
        // here because this mock hub has no resolveAdmissionTip: an unresolvable tip leaves the
        // column unstamped rather than stamping height 0.
        expect(insertArgs).to.deep.equal([
            'addr1', 'BTC', 'BTC', 'GOLD', 'USD', '1.23', '0.01', 'hi',
            1700000000, 1700086400, 7, 4, null
        ]);
        expect(events).to.have.length(1);
        expect(events[0].table).to.equal('oracle_prices');
        expect(events[0].row).to.include({
            source_address: 'addr1', source_chain: 'BTC', coin: 'BTC',
            tick: 'GOLD', fiat: 'USD', value: '1.23', fee: '0.01', memo: 'hi',
            block_time: 1700000000, effective_at: 1700086400, action_index: 7, push_generation: 4
        });
    });

    it('defaults push_generation to 0 when the push omits it (legacy indexer)', async function () {
        let insertArgs = null;
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^INSERT INTO oracle_prices/.test(sql)) { insertArgs = params; return {}; }
            return [];
        });
        await agg.receiveOraclePrice('BTC', {
            source_address: 'addr1', coin: 'BTC', tick: 'GOLD', fiat: 'USD',
            value: '1.23', block_time: 1700000000, action_index: 7
        });
        expect(insertArgs[11]).to.equal(0);     // push_generation defaults to 0
    });

    it('HUB-RETRACT-4: rejects a stale replay (generation <= watermark AND action_index in the orphaned range)', async function () {
        let warn = sinon.stub(console, 'warn');
        hub.db.getPriceIngestWatermark.resolves({ retraction_generation: 5, from_action_index: 100 });
        let result = await agg.receiveOraclePrice('BTC', { ...VALID, action_index: 120, push_generation: 5 });
        expect(result).to.deep.equal({ accepted: false, reason: 'stale (retracted generation)' });
        // Rejected before any dedupe SELECT / INSERT touches oracle_prices.
        expect(hub.db.doQuery.called).to.equal(false);
        expect(warn.calledOnce).to.equal(true);   // never a silent drop
    });
}

function registerPriceaggregatorReceiveoraclepriceValidationPersistence1Tests8() {

    it('HUB-RETRACT-4: does NOT false-reject a legitimate late push BELOW the orphaned range', async function () {
        hub.db.getPriceIngestWatermark.resolves({ retraction_generation: 5, from_action_index: 100 });
        hub.db.doQuery.callsFake(async (sql) => (/^INSERT INTO oracle_prices/.test(sql) ? {} : []));
        // action_index 50 < from 100: it survived the reorg and must ingest even at the old generation.
        let result = await agg.receiveOraclePrice('BTC', { ...VALID, action_index: 50, push_generation: 5 });
        expect(result).to.deep.equal({ accepted: true });
    });

    it('HUB-RETRACT-4: accepts the canonical re-publication at a higher generation (monotonic upsert)', async function () {
        hub.db.getPriceIngestWatermark.resolves({ retraction_generation: 5, from_action_index: 100 });
        let insertArgs = null;
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^INSERT INTO oracle_prices/.test(sql)) { insertArgs = params; return {}; }
            return []; // dedupe misses
        });
        let result = await agg.receiveOraclePrice('BTC', { ...VALID, action_index: 120, push_generation: 6 });
        expect(result).to.deep.equal({ accepted: true });
        expect(insertArgs[11]).to.equal(6);
        let insertCall = hub.db.doQuery.getCalls().find(c => /^INSERT INTO oracle_prices/.test(c.args[0]));
        expect(insertCall.args[0]).to.match(/ON DUPLICATE KEY UPDATE/);
        expect(insertCall.args[0]).to.match(/push_generation = GREATEST\(push_generation, VALUES\(push_generation\)\)/);
    });

    it('HUB-RETRACT-4: a strictly newer generation supersedes a stale existing row (not a duplicate)', async function () {
        let insertArgs = null;
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^SELECT id, push_generation FROM oracle_prices/.test(sql)) return [{ id: 1, push_generation: 3 }];
            if (/^INSERT INTO oracle_prices/.test(sql)) { insertArgs = params; return {}; }
            return [];
        });
        let result = await agg.receiveOraclePrice('BTC', { ...VALID, action_index: 7, push_generation: 6 });
        expect(result).to.deep.equal({ accepted: true });
        expect(insertArgs[11]).to.equal(6);
    });

    it('HUB-RETRACT-4: an equal-or-older generation at the same key is still a duplicate', async function () {
        hub.db.doQuery.callsFake(async (sql) => {
            if (/^SELECT id, push_generation FROM oracle_prices/.test(sql)) return [{ id: 1, push_generation: 6 }];
            return [];
        });
        let result = await agg.receiveOraclePrice('BTC', { ...VALID, action_index: 7, push_generation: 6 });
        expect(result).to.deep.equal({ accepted: false, reason: 'duplicate' });
    });

    it('rejects a malformed or non-positive value without touching the DB', async function () {
        for (let value of ['abc', '-1', '0', '1.123456789', '1e5']) {
            let result = await agg.receiveOraclePrice('BTC', { ...VALID, value });
            expect(result, 'value=' + value).to.deep.equal({ accepted: false, reason: 'invalid value' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });
}

function registerPriceaggregatorReceiveoraclepriceValidationPersistence1Tests13() {

    it('rejects a malformed or out-of-range fee without touching the DB', async function () {
        // '1.0000000000000000001' rounds to 1.0 under parseFloat and slipped past the
        // old `> 1` gate; exact bcmath now rejects it (parity with the indexer).
        for (let fee of ['abc', '1.5', '-0.1', '1.0000000000000000001']) {
            let result = await agg.receiveOraclePrice('BTC', { ...VALID, fee });
            expect(result, 'fee=' + fee).to.deep.equal({ accepted: false, reason: 'invalid fee' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });

    // action_index / block_time were the two required wire fields outside every gate:
    // `parseInt(x) || 0` minted a default, collapsing malformed pushes onto the single
    // (source_chain, 0) row and onto effective_at 86400 (the 24h delay silently off).
    it('rejects a missing or malformed action_index without touching the DB', async function () {
        for (let action_index of [undefined, null, '', 'abc', '7abc', -1, '-1', 7.5, '1e3',
                                  { i: 1 }, '9007199254740993']) {
            let bad = { ...VALID, action_index };
            if (action_index === undefined) delete bad.action_index;
            let result = await agg.receiveOraclePrice('BTC', bad);
            expect(result, 'action_index=' + JSON.stringify(action_index))
                .to.deep.equal({ accepted: false, reason: 'invalid action_index' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('still accepts a genuine action_index of 0', async function () {
        hub.db.doQuery.callsFake(async (sql) => (/^INSERT/.test(sql) ? {} : []));
        let result = await agg.receiveOraclePrice('BTC', { ...VALID, action_index: 0 });
        expect(result).to.deep.equal({ accepted: true });
    });

    it('rejects a missing or malformed block_time without touching the DB', async function () {
        for (let block_time of [undefined, null, '', 'abc', 0, '0', -1, '-1', 1.5,
                                '1e9', { t: 1 }, '9007199254740993']) {
            let bad = { ...VALID, block_time };
            if (block_time === undefined) delete bad.block_time;
            let result = await agg.receiveOraclePrice('BTC', bad);
            expect(result, 'block_time=' + JSON.stringify(block_time))
                .to.deep.equal({ accepted: false, reason: 'invalid block_time' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('keeps an old but well-formed block_time acceptable (indexer backfill replays history)', async function () {
        let insertArgs = null;
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^INSERT INTO oracle_prices/.test(sql)) { insertArgs = params; return {}; }
            return [];
        });
        let result = await agg.receiveOraclePrice('BTC', { ...VALID, block_time: 1231006505 });
        expect(result).to.deep.equal({ accepted: true });
        expect(insertArgs[9]).to.equal(1231006505 + 86400);
    });
}

function registerPriceaggregatorReceiveoraclepriceValidationPersistence1Tests18() {

    it('emits the validated integer action_index, not the raw wire value', async function () {
        hub.db.doQuery.callsFake(async (sql) => (/^INSERT/.test(sql) ? {} : []));
        let events = [];
        agg.on('row:inserted', e => events.push(e));
        let result = await agg.receiveOraclePrice('BTC', { ...VALID, action_index: '42' });
        expect(result).to.deep.equal({ accepted: true });
        expect(events[0].row.action_index).to.equal(42);
    });

    // coin/tick/fiat/memo bounds mirroring the indexer's PRICE v1
    // wire-format rules (actions/price.js parse_v1).
    it('rejects an unsupported or non-string coin without touching the DB', async function () {
        for (let coin of ['XCP', 'btc', 'ETH', 42, { x: 1 }, 'B'.repeat(300)]) {
            let result = await agg.receiveOraclePrice('BTC', { ...VALID, coin });
            expect(result, 'coin=' + JSON.stringify(coin)).to.deep.equal({ accepted: false, reason: 'invalid coin' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('rejects an over-length or non-string tick without touching the DB', async function () {
        for (let tick of ['T'.repeat(251), 42, ['GOLD']]) {
            let result = await agg.receiveOraclePrice('BTC', { ...VALID, tick });
            expect(result, 'tick=' + JSON.stringify(tick)).to.deep.equal({ accepted: false, reason: 'invalid tick' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('accepts a tick at exactly the 250-char boundary', async function () {
        hub.db.doQuery.callsFake(async (sql) => (/^INSERT/.test(sql) ? {} : []));
        let result = await agg.receiveOraclePrice('BTC', { ...VALID, tick: 'T'.repeat(250) });
        expect(result).to.deep.equal({ accepted: true });
    });

    it('rejects an unsupported or non-string fiat without touching the DB', async function () {
        for (let fiat of ['usd', 'XYZ', 7, 'U'.repeat(300)]) {
            let result = await agg.receiveOraclePrice('BTC', { ...VALID, fiat });
            expect(result, 'fiat=' + JSON.stringify(fiat)).to.deep.equal({ accepted: false, reason: 'invalid fiat' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('rejects an over-length or non-string memo without touching the DB', async function () {
        for (let memo of ['M'.repeat(251), 42, { note: 'x' }]) {
            let result = await agg.receiveOraclePrice('BTC', { ...VALID, memo });
            expect(result, 'memo=' + JSON.stringify(memo)).to.deep.equal({ accepted: false, reason: 'invalid memo' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });
}

function registerPriceaggregatorReceiveoraclepriceValidationPersistence1Tests24() {

    it('accepts a memo at exactly the 250-char boundary (and null/omitted memo)', async function () {
        hub.db.doQuery.callsFake(async (sql) => (/^INSERT/.test(sql) ? {} : []));
        let result = await agg.receiveOraclePrice('BTC', { ...VALID, memo: 'M'.repeat(250) });
        expect(result).to.deep.equal({ accepted: true });
        result = await agg.receiveOraclePrice('BTC', { ...VALID, memo: null, action_index: 8 });
        expect(result).to.deep.equal({ accepted: true });
    });

    it('accepts every supported coin and fiat', async function () {
        hub.db.doQuery.callsFake(async (sql) => (/^INSERT/.test(sql) ? {} : []));
        let i = 100;
        for (let coin of ['BTC', 'LTC', 'DOGE']) {
            let result = await agg.receiveOraclePrice('BTC', { ...VALID, coin, action_index: i++ });
            expect(result, 'coin=' + coin).to.deep.equal({ accepted: true });
        }
        for (let fiat of ['USD', 'CAD', 'AUD', 'MXN', 'GBP', 'JPY', 'CNY', 'CHF', 'BRL', 'INR', 'EUR', 'KRW']) {
            let result = await agg.receiveOraclePrice('BTC', { ...VALID, fiat, action_index: i++ });
            expect(result, 'fiat=' + fiat).to.deep.equal({ accepted: true });
        }
    });

    // fee/memo/source_chain still default; action_index and block_time no longer do.
    // This case once asserted the defaulting of all five, i.e. it pinned the
    // very coercion that made a malformed push land on row 0, immediately effective.
    it('defaults fee/memo to null and source_chain to "" when omitted', async function () {
        let insertArgs = null;
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^INSERT INTO oracle_prices/.test(sql)) { insertArgs = params; return {}; }
            return [];
        });
        await agg.receiveOraclePrice(null, {
            source_address: 'addr1', coin: 'BTC', tick: 'GOLD', fiat: 'USD', value: '1.23',
            block_time: 1700000000, action_index: 7
        });
        // [addr, chain, coin, tick, fiat, value, fee, memo, block_time, effective_at, action_index]
        expect(insertArgs[1]).to.equal('');     // source_chain
        expect(insertArgs[6]).to.equal(null);   // fee
        expect(insertArgs[7]).to.equal(null);   // memo
    });

    it('no longer defaults an omitted action_index or block_time to 0', async function () {
        let result = await agg.receiveOraclePrice(null, {
            source_address: 'addr1', coin: 'BTC', tick: 'GOLD', fiat: 'USD', value: '1.23'
        });
        expect(result).to.deep.equal({ accepted: false, reason: 'invalid action_index' });
        expect(hub.db.doQuery.called).to.equal(false);
    });

}

describe('PriceAggregator.receiveOraclePrice() validation + persistence', function () {
    registerPriceaggregatorReceiveoraclepriceValidationPersistence1Hooks();
    registerPriceaggregatorReceiveoraclepriceValidationPersistence1Tests1();
    registerPriceaggregatorReceiveoraclepriceValidationPersistence1Tests5();
    registerPriceaggregatorReceiveoraclepriceValidationPersistence1Tests8();
    registerPriceaggregatorReceiveoraclepriceValidationPersistence1Tests13();
    registerPriceaggregatorReceiveoraclepriceValidationPersistence1Tests18();
    registerPriceaggregatorReceiveoraclepriceValidationPersistence1Tests24();
});
