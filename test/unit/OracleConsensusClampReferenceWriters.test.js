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
// Item 5834: _lastFinalizedPrices had exactly two writers (the start-time seed and
// _storeSnapshot), so every round this hub did not itself store left the clamp
// reference behind while the federation moved on. These cases pin the two closed
// writer gaps -- the push-ingest stream and the periodic re-seed -- and the
// monotonic rule that keeps either one from walking the reference BACKWARDS.

const sinon           = require('sinon');
const { expect }      = require('chai');
const OracleConsensus = require('../../src/OracleConsensus');
const XChainHub       = require('../../src/XChainHub');
const { createMockHub } = require('../helpers/mockHub');

describe('OracleConsensus clamp-reference writers (item 5834)', function () {

    let hub, oc;

    beforeEach(function () {
        hub = createMockHub();
        oc  = new OracleConsensus(hub, { getSubmissions: sinon.stub().returns(new Map()) });
    });

    afterEach(function () {
        sinon.restore();
    });

    function finalizedRow(round, pair, price) {
        return { round_number: round, coin_pair: pair, price: price, status: 'finalized' };
    }

    function finalizedEvent(round, pair, price) {
        return { table: 'price_snapshots', row: finalizedRow(round, pair, price) };
    }

    describe('push-ingest stream', function () {

        it('a finalized row for a newer round moves the clamp reference', function () {
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100.00000000' }], 1);
            // Round 2 arrived by push (PriceAggregator.receiveValidatedRound), not by
            // finalizing here. Before the fix this hub kept clamping against round 1.
            oc.noteIngestedPriceRow(finalizedRow(2, 'BTC/USD', '200.00000000'));
            expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('200.00000000');
            expect(oc._clampToLastFinalized('BTC/USD', '260.00000000')).to.equal('250.00000000');
        });

        it('a finalized row for an older round does not walk the reference backwards', function () {
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '200.00000000' }], 5);
            oc.noteIngestedPriceRow(finalizedRow(3, 'BTC/USD', '100.00000000'));
            expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('200.00000000');
        });

        it('a skipped row is not a reference', function () {
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100.00000000' }], 1);
            oc.noteIngestedPriceRow({
                round_number: 2, coin_pair: 'BTC/USD', price: null, status: 'skipped'
            });
            expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('100.00000000');
        });

        it('the hub listener routes price_snapshots rows and ignores other tables', function () {
            let fake = { oracleConsensus: oc };
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100.00000000' }], 1);
            XChainHub.prototype._noteAggregatorRow.call(fake, {
                table: 'oracle_prices', row: { coin_pair: 'BTC/USD', price: '999.00000000' }
            });
            expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('100.00000000');
            XChainHub.prototype._noteAggregatorRow.call(fake, finalizedEvent(2, 'BTC/USD', '150.00000000'));
            expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('150.00000000');
        });

        it('the hub listener survives a consensus engine that is not up yet', function () {
            expect(() => XChainHub.prototype._noteAggregatorRow.call(
                { oracleConsensus: null }, finalizedEvent(2, 'BTC/USD', '150.00000000'))).to.not.throw();
        });
    });

    describe('_storeSnapshot monotonicity', function () {

        it('a late store for an older round leaves the newer reference in place', async function () {
            hub.db.doQuery = sinon.stub().resolves([]);
            oc._markerPairs = () => [];
            await oc._storeSnapshot(9, [{ coinPair: 'BTC/USD', price: '200.00000000' }], 1, '[]', 1, 1);
            await oc._storeSnapshot(4, [{ coinPair: 'BTC/USD', price: '100.00000000' }], 1, '[]', 1, 1);
            expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('200.00000000');
        });

        it('an unstamped update still sets, so the existing callers are unchanged', function () {
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100.00000000' }]);
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '50.00000000' }]);
            expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('50.00000000');
        });
    });

    describe('periodic re-seed', function () {

        it('picks up a finalized round this process never stored', async function () {
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100.00000000' }], 1);
            hub.db.doQuery = sinon.stub().resolves(
                [{ coin_pair: 'BTC/USD', price: '200.00000000', round_number: 7 }]);
            await oc._seedLastFinalizedPrices({ quiet: true });
            expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('200.00000000');
            expect(oc._clampToLastFinalized('BTC/USD', '260.00000000')).to.equal('250.00000000');
        });

        it('a failed read keeps the previous reference and never throws', async function () {
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100.00000000' }], 1);
            hub.db.doQuery = sinon.stub().rejects(new Error('db down'));
            await oc._seedLastFinalizedPrices({ quiet: true });
            expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('100.00000000');
        });

        it('an empty read does not clear the cache, so no pair goes unclamped', async function () {
            oc._updateLastFinalizedPrices([{ coinPair: 'BTC/USD', price: '100.00000000' }], 1);
            hub.db.doQuery = sinon.stub().resolves([]);
            await oc._seedLastFinalizedPrices({ quiet: true });
            expect(oc._getLastFinalizedPrice('BTC/USD')).to.equal('100.00000000');
        });

        it('start() arms the re-seed timer and stop() clears it', async function () {
            hub.db.doQuery = sinon.stub().resolves([]);
            await oc.start();
            expect(oc._reseedTimer).to.not.equal(null);
            await oc.stop();
            expect(oc._reseedTimer).to.equal(null);
        });
    });
});
