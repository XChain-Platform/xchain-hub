'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const sinon            = require('sinon');
const { expect }       = require('chai');
const PriceAggregator  = require('../../src/PriceAggregator');
const { createMockHub } = require('../helpers/mockHub');

describe('PriceAggregator.retractFromActionIndex()', function () {

    let hub, agg;

    beforeEach(function () {
        hub = createMockHub();
        agg = new PriceAggregator(hub);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('deletes price_snapshots and oracle_prices for the source chain at/above the action_index', async function () {
        hub.db.doQuery.resolves({ affectedRows: 2 });

        let result = await agg.retractFromActionIndex('BTC', 500);

        // Two DELETE statements issued
        let calls = hub.db.doQuery.getCalls();
        expect(calls.length).to.equal(2);

        let snapCall = calls.find(c => /price_snapshots/.test(c.args[0]));
        let oracleCall = calls.find(c => /oracle_prices/.test(c.args[0]));
        expect(snapCall, 'price_snapshots delete issued').to.exist;
        expect(oracleCall, 'oracle_prices delete issued').to.exist;

        // price_snapshots keys on source_action_index, oracle_prices on action_index
        expect(snapCall.args[0]).to.match(/DELETE FROM price_snapshots WHERE source_chain = \? AND source_action_index >= \?/);
        expect(snapCall.args[1]).to.deep.equal(['BTC', 500]);
        expect(oracleCall.args[0]).to.match(/DELETE FROM oracle_prices WHERE source_chain = \? AND action_index >= \?/);
        expect(oracleCall.args[1]).to.deep.equal(['BTC', 500]);

        expect(result).to.deep.equal({ retracted: { price_snapshots: 2, oracle_prices: 2 } });
    });

    it('emits row:deleted events so distributed indexers prune their local copies', async function () {
        hub.db.doQuery.resolves({ affectedRows: 1 });
        let events = [];
        agg.on('row:deleted', e => events.push(e));

        await agg.retractFromActionIndex('LTC', 10);

        expect(events).to.deep.equal([
            { table: 'price_snapshots', source_chain: 'LTC', from_action_index: 10 },
            { table: 'oracle_prices',   source_chain: 'LTC', from_action_index: 10 }
        ]);
    });

    it('does not emit deletion events for tables where nothing was removed', async function () {
        hub.db.doQuery.resolves({ affectedRows: 0 });
        let events = [];
        agg.on('row:deleted', e => events.push(e));

        await agg.retractFromActionIndex('DOGE', 1);

        expect(events).to.deep.equal([]);
    });

    it('rejects a malformed from_action_index without touching the DB', async function () {
        let result = await agg.retractFromActionIndex('BTC', 'not-a-number');
        expect(result).to.have.property('error');
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('treats a DELETE result with no affectedRows as zero deletions (and emits nothing)', async function () {
        // Some drivers return an array (not a result object) — guard against undefined.
        hub.db.doQuery.resolves([]);
        let events = [];
        agg.on('row:deleted', e => events.push(e));

        let result = await agg.retractFromActionIndex('BTC', 0);

        expect(result).to.deep.equal({ retracted: { price_snapshots: 0, oracle_prices: 0 } });
        expect(events).to.deep.equal([]);
    });
});

describe('PriceAggregator.receiveOraclePrice() effective_at lock-window', function () {

    let hub, agg;

    // Build a doQuery stub that models an oracle_prices table holding the given
    // pre-existing rows. The dedup and lock-window SELECTs are answered from that
    // set; the INSERT is captured so tests can assert the persisted effective_at.
    function stubDb(existingRows) {
        let insertArgs = null;
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^INSERT INTO oracle_prices/.test(sql)) {
                insertArgs = params;
                return {};
            }
            // Lock-window prior check (scoped to source_chain + coin/tick/fiat)
            if (/SELECT id FROM oracle_prices WHERE source_address = \? AND source_chain = \? AND coin = \?/.test(sql)) {
                let [addr, chain, coin, tick, fiat] = params;
                let hit = existingRows.some(r =>
                    r.source_address === addr && r.source_chain === chain &&
                    r.coin === coin && r.tick === tick && r.fiat === fiat);
                return hit ? [{ id: 1 }] : [];
            }
            // Dedup check (source_address + source_chain + action_index)
            if (/SELECT id FROM oracle_prices WHERE source_address = \? AND source_chain = \? AND action_index/.test(sql)) {
                return [];
            }
            return [];
        });
        return () => insertArgs;
    }

    // INSERT column order: source_address, source_chain, coin, tick, fiat, value,
    // fee, memo, block_time, effective_at, action_index
    const EFFECTIVE_AT = 9;

    beforeEach(function () {
        hub = createMockHub();
        agg = new PriceAggregator(hub);
    });

    afterEach(function () {
        sinon.restore();
    });

    it('treats the first submission on a NEW chain as immediate even when the oracle exists on another chain', async function () {
        // Oracle already published BTC for this coin/tick/fiat; LTC has never been seen.
        let getInsert = stubDb([
            { source_address: 'addr1', source_chain: 'BTC', coin: 'XCP', tick: 'GOLD', fiat: 'USD' }
        ]);

        let result = await agg.receiveOraclePrice('LTC', {
            source_address: 'addr1', coin: 'XCP', tick: 'GOLD', fiat: 'USD',
            value: '1.23', block_time: 1700000000, action_index: 7
        });

        expect(result).to.deep.equal({ accepted: true });
        // No prior LTC row → effective immediately, NOT delayed by 24h.
        expect(getInsert()[EFFECTIVE_AT]).to.equal(1700000000);
    });

    it('still delays a genuine same-chain update by 24h', async function () {
        // Oracle already published LTC for this coin/tick/fiat; this is an update on LTC.
        let getInsert = stubDb([
            { source_address: 'addr1', source_chain: 'LTC', coin: 'XCP', tick: 'GOLD', fiat: 'USD' }
        ]);

        let result = await agg.receiveOraclePrice('LTC', {
            source_address: 'addr1', coin: 'XCP', tick: 'GOLD', fiat: 'USD',
            value: '1.50', block_time: 1700000000, action_index: 8
        });

        expect(result).to.deep.equal({ accepted: true });
        // Prior LTC row exists → 24h front-running delay applies.
        expect(getInsert()[EFFECTIVE_AT]).to.equal(1700000000 + 86400);
    });

    it('scopes the lock-window SELECT to source_chain', async function () {
        stubDb([]);

        await agg.receiveOraclePrice('LTC', {
            source_address: 'addr1', coin: 'XCP', tick: 'GOLD', fiat: 'USD',
            value: '1.00', block_time: 1700000000, action_index: 1
        });

        let priorCall = hub.db.doQuery.getCalls().find(c =>
            /SELECT id FROM oracle_prices WHERE source_address = \? AND source_chain = \? AND coin = \?/.test(c.args[0]));
        expect(priorCall, 'lock-window prior check includes source_chain').to.exist;
        expect(priorCall.args[1]).to.deep.equal(['addr1', 'LTC', 'XCP', 'GOLD', 'USD']);
    });
});

describe('PriceAggregator.receiveOraclePrice() validation + persistence', function () {

    let hub, agg;

    beforeEach(function () {
        hub = createMockHub();
        agg = new PriceAggregator(hub);
    });

    afterEach(function () {
        sinon.restore();
    });

    const VALID = {
        source_address: 'addr1', coin: 'XCP', tick: 'GOLD', fiat: 'USD',
        value: '1.23', block_time: 1700000000, action_index: 7
    };

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
        // First doQuery is the dedup check — return an existing row.
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

    it('accepts a fresh price, persists every column, and emits row:inserted', async function () {
        let insertArgs = null;
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^INSERT INTO oracle_prices/.test(sql)) { insertArgs = params; return {}; }
            return []; // dedup + lock-window both miss
        });
        let events = [];
        agg.on('row:inserted', e => events.push(e));

        let result = await agg.receiveOraclePrice('BTC', {
            source_address: 'addr1', coin: 'XCP', tick: 'GOLD', fiat: 'USD',
            value: '1.23', fee: '0.01', memo: 'hi', block_time: 1700000000, action_index: 7
        });

        expect(result).to.deep.equal({ accepted: true });
        // First-ever submission → effective immediately.
        expect(insertArgs).to.deep.equal([
            'addr1', 'BTC', 'XCP', 'GOLD', 'USD', '1.23', '0.01', 'hi',
            1700000000, 1700000000, 7
        ]);
        expect(events).to.have.length(1);
        expect(events[0].table).to.equal('oracle_prices');
        expect(events[0].row).to.include({
            source_address: 'addr1', source_chain: 'BTC', coin: 'XCP',
            tick: 'GOLD', fiat: 'USD', value: '1.23', fee: '0.01', memo: 'hi',
            block_time: 1700000000, effective_at: 1700000000, action_index: 7
        });
    });

    it('defaults fee/memo to null, action_index to 0, and source_chain to "" when omitted', async function () {
        let insertArgs = null;
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^INSERT INTO oracle_prices/.test(sql)) { insertArgs = params; return {}; }
            return [];
        });
        await agg.receiveOraclePrice(null, {
            source_address: 'addr1', coin: 'XCP', tick: 'GOLD', fiat: 'USD', value: '1.23'
        });
        // [addr, chain, coin, tick, fiat, value, fee, memo, block_time, effective_at, action_index]
        expect(insertArgs[1]).to.equal('');     // source_chain
        expect(insertArgs[6]).to.equal(null);   // fee
        expect(insertArgs[7]).to.equal(null);   // memo
        expect(insertArgs[8]).to.equal(0);      // block_time (parseInt(undefined)||0)
        expect(insertArgs[10]).to.equal(0);     // action_index
    });
});

describe('PriceAggregator.receiveValidatedRound()', function () {

    let hub, agg;

    beforeEach(function () {
        hub = createMockHub();
        agg = new PriceAggregator(hub);
    });

    afterEach(function () {
        sinon.restore();
    });

    const ROUND = {
        round: 5,
        timestamp: 1700000000,
        block_index: 800000,
        action_index: 42,
        sigs: ['sigA', 'sigB'],
        pairs: [{ pair: 'BTC/USD', price: '50000' }, { pair: 'LTC/USD', price: '80' }]
    };

    it('rejects roundData that is null / missing round / has non-array pairs', async function () {
        for (let bad of [null, { pairs: [] }, { round: 5 }, { round: 5, pairs: 'x' }]) {
            let result = await agg.receiveValidatedRound('BTC', bad);
            expect(result).to.deep.equal({ accepted: false, reason: 'invalid roundData' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('rejects a non-finite or negative round number', async function () {
        let r1 = await agg.receiveValidatedRound('BTC', { round: -1, pairs: [{ pair: 'X', price: '1' }] });
        expect(r1).to.deep.equal({ accepted: false, reason: 'invalid round' });
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('rejects a duplicate round (a snapshot row already exists)', async function () {
        hub.db.doQuery.onFirstCall().resolves([{ id: 1 }]);
        let result = await agg.receiveValidatedRound('BTC', ROUND);
        expect(result).to.deep.equal({ accepted: false, reason: 'duplicate' });
        expect(hub.db.doQuery.callCount).to.equal(1); // dedup SELECT only
    });

    it('inserts one row per valid pair, skips malformed pairs, and emits row:inserted for each', async function () {
        let inserts = [];
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^SELECT id FROM price_snapshots/.test(sql)) return [];   // no dup
            if (/^INSERT INTO price_snapshots/.test(sql)) { inserts.push(params); return {}; }
            return [];
        });
        let events = [];
        agg.on('row:inserted', e => events.push(e));

        let result = await agg.receiveValidatedRound('BTC', {
            ...ROUND,
            pairs: [
                { pair: 'BTC/USD', price: '50000' },
                null,                       // skipped
                { pair: 'NOPRICE' },        // skipped (no price)
                { price: '1' },             // skipped (no pair)
                { pair: 'LTC/USD', price: '80' }
            ]
        });

        expect(result).to.deep.equal({ accepted: true });
        expect(inserts).to.have.length(2); // only the two well-formed pairs
        // Each insert carries the shared round metadata.
        expect(inserts[0][0]).to.equal(5);             // round_number
        expect(inserts[0][1]).to.equal('BTC/USD');     // coin_pair
        expect(inserts[0][2]).to.equal('50000');       // price
        expect(inserts[0][3]).to.equal(800000);        // reference_block
        expect(inserts[0][4]).to.equal('BTC');         // reference_chain
        expect(inserts[0][5]).to.equal(1700000000);    // block_timestamp
        expect(inserts[0][6]).to.equal(2);             // validator_count (2 sigs)
        // emitted one row event per inserted row
        expect(events).to.have.length(2);
        expect(events.every(e => e.table === 'price_snapshots')).to.equal(true);
        expect(events.map(e => e.row.coin_pair)).to.deep.equal(['BTC/USD', 'LTC/USD']);
    });

    it('defaults sigs→[], validator_count→0, reference_block→round, action_index→null when absent', async function () {
        let insertArgs = null;
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^SELECT id FROM price_snapshots/.test(sql)) return [];
            if (/^INSERT INTO price_snapshots/.test(sql)) { insertArgs = params; return {}; }
            return [];
        });
        await agg.receiveValidatedRound(null, {
            round: 9,
            pairs: [{ pair: 'BTC/USD', price: '1' }]
            // no timestamp, block_index, sigs, action_index
        });
        expect(insertArgs[0]).to.equal(9);     // round_number
        expect(insertArgs[3]).to.equal(9);     // reference_block falls back to round
        expect(insertArgs[4]).to.equal(null);  // reference_chain (sourceChain null)
        expect(insertArgs[5]).to.equal(0);     // block_timestamp
        expect(insertArgs[6]).to.equal(0);     // validator_count (no sigs)
        expect(insertArgs[7]).to.equal('[]');  // consensus_proof (empty sigs)
        expect(insertArgs[9]).to.equal(null);  // source_action_index (args[10] is created_at)
    });

    it('returns a db error if a snapshot INSERT throws', async function () {
        let events = [];
        agg.on('row:inserted', e => events.push(e));
        hub.db.doQuery.callsFake(async (sql) => {
            if (/^SELECT id FROM price_snapshots/.test(sql)) return [];
            if (/^INSERT INTO price_snapshots/.test(sql)) throw new Error('boom');
            return [];
        });
        let result = await agg.receiveValidatedRound('BTC', ROUND);
        expect(result).to.deep.equal({ accepted: false, reason: 'db error' });
        expect(events).to.deep.equal([]); // aborts before emitting
    });
});
