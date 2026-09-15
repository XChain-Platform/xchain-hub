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
const sinon = require('sinon');
const {
  expect
} = require('chai');
const OracleConsensus = require('../../src/oracle/consensus');
const XChainHub = require('../../src/XChainHub');
const {
  createMockHub
} = require('../helpers/mockHub');
let oracleConsensusClampReferenceWritersItemSuite1Hub, oracleConsensusClampReferenceWritersItemSuite1Oc;
function oracleConsensusClampReferenceWritersItemSuite1FinalizedRow(round, pair, price) {
  return {
    round_number: round,
    coin_pair: pair,
    price: price,
    status: 'finalized'
  };
}
function oracleConsensusClampReferenceWritersItemSuite1FinalizedEvent(round, pair, price) {
  return {
    table: 'price_snapshots',
    row: oracleConsensusClampReferenceWritersItemSuite1FinalizedRow(round, pair, price)
  };
}
function registerOracleConsensusClampReferenceWritersItemSuite1Part1() {
  beforeEach(function () {
    oracleConsensusClampReferenceWritersItemSuite1Hub = createMockHub();
    oracleConsensusClampReferenceWritersItemSuite1Oc = new OracleConsensus(oracleConsensusClampReferenceWritersItemSuite1Hub, {
      getSubmissions: sinon.stub().returns(new Map())
    });
  });
  afterEach(function () {
    sinon.restore();
  });
}
function registerOracleConsensusClampReferenceWritersItemSuite1Part2() {
  describe('push-ingest stream', function () {
    it('a finalized row for a newer round moves the clamp reference', function () {
      oracleConsensusClampReferenceWritersItemSuite1Oc.updateLastFinalizedPrices([{
        coinPair: 'BTC/USD',
        price: '100.00000000'
      }], 1);
      // Round 2 arrived by push (PriceAggregator.receiveValidatedRound), not by
      // finalizing here. Before the fix this hub kept clamping against round 1.
      oracleConsensusClampReferenceWritersItemSuite1Oc.noteIngestedPriceRow(oracleConsensusClampReferenceWritersItemSuite1FinalizedRow(2, 'BTC/USD', '200.00000000'));
      expect(oracleConsensusClampReferenceWritersItemSuite1Oc.getLastFinalizedPrice('BTC/USD')).to.equal('200.00000000');
      expect(oracleConsensusClampReferenceWritersItemSuite1Oc.clampToLastFinalized('BTC/USD', '260.00000000')).to.equal('250.00000000');
    });
    it('a finalized row for an older round does not walk the reference backwards', function () {
      oracleConsensusClampReferenceWritersItemSuite1Oc.updateLastFinalizedPrices([{
        coinPair: 'BTC/USD',
        price: '200.00000000'
      }], 5);
      oracleConsensusClampReferenceWritersItemSuite1Oc.noteIngestedPriceRow(oracleConsensusClampReferenceWritersItemSuite1FinalizedRow(3, 'BTC/USD', '100.00000000'));
      expect(oracleConsensusClampReferenceWritersItemSuite1Oc.getLastFinalizedPrice('BTC/USD')).to.equal('200.00000000');
    });
    it('a skipped row is not a reference', function () {
      oracleConsensusClampReferenceWritersItemSuite1Oc.updateLastFinalizedPrices([{
        coinPair: 'BTC/USD',
        price: '100.00000000'
      }], 1);
      oracleConsensusClampReferenceWritersItemSuite1Oc.noteIngestedPriceRow({
        round_number: 2,
        coin_pair: 'BTC/USD',
        price: null,
        status: 'skipped'
      });
      expect(oracleConsensusClampReferenceWritersItemSuite1Oc.getLastFinalizedPrice('BTC/USD')).to.equal('100.00000000');
    });
    it('the hub listener routes price_snapshots rows and ignores other tables', function () {
      let fake = {
        oracleConsensus: oracleConsensusClampReferenceWritersItemSuite1Oc
      };
      oracleConsensusClampReferenceWritersItemSuite1Oc.updateLastFinalizedPrices([{
        coinPair: 'BTC/USD',
        price: '100.00000000'
      }], 1);
      XChainHub.prototype.noteAggregatorRow.call(fake, {
        table: 'oracle_prices',
        row: {
          coin_pair: 'BTC/USD',
          price: '999.00000000'
        }
      });
      expect(oracleConsensusClampReferenceWritersItemSuite1Oc.getLastFinalizedPrice('BTC/USD')).to.equal('100.00000000');
      XChainHub.prototype.noteAggregatorRow.call(fake, oracleConsensusClampReferenceWritersItemSuite1FinalizedEvent(2, 'BTC/USD', '150.00000000'));
      expect(oracleConsensusClampReferenceWritersItemSuite1Oc.getLastFinalizedPrice('BTC/USD')).to.equal('150.00000000');
    });
    it('the hub listener survives a consensus engine that is not up yet', function () {
      expect(() => XChainHub.prototype.noteAggregatorRow.call({
        oracleConsensus: null
      }, oracleConsensusClampReferenceWritersItemSuite1FinalizedEvent(2, 'BTC/USD', '150.00000000'))).to.not.throw();
    });
  });
}
function registerOracleConsensusClampReferenceWritersItemSuite1Part3() {
  describe('_storeSnapshot monotonicity', function () {
    it('a late store for an older round leaves the newer reference in place', async function () {
      oracleConsensusClampReferenceWritersItemSuite1Hub.db.doQuery = sinon.stub().resolves([]);
      oracleConsensusClampReferenceWritersItemSuite1Oc.markerPairs = () => [];
      await oracleConsensusClampReferenceWritersItemSuite1Oc._storeSnapshot(9, [{
        coinPair: 'BTC/USD',
        price: '200.00000000'
      }], 1, '[]', 1, 1);
      await oracleConsensusClampReferenceWritersItemSuite1Oc._storeSnapshot(4, [{
        coinPair: 'BTC/USD',
        price: '100.00000000'
      }], 1, '[]', 1, 1);
      expect(oracleConsensusClampReferenceWritersItemSuite1Oc.getLastFinalizedPrice('BTC/USD')).to.equal('200.00000000');
    });
    it('an unstamped update still sets, so the existing callers are unchanged', function () {
      oracleConsensusClampReferenceWritersItemSuite1Oc.updateLastFinalizedPrices([{
        coinPair: 'BTC/USD',
        price: '100.00000000'
      }]);
      oracleConsensusClampReferenceWritersItemSuite1Oc.updateLastFinalizedPrices([{
        coinPair: 'BTC/USD',
        price: '50.00000000'
      }]);
      expect(oracleConsensusClampReferenceWritersItemSuite1Oc.getLastFinalizedPrice('BTC/USD')).to.equal('50.00000000');
    });
  });
}
function registerOracleConsensusClampReferenceWritersItemSuite1Part4() {
  describe('periodic re-seed', function () {
    it('picks up a finalized round this process never stored', async function () {
      oracleConsensusClampReferenceWritersItemSuite1Oc.updateLastFinalizedPrices([{
        coinPair: 'BTC/USD',
        price: '100.00000000'
      }], 1);
      oracleConsensusClampReferenceWritersItemSuite1Hub.db.doQuery = sinon.stub().resolves([{
        coin_pair: 'BTC/USD',
        price: '200.00000000',
        round_number: 7
      }]);
      await oracleConsensusClampReferenceWritersItemSuite1Oc.seedLastFinalizedPrices({
        quiet: true
      });
      expect(oracleConsensusClampReferenceWritersItemSuite1Oc.getLastFinalizedPrice('BTC/USD')).to.equal('200.00000000');
      expect(oracleConsensusClampReferenceWritersItemSuite1Oc.clampToLastFinalized('BTC/USD', '260.00000000')).to.equal('250.00000000');
    });
    it('a failed read keeps the previous reference and never throws', async function () {
      oracleConsensusClampReferenceWritersItemSuite1Oc.updateLastFinalizedPrices([{
        coinPair: 'BTC/USD',
        price: '100.00000000'
      }], 1);
      oracleConsensusClampReferenceWritersItemSuite1Hub.db.doQuery = sinon.stub().rejects(new Error('db down'));
      await oracleConsensusClampReferenceWritersItemSuite1Oc.seedLastFinalizedPrices({
        quiet: true
      });
      expect(oracleConsensusClampReferenceWritersItemSuite1Oc.getLastFinalizedPrice('BTC/USD')).to.equal('100.00000000');
    });
    it('an empty read does not clear the cache, so no pair goes unclamped', async function () {
      oracleConsensusClampReferenceWritersItemSuite1Oc.updateLastFinalizedPrices([{
        coinPair: 'BTC/USD',
        price: '100.00000000'
      }], 1);
      oracleConsensusClampReferenceWritersItemSuite1Hub.db.doQuery = sinon.stub().resolves([]);
      await oracleConsensusClampReferenceWritersItemSuite1Oc.seedLastFinalizedPrices({
        quiet: true
      });
      expect(oracleConsensusClampReferenceWritersItemSuite1Oc.getLastFinalizedPrice('BTC/USD')).to.equal('100.00000000');
    });
    it('start() arms the re-seed timer and stop() clears it', async function () {
      oracleConsensusClampReferenceWritersItemSuite1Hub.db.doQuery = sinon.stub().resolves([]);
      await oracleConsensusClampReferenceWritersItemSuite1Oc.start();
      expect(oracleConsensusClampReferenceWritersItemSuite1Oc._reseedTimer).to.not.equal(null);
      await oracleConsensusClampReferenceWritersItemSuite1Oc.stop();
      expect(oracleConsensusClampReferenceWritersItemSuite1Oc._reseedTimer).to.equal(null);
    });
  });
}
describe('OracleConsensus clamp-reference writers (item 5834)', function () {
  registerOracleConsensusClampReferenceWritersItemSuite1Part1.call(this);
  registerOracleConsensusClampReferenceWritersItemSuite1Part2.call(this);
  registerOracleConsensusClampReferenceWritersItemSuite1Part3.call(this);
  registerOracleConsensusClampReferenceWritersItemSuite1Part4.call(this);
});
