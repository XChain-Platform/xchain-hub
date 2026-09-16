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
const PriceAggregator  = require('../../../../../src/oracle/price_aggregator');
const { createMockHub } = require('../../../../helpers/mockHub');

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

function registerPriceaggregatorRetractfromactionindex1Hooks() {

    beforeEach(function () {
        hub = createMockHub();
        agg = new PriceAggregator(hub);
    });

    afterEach(function () {
        sinon.restore();
    });
}

function registerPriceaggregatorRetractfromactionindex1Tests1() {

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
}

function registerPriceaggregatorRetractfromactionindex1Tests4() {

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
}

function registerPriceaggregatorRetractfromactionindex1Tests6() {

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

    // a supplied-but-malformed to/generation used to be treated as ABSENT, turning a
    // bounded fenced delete into the open-ended one, and parseInt turned '1e3' into 1.
    it('rejects a supplied-but-malformed to_action_index or retraction_generation without deleting', async function () {
        for (let args of [['BTC', 50, 'abc'], ['BTC', 50, 75, 'abc'], ['BTC', '1e3junk'], ['BTC', 50, 10], ['BTC', '']]) {
            hub.db.doQuery.resetHistory();
            let result = await agg.retractFromActionIndex(...args);
            expect(result.error, 'expected rejection for ' + JSON.stringify(args)).to.match(/^invalid /);
            expect(hub.db.doQuery.called).to.equal(false);
        }
    });

    it('HUB-RETRACT-4: records the ingest watermark (generation + from) on a fenced retraction', async function () {
        hub.db.doQuery.resolves({ affectedRows: 1 });
        await agg.retractFromActionIndex('BTC', 50, null, 7);
        expect(hub.db.bumpPriceIngestWatermark.calledOnce).to.equal(true);
        // (source_chain, retraction_generation, from_action_index, network)
        expect(hub.db.bumpPriceIngestWatermark.firstCall.args).to.deep.equal(['BTC', 7, 50, '']);
    });

    it('HUB-RETRACT-4: records the watermark even on a 0-row delete (the stale push may not have arrived yet)', async function () {
        hub.db.doQuery.resolves({ affectedRows: 0 });
        await agg.retractFromActionIndex('DOGE', 12, null, 3);
        expect(hub.db.bumpPriceIngestWatermark.calledOnceWith('DOGE', 3, 12)).to.equal(true);
    });
}

function registerPriceaggregatorRetractfromactionindex1Tests12() {

    it('HUB-RETRACT-4: does NOT record a watermark on an unfenced retraction (older indexer omits the generation)', async function () {
        hub.db.doQuery.resolves({ affectedRows: 1 });
        await agg.retractFromActionIndex('BTC', 50, 75);   // no retractionGeneration
        expect(hub.db.bumpPriceIngestWatermark.called).to.equal(false);
    });

    it('HUB-RETRACT-4: writes the fence BEFORE both deletes', async function () {
        hub.db.doQuery.resolves({ affectedRows: 1 });
        await agg.retractFromActionIndex('BTC', 50, null, 7);
        let calls      = hub.db.doQuery.getCalls();
        let snapCall   = calls.find(c => /DELETE FROM price_snapshots/.test(c.args[0]));
        let oracleCall = calls.find(c => /DELETE FROM oracle_prices/.test(c.args[0]));
        expect(hub.db.bumpPriceIngestWatermark.firstCall.calledBefore(snapCall)).to.equal(true);
        expect(hub.db.bumpPriceIngestWatermark.firstCall.calledBefore(oracleCall)).to.equal(true);
    });

    // The caller drops its durable outbox row on a success return, so a swallowed fence-write
    // failure deleted the rows, left the fence unpersisted and destroyed the only retry.
    it('HUB-RETRACT-4: fails the retraction when the fence write fails, deleting nothing', async function () {
        hub.db.doQuery.resolves({ affectedRows: 1 });
        hub.db.bumpPriceIngestWatermark.rejects(new Error('watermark table is gone'));
        let events = [];
        agg.on('row:deleted', e => events.push(e));

        let result = await agg.retractFromActionIndex('BTC', 50, null, 7);

        expect(result).to.have.property('error');
        expect(result).to.not.have.property('retracted');
        expect(result.error).to.match(/ingest fence not persisted/);
        let deletes = hub.db.doQuery.getCalls().filter(c => /^DELETE FROM/.test(c.args[0]));
        expect(deletes).to.deep.equal([]);
        expect(events).to.deep.equal([]);
    });

    // xchain-indexer/src/hub/hub_client.js TERMINAL_HUB_REJECTIONS: a match there DROPS the queued
    // retraction instead of retrying it, which would undo this whole guard.
    it('HUB-RETRACT-4: the fence-failure error is retryable, not a terminal hub rejection', async function () {
        const TERMINAL = [
            /^duplicate$/i,
            /^stale \(retracted generation\)$/i,
            /^invalid\b/i,
            /^insufficient quorum\b/i,
            /\b(is|are) required$/i,
            /^chain must be one of\b/i
        ];
        hub.db.doQuery.resolves({ affectedRows: 1 });
        for (let message of ['db is required', 'invalid watermark', 'duplicate']) {
            hub.db.bumpPriceIngestWatermark.rejects(new Error(message));
            let result = await agg.retractFromActionIndex('BTC', 50, null, 7);
            expect(result.error, message).to.be.a('string');
            for (let rx of TERMINAL)
                expect(rx.test(result.error), message + ' vs ' + rx).to.equal(false);
        }
    });
}

function registerPriceaggregatorRetractfromactionindex1Tests16() {

    it('treats a DELETE result with no affectedRows as zero deletions (and emits nothing)', async function () {
        // Some drivers return an array (not a result object): guard against undefined.
        hub.db.doQuery.resolves([]);
        let events = [];
        agg.on('row:deleted', e => events.push(e));

        let result = await agg.retractFromActionIndex('BTC', 0);

        expect(result).to.deep.equal({ retracted: { price_snapshots: 0, oracle_prices: 0 } });
        expect(events).to.deep.equal([]);
    });

}

describe('PriceAggregator.retractFromActionIndex()', function () {
    registerPriceaggregatorRetractfromactionindex1Hooks();
    registerPriceaggregatorRetractfromactionindex1Tests1();
    registerPriceaggregatorRetractfromactionindex1Tests4();
    registerPriceaggregatorRetractfromactionindex1Tests6();
    registerPriceaggregatorRetractfromactionindex1Tests12();
    registerPriceaggregatorRetractfromactionindex1Tests16();
});
