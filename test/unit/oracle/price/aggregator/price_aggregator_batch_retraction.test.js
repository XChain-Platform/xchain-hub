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
//
// PRICE v0 (batch) ingest: PriceAggregator.receiveValidatedBatch, spec
// spec section 5.7, decisions D8, D13, D14, D23, D28.
//
// The canonical payload itself is pinned elsewhere (price_v0_batch_canonical_parity.test.js
// asserts all three buildPriceBatchPayload implementations are byte-identical, including
// the OracleConsensus and PriceAggregator production twins), so these tests sign whatever
// that builder emits and pin what INGEST does
// with a batch: per-round dedupe, column semantics, the block_time-keyed pair flag
// day, the WS mirror re-emit, the reorg fence and the publisher marker clear.

const crypto            = require('crypto');
const sinon             = require('sinon');
const { expect }        = require('chai');
const PriceAggregator   = require('../../../../../src/oracle/price_aggregator');
const { createMockHub } = require('../../../../helpers/mockHub');
const { CANONICAL_REORG_BUFFER } = require('../../../../../src/consensus/snapshot_reorg_buffer.js');
// The pair-name flag day's own map. Every shipped network is genesis-on since the
// 2026-09-09 ruling, so the D14 case below straddles a threshold it installs itself.
const { PRICE_PAIR_WIDEN_ACTIVATION } = require('../../../../../src/consensus/gates/price_pair_gate.js');

// Generate a real Ed25519 validator keypair: { pubkey (64-hex), sign(payload) -> 128-hex }
function makeValidator() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let pubkey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    return {
        pubkey,
        sign: (payload) => crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex')
    };
}



    let hub, agg, publisher;


    // Batch-sourced rows carry the {"batch":...} consensus_proof of D23; a v0 row's
    // proof is a bare signature array, which is what the LIKE prefix separates.
    function stubDb(batchRoundRows) {
        hub.db.doQuery.callsFake(async (sql) => {
            if (/^SELECT DISTINCT round_number/.test(sql)) return batchRoundRows;
            return { affectedRows: batchRoundRows.length ? 4 : 2 };
        });
    }

function registerPriceaggregatorRetractfromactionindexBatchMarkerClear1Hooks() {

    beforeEach(function () {
        hub = createMockHub();
        agg = new PriceAggregator(hub);
        publisher = { clearPublishedMarkers: sinon.stub().resolves() };
        hub.oraclePublisher = publisher;
        sinon.stub(console, 'log');
    });

    afterEach(function () {
        sinon.restore();
    });
}

function registerPriceaggregatorRetractfromactionindexBatchMarkerClear1Tests1() {

    it('clears the publisher marker for every round a retracted batch carried', async function () {
        stubDb([{ round_number: 100 }, { round_number: 101 }, { round_number: 102 }]);

        await agg.retractFromActionIndex('BTC', 500, 600, 3);

        // The rounds are read BEFORE the DELETE, bounded and fenced exactly as the
        // DELETE is, so a row outside the retraction never clears a live marker.
        let select = hub.db.doQuery.getCalls().find(c => /^SELECT DISTINCT round_number/.test(c.args[0]));
        expect(select, 'batch-round lookup issued').to.exist;
        expect(select.args[0]).to.match(/consensus_proof LIKE '\{"batch":%'/);
        expect(select.args[1]).to.deep.equal(['BTC', 500, 600, 3]);
        expect(hub.db.doQuery.firstCall.args[0]).to.match(/^SELECT DISTINCT round_number/);

        expect(publisher.clearPublishedMarkers.calledOnce).to.equal(true);
        expect(publisher.clearPublishedMarkers.firstCall.args[0]).to.deep.equal([100, 101, 102]);
    });

    it('does not touch the publisher when the retraction removed no batch-sourced rows', async function () {
        stubDb([]);
        await agg.retractFromActionIndex('BTC', 500);
        expect(publisher.clearPublishedMarkers.called).to.equal(false);
    });

    it('completes the retraction when the marker clear throws', async function () {
        stubDb([{ round_number: 100 }]);
        publisher.clearPublishedMarkers.rejects(new Error('marker table down'));
        sinon.stub(console, 'error');

        let result = await agg.retractFromActionIndex('BTC', 500);

        // The rows are already gone; a publisher failure must never report the
        // retraction as failed.
        expect(result.retracted.price_snapshots).to.equal(4);
        expect(console.error.calledOnce).to.equal(true);
    });

    it('issues no extra query and stays a two-statement path when no publisher is wired', async function () {
        delete hub.oraclePublisher;
        hub.db.doQuery.resolves({ affectedRows: 1 });

        await agg.retractFromActionIndex('LTC', 10);

        let calls = hub.db.doQuery.getCalls();
        expect(calls.length).to.equal(2);
        expect(calls.every(c => /^DELETE FROM/.test(c.args[0]))).to.equal(true);
    });
}

function registerPriceaggregatorRetractfromactionindexBatchMarkerClear1Tests5() {

    it('names the missing half out loud when a publisher is wired without the clear seam', async function () {
        hub.oraclePublisher = {};                     // no clearPublishedMarkers
        hub.db.doQuery.resolves({ affectedRows: 1 });
        sinon.stub(console, 'warn');

        await agg.retractFromActionIndex('BTC', 500);

        expect(console.warn.calledOnce).to.equal(true);
        expect(console.warn.firstCall.args[0]).to.match(/clearPublishedMarkers/);
    });

}

describe('PriceAggregator.retractFromActionIndex() batch marker clear (D28)', function () {
    registerPriceaggregatorRetractfromactionindexBatchMarkerClear1Hooks();
    registerPriceaggregatorRetractfromactionindexBatchMarkerClear1Tests1();
    registerPriceaggregatorRetractfromactionindexBatchMarkerClear1Tests5();
});
