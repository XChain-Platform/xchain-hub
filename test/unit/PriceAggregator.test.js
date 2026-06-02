'use strict';

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
