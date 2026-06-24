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
const PriceAggregator  = require('../../src/PriceAggregator');
const { createMockHub } = require('../helpers/mockHub');

// Mirror of the canonical PRICE v0 payload (xchain-indexer/src/ed25519.js)
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

    it('bounds the delete to a closed range and carries to_action_index when toActionIndex is given (item 5296)', async function () {
        hub.db.doQuery.resolves({ affectedRows: 1 });
        let events = [];
        agg.on('row:deleted', e => events.push(e));

        await agg.retractFromActionIndex('BTC', 50, 75);

        let calls = hub.db.doQuery.getCalls();
        let snapCall = calls.find(c => /price_snapshots/.test(c.args[0]));
        let oracleCall = calls.find(c => /oracle_prices/.test(c.args[0]));
        expect(snapCall.args[0]).to.match(/source_action_index >= \? AND source_action_index <= \?/);
        expect(snapCall.args[1]).to.deep.equal(['BTC', 50, 75]);
        expect(oracleCall.args[0]).to.match(/action_index >= \? AND action_index <= \?/);
        expect(oracleCall.args[1]).to.deep.equal(['BTC', 50, 75]);
        expect(events).to.deep.equal([
            { table: 'price_snapshots', source_chain: 'BTC', from_action_index: 50, to_action_index: 75 },
            { table: 'oracle_prices',   source_chain: 'BTC', from_action_index: 50, to_action_index: 75 }
        ]);
    });

    it('fences the delete by push_generation and carries retraction_generation when given (item 5308)', async function () {
        hub.db.doQuery.resolves({ affectedRows: 1 });
        let events = [];
        agg.on('row:deleted', e => events.push(e));

        // Bounded range [50,75] AND generation fence <= 5.
        await agg.retractFromActionIndex('BTC', 50, 75, 5);

        let calls = hub.db.doQuery.getCalls();
        let snapCall = calls.find(c => /price_snapshots/.test(c.args[0]));
        let oracleCall = calls.find(c => /oracle_prices/.test(c.args[0]));
        expect(snapCall.args[0]).to.match(/source_action_index >= \? AND source_action_index <= \? AND push_generation <= \?/);
        expect(snapCall.args[1]).to.deep.equal(['BTC', 50, 75, 5]);
        expect(oracleCall.args[0]).to.match(/action_index >= \? AND action_index <= \? AND push_generation <= \?/);
        expect(oracleCall.args[1]).to.deep.equal(['BTC', 50, 75, 5]);
        expect(events).to.deep.equal([
            { table: 'price_snapshots', source_chain: 'BTC', from_action_index: 50, to_action_index: 75, retraction_generation: 5 },
            { table: 'oracle_prices',   source_chain: 'BTC', from_action_index: 50, to_action_index: 75, retraction_generation: 5 }
        ]);
    });

    it('applies an open-ended generation fence (live retraction: gen but no toActionIndex)', async function () {
        hub.db.doQuery.resolves({ affectedRows: 1 });
        let events = [];
        agg.on('row:deleted', e => events.push(e));

        // Live retraction threads the generation with no upper bound (toActionIndex null).
        await agg.retractFromActionIndex('BTC', 50, null, 7);

        let calls = hub.db.doQuery.getCalls();
        let snapCall = calls.find(c => /price_snapshots/.test(c.args[0]));
        expect(snapCall.args[0]).to.match(/source_action_index >= \? AND push_generation <= \?/);
        expect(snapCall.args[0]).to.not.match(/<= \? AND push_generation/);   // no closed-range clause
        expect(snapCall.args[1]).to.deep.equal(['BTC', 50, 7]);
        expect(events[0]).to.deep.equal({ table: 'price_snapshots', source_chain: 'BTC', from_action_index: 50, retraction_generation: 7 });
    });

    it('omits the generation fence entirely when retractionGeneration is absent (older indexer back-compat)', async function () {
        hub.db.doQuery.resolves({ affectedRows: 1 });
        await agg.retractFromActionIndex('BTC', 50, 75);
        let snapCall = hub.db.doQuery.getCalls().find(c => /price_snapshots/.test(c.args[0]));
        expect(snapCall.args[0]).to.not.match(/push_generation/);
        expect(snapCall.args[1]).to.deep.equal(['BTC', 50, 75]);
    });

    it('rejects a malformed from_action_index without touching the DB', async function () {
        let result = await agg.retractFromActionIndex('BTC', 'not-a-number');
        expect(result).to.have.property('error');
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('treats a DELETE result with no affectedRows as zero deletions (and emits nothing)', async function () {
        // Some drivers return an array (not a result object): guard against undefined.
        hub.db.doQuery.resolves([]);
        let events = [];
        agg.on('row:deleted', e => events.push(e));

        let result = await agg.retractFromActionIndex('BTC', 0);

        expect(result).to.deep.equal({ retracted: { price_snapshots: 0, oracle_prices: 0 } });
        expect(events).to.deep.equal([]);
    });
});

describe('PriceAggregator.receiveOraclePrice() uniform 24h effective_at delay', function () {

    let hub, agg;

    // Capture the INSERT args; the dedup SELECT misses.
    function stubDb() {
        let insertArgs = null;
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^INSERT INTO oracle_prices/.test(sql)) { insertArgs = params; return {}; }
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

    it('delays a first-ever publish by 24h from its block_time', async function () {
        let getInsert = stubDb();

        let result = await agg.receiveOraclePrice('LTC', {
            source_address: 'addr1', coin: 'XCP', tick: 'GOLD', fiat: 'USD',
            value: '1.23', block_time: 1700000000, action_index: 7
        });

        expect(result).to.deep.equal({ accepted: true });
        // EVERY publish (first included) is delayed 24h so the row lands in
        // every mirror before any block can read it (no retroactive effect).
        expect(getInsert()[EFFECTIVE_AT]).to.equal(1700000000 + 86400);
    });

    it('delays an update by 24h from its block_time', async function () {
        let getInsert = stubDb();

        let result = await agg.receiveOraclePrice('LTC', {
            source_address: 'addr1', coin: 'XCP', tick: 'GOLD', fiat: 'USD',
            value: '1.50', block_time: 1700000000, action_index: 8
        });

        expect(result).to.deep.equal({ accepted: true });
        expect(getInsert()[EFFECTIVE_AT]).to.equal(1700000000 + 86400);
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
            value: '1.23', fee: '0.01', memo: 'hi', block_time: 1700000000, action_index: 7,
            push_generation: 4
        });

        expect(result).to.deep.equal({ accepted: true });
        // Uniform 24h delay applies to every publish, first included. push_generation (item 5308)
        // is the 12th column, stamped from the push payload.
        expect(insertArgs).to.deep.equal([
            'addr1', 'BTC', 'XCP', 'GOLD', 'USD', '1.23', '0.01', 'hi',
            1700000000, 1700086400, 7, 4
        ]);
        expect(events).to.have.length(1);
        expect(events[0].table).to.equal('oracle_prices');
        expect(events[0].row).to.include({
            source_address: 'addr1', source_chain: 'BTC', coin: 'XCP',
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
            source_address: 'addr1', coin: 'XCP', tick: 'GOLD', fiat: 'USD',
            value: '1.23', block_time: 1700000000, action_index: 7
        });
        expect(insertArgs[11]).to.equal(0);     // push_generation defaults to 0
    });

    it('rejects a malformed or non-positive value without touching the DB', async function () {
        for (let value of ['abc', '-1', '0', '1.123456789', '1e5']) {
            let result = await agg.receiveOraclePrice('BTC', { ...VALID, value });
            expect(result, 'value=' + value).to.deep.equal({ accepted: false, reason: 'invalid value' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('rejects a malformed or out-of-range fee without touching the DB', async function () {
        for (let fee of ['abc', '1.5', '-0.1']) {
            let result = await agg.receiveOraclePrice('BTC', { ...VALID, fee });
            expect(result, 'fee=' + fee).to.deep.equal({ accepted: false, reason: 'invalid fee' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
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

    // Four price-qualified validators → PBFT quorum 2*floor(3/3)+1 = 3
    const V = [makeValidator(), makeValidator(), makeValidator(), makeValidator()];
    const PAIRS   = [{ pair: 'BTC/USD', price: '50000' }, { pair: 'LTC/USD', price: '80' }];
    const BTC_HEIGHT = 799000;  // the round's BTC anchor (distinct from block_index, the PRICE tx block)
    const PAYLOAD = buildPriceV0Payload(5, 1700000000, PAIRS, BTC_HEIGHT);

    // A legitimately signed round: 3 of the 4 qualified validators signed
    function makeRound(overrides = {}) {
        return {
            round: 5,
            timestamp: 1700000000,
            btc_block_height: BTC_HEIGHT,
            block_index: 800000,
            action_index: 42,
            pairs: PAIRS,
            sigs: V.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: v.sign(PAYLOAD) })),
            ...overrides
        };
    }

    function stubSnapshot(snapshot) {
        hub.capabilitySnapshot = { getSnapshot: sinon.stub().resolves(snapshot) };
        return hub.capabilitySnapshot.getSnapshot;
    }

    function snapshotOf(validators) {
        return {
            capability: 'price',
            blockIndex: 800000,
            count:      validators.length,
            validators: validators.map(v => ({ pubkey: v.pubkey, amount: '100000.00000000' }))
        };
    }

    // doQuery stub: dedup SELECT misses, INSERTs are captured
    function stubDb() {
        let inserts = [];
        hub.db.doQuery.callsFake(async (sql, params) => {
            if (/^SELECT id FROM price_snapshots/.test(sql)) return [];
            if (/^INSERT INTO price_snapshots/.test(sql)) { inserts.push(params); return {}; }
            return [];
        });
        return inserts;
    }

    beforeEach(function () {
        hub = createMockHub();
        agg = new PriceAggregator(hub);
        stubSnapshot(snapshotOf(V));
    });

    afterEach(function () {
        sinon.restore();
    });

    it('rejects roundData that is null / missing round / has non-array or empty pairs', async function () {
        for (let bad of [null, { pairs: [] }, { round: 5 }, { round: 5, pairs: 'x' }]) {
            let result = await agg.receiveValidatedRound('BTC', bad);
            expect(result).to.deep.equal({ accepted: false, reason: 'invalid roundData' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('rejects a non-finite or negative round number', async function () {
        let r1 = await agg.receiveValidatedRound('BTC', makeRound({ round: -1 }));
        expect(r1).to.deep.equal({ accepted: false, reason: 'invalid round' });
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('rejects a round missing timestamp or block_index (both are signed/anchoring fields)', async function () {
        let r1 = await agg.receiveValidatedRound('BTC', makeRound({ timestamp: undefined }));
        expect(r1).to.deep.equal({ accepted: false, reason: 'invalid timestamp' });
        let r2 = await agg.receiveValidatedRound('BTC', makeRound({ block_index: undefined }));
        expect(r2).to.deep.equal({ accepted: false, reason: 'invalid block_index' });
        let r3 = await agg.receiveValidatedRound('BTC', makeRound({ btc_block_height: undefined }));
        expect(r3).to.deep.equal({ accepted: false, reason: 'invalid btc_block_height' });
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('rejects malformed pairs instead of silently skipping them', async function () {
        for (let pairs of [
            [{ pair: 'BTC/USD', price: '50000' }, null],
            [{ pair: 'NOPRICE' }],
            [{ price: '1' }],
            [{ pair: 'not a pair', price: '1' }],
            [{ pair: 'BTC/USD', price: 'NaN' }]
        ]) {
            let result = await agg.receiveValidatedRound('BTC', makeRound({ pairs }));
            expect(result, JSON.stringify(pairs)).to.deep.equal({ accepted: false, reason: 'invalid pairs' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('rejects opaque/unstructured sigs (the historical blind-storage shape)', async function () {
        // Before hub-side verification existed, exactly this shape was stored
        // verbatim as a 'finalized' consensus proof with validator_count 2.
        for (let sigs of [undefined, [], ['sigA', 'sigB'], [{ pubkey: 'xx', sig: 'yy' }]]) {
            let result = await agg.receiveValidatedRound('BTC', makeRound({ sigs }));
            expect(result, JSON.stringify(sigs)).to.deep.equal({ accepted: false, reason: 'invalid sigs' });
        }
        expect(hub.db.doQuery.called).to.equal(false);
    });

    it('rejects a duplicate round (a snapshot row already exists) before verification', async function () {
        hub.db.doQuery.onFirstCall().resolves([{ id: 1 }]);
        let result = await agg.receiveValidatedRound('BTC', makeRound());
        expect(result).to.deep.equal({ accepted: false, reason: 'duplicate' });
        expect(hub.db.doQuery.callCount).to.equal(1); // dedup SELECT only
        expect(hub.capabilitySnapshot.getSnapshot.called).to.equal(false);
    });

    it('accepts a quorum-signed round, stores only verified sigs, and emits row:inserted per pair', async function () {
        let inserts = stubDb();
        let events = [];
        agg.on('row:inserted', e => events.push(e));

        let result = await agg.receiveValidatedRound('BTC', makeRound());

        expect(result).to.deep.equal({ accepted: true });
        // The validator set was resolved for the price capability at the round's block
        expect(hub.capabilitySnapshot.getSnapshot.calledOnceWith('price', 800000)).to.equal(true);
        // One atomic multi-row INSERT for the whole round; inserts[0] is the flat
        // params array, first 11 entries = the first row (round/pair/price/…).
        expect(inserts).to.have.length(1);
        expect(inserts[0][0]).to.equal(5);             // round_number
        expect(inserts[0][1]).to.equal('BTC/USD');     // coin_pair
        expect(inserts[0][2]).to.equal('50000');       // price
        expect(inserts[0][3]).to.equal(800000);        // reference_block
        expect(inserts[0][4]).to.equal('BTC');         // reference_chain
        expect(inserts[0][5]).to.equal(1700000000);    // block_timestamp
        expect(inserts[0][6]).to.equal(3);             // validator_count = VERIFIED sigs
        // consensus_proof holds exactly the verified (pubkey, sig) pairs
        let proof = JSON.parse(inserts[0][7]);
        expect(proof.map(s => s.pubkey)).to.deep.equal(V.slice(0, 3).map(v => v.pubkey));
        expect(events).to.have.length(2);
        expect(events.every(e => e.table === 'price_snapshots')).to.equal(true);
        expect(events.map(e => e.row.coin_pair)).to.deep.equal(['BTC/USD', 'LTC/USD']);
    });

    it("excludes 'skipped' placeholder rows from the dedup SELECT so a peer-salvaged round is not rejected", async function () {
        // A round this hub locally marked 'skipped' (no local submissions) must not
        // block a real validated round for the same round_number arriving from a
        // peer chain that reached quorum. The dedup SELECT therefore filters out
        // skipped rows; only a genuine finalized row counts as a duplicate.
        let dedupSql = null;
        hub.db.doQuery.callsFake(async (sql) => {
            if (/^SELECT id FROM price_snapshots/.test(sql)) { dedupSql = sql; return []; }
            return {};
        });
        let result = await agg.receiveValidatedRound('BTC', makeRound());
        expect(result).to.deep.equal({ accepted: true });
        expect(dedupSql).to.match(/status\s*!=\s*'skipped'/);
    });

    it('writes each pair as an upsert (ON DUPLICATE KEY UPDATE → finalized) so a skipped placeholder is overwritten, not collided', async function () {
        // With skipped rows excluded from the dedup, a skipped placeholder still
        // occupies the (round_number, coin_pair) unique key, so a plain INSERT would
        // collide. The write must upsert: overwrite the placeholder with finalized
        // data (and stay idempotent for an already-finalized row).
        let insertSqls = [];
        hub.db.doQuery.callsFake(async (sql) => {
            if (/^SELECT id FROM price_snapshots/.test(sql)) return [];
            if (/^INSERT INTO price_snapshots/.test(sql)) { insertSqls.push(sql); return {}; }
            return {};
        });
        let result = await agg.receiveValidatedRound('BTC', makeRound());
        expect(result).to.deep.equal({ accepted: true });
        // One atomic multi-row INSERT for the whole round (not one per pair).
        expect(insertSqls).to.have.length(1);
        insertSqls.forEach(sql => {
            expect(sql).to.match(/ON DUPLICATE KEY UPDATE/);
            expect(sql).to.match(/status\s*=\s*'finalized'/);
        });
    });

    it('rejects a round whose sigs are forged (well-formed hex but cryptographically invalid)', async function () {
        stubDb();
        let result = await agg.receiveValidatedRound('BTC', makeRound({
            sigs: V.slice(0, 3).map(v => ({ pubkey: v.pubkey, sig: 'ab'.repeat(64) }))
        }));
        expect(result).to.deep.equal({ accepted: false, reason: 'insufficient quorum (0/3)' });
        expect(hub.db.doQuery.getCalls().some(c => /^INSERT/.test(c.args[0]))).to.equal(false);
    });

    it('rejects a round signed over a DIFFERENT payload (valid sigs, wrong data)', async function () {
        stubDb();
        // Validators signed round 5 at the real prices; attacker replays those
        // sigs on a round claiming BTC/USD = 1.
        let result = await agg.receiveValidatedRound('BTC', makeRound({
            pairs: [{ pair: 'BTC/USD', price: '1' }]
        }));
        expect(result).to.deep.equal({ accepted: false, reason: 'insufficient quorum (0/3)' });
        expect(hub.db.doQuery.getCalls().some(c => /^INSERT/.test(c.args[0]))).to.equal(false);
    });

    it('rejects a round signed by keys outside the qualified price-capability set', async function () {
        stubDb();
        let outsiders = [makeValidator(), makeValidator(), makeValidator()];
        let result = await agg.receiveValidatedRound('BTC', makeRound({
            sigs: outsiders.map(v => ({ pubkey: v.pubkey, sig: v.sign(PAYLOAD) }))
        }));
        expect(result).to.deep.equal({ accepted: false, reason: 'insufficient quorum (0/3)' });
        expect(hub.db.doQuery.getCalls().some(c => /^INSERT/.test(c.args[0]))).to.equal(false);
    });

    it('rejects a round below quorum and counts a duplicated pubkey only once', async function () {
        stubDb();
        // 2 distinct valid sigs < quorum 3
        let result = await agg.receiveValidatedRound('BTC', makeRound({
            sigs: V.slice(0, 2).map(v => ({ pubkey: v.pubkey, sig: v.sign(PAYLOAD) }))
        }));
        expect(result).to.deep.equal({ accepted: false, reason: 'insufficient quorum (2/3)' });

        // Padding with a repeat of the same validator must not reach quorum
        let sig0 = { pubkey: V[0].pubkey, sig: V[0].sign(PAYLOAD) };
        let result2 = await agg.receiveValidatedRound('BTC', makeRound({
            sigs: [sig0, sig0, { pubkey: V[1].pubkey, sig: V[1].sign(PAYLOAD) }]
        }));
        expect(result2).to.deep.equal({ accepted: false, reason: 'insufficient quorum (2/3)' });
        expect(hub.db.doQuery.getCalls().some(c => /^INSERT/.test(c.args[0]))).to.equal(false);
    });

    it('fails closed when the validator snapshot is unavailable', async function () {
        stubDb();
        stubSnapshot(null); // indexer unreachable
        let result = await agg.receiveValidatedRound('BTC', makeRound());
        expect(result).to.deep.equal({ accepted: false, reason: 'validator snapshot unavailable' });

        hub.capabilitySnapshot = undefined; // no snapshot machinery at all
        let result2 = await agg.receiveValidatedRound('BTC', makeRound());
        expect(result2).to.deep.equal({ accepted: false, reason: 'validator snapshot unavailable' });
        expect(hub.db.doQuery.getCalls().some(c => /^INSERT/.test(c.args[0]))).to.equal(false);
    });

    it('accepts a single-validator round in a single-node set (quorum 1)', async function () {
        let inserts = stubDb();
        stubSnapshot(snapshotOf([V[0]]));
        let result = await agg.receiveValidatedRound('BTC', makeRound({
            sigs: [{ pubkey: V[0].pubkey, sig: V[0].sign(PAYLOAD) }]
        }));
        expect(result).to.deep.equal({ accepted: true });
        expect(inserts).to.have.length(1); // one atomic multi-row INSERT
        expect(inserts[0][6]).to.equal(1); // validator_count (first row)
    });

    it('returns a db error if a snapshot INSERT throws', async function () {
        let events = [];
        agg.on('row:inserted', e => events.push(e));
        hub.db.doQuery.callsFake(async (sql) => {
            if (/^SELECT id FROM price_snapshots/.test(sql)) return [];
            if (/^INSERT INTO price_snapshots/.test(sql)) throw new Error('boom');
            return [];
        });
        let result = await agg.receiveValidatedRound('BTC', makeRound());
        expect(result).to.deep.equal({ accepted: false, reason: 'db error' });
        expect(events).to.deep.equal([]); // aborts before emitting
    });
});
