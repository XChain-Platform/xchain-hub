'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const sinon = require('sinon');
const { expect } = require('chai');
const OracleConsensus = require('../../../../../src/oracle/consensus');
const { createMockHub } = require('../../../../helpers/mockHub');

const CURRENT_ROUND = 130955;
const CLEAN_XCHAIN = '0.80744460';
const POISON_XCHAIN = '2.00000000';
const ROUND_INTERVAL_MS = 600000;

function snapshotRow(pair, price, round, referenceBlock) {
  return {
    coin_pair: pair,
    price,
    round_number: round,
    reference_block: referenceBlock,
    status: 'finalized'
  };
}

function latestPerPair(rows, belowRound) {
  const eligible = rows.filter(row => belowRound === undefined || row.round_number < belowRound);
  const latest = new Map();
  for (const row of eligible) {
    const known = latest.get(row.coin_pair);
    if (!known || row.round_number > known.round_number) latest.set(row.coin_pair, row);
  }
  return [...latest.values()];
}

function serveSnapshotRows(hub, rowsNow) {
  hub.db.doQuery.callsFake((sql, params) => {
    const bounded = sql.includes('round_number < ?');
    return latestPerPair(rowsNow(), bounded ? Number(params[0]) : undefined);
  });
}

// An OracleRound double whose wall-clock schedule sits mid-way through `round`
// while its tick-held round reads `tickRound` (0 before the first tick).
function scheduleAt(round, tickRound = 0) {
  return {
    roundInterval: ROUND_INTERVAL_MS,
    epochStart: Date.now() - (round + 0.5) * ROUND_INTERVAL_MS,
    getCurrentRound: sinon.stub().returns(tickRound),
    getSubmissions: sinon.stub().returns(new Map())
  };
}

function poisonedRows() {
  return [
    snapshotRow('XCHAIN/USD', CLEAN_XCHAIN, 130954, 8769),
    snapshotRow('XCHAIN/USD', POISON_XCHAIN, 888100011, 0),
    snapshotRow('BTC/USD', '65000.00000000', 130954, 8769),
    snapshotRow('BTC/USD', '100000.00000000', 888100012, 0)
  ];
}

// Captures the reseed timer callback instead of arming a real interval.
function captureReseedTick() {
  const captured = {};
  sinon.stub(global, 'setInterval').callsFake(callback => {
    captured.tick = callback;
    return { unref() {} };
  });
  sinon.stub(global, 'clearInterval');
  return captured;
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

function registerRoundAlignedRefresh() {
  describe('round-aligned refresh', function () {
    it('drops future cache entries and seeds the latest finalized row below the judged round', async function () {
      const hub = createMockHub();
      const oc = new OracleConsensus(hub, { getSubmissions: sinon.stub().returns(new Map()) });
      const rows = poisonedRows();
      serveSnapshotRows(hub, () => rows);

      await oc.seedLastFinalizedPrices();
      expect(oc.getLastFinalizedPrice('XCHAIN/USD')).to.equal(POISON_XCHAIN);

      await oc.refreshLastFinalizedForRound(CURRENT_ROUND);

      expect(oc.getLastFinalizedPrice('XCHAIN/USD')).to.equal(CLEAN_XCHAIN);
      expect(oc.lastFinalizedRoundFor('XCHAIN/USD')).to.equal(130954);
      expect(oc.getLastFinalizedPrice('BTC/USD')).to.equal('65000.00000000');
      expect(oc.clampToLastFinalized('XCHAIN/USD', CLEAN_XCHAIN, true)).to.equal(CLEAN_XCHAIN);

      expect(oc.noteFinalizedPrice('XCHAIN/USD', '0.90000000', CURRENT_ROUND)).to.equal(true);
      expect(oc.getLastFinalizedPrice('XCHAIN/USD')).to.equal('0.90000000');
      expect(oc.lastFinalizedRoundFor('XCHAIN/USD')).to.equal(CURRENT_ROUND);
    });

    it('a follower whose round tick is held in flight still takes the previous round as reference', async function () {
      // Wall clock is in round 105, the tick still reads 100, and peers finalized 101 to 104.
      const hub = createMockHub();
      const oc = new OracleConsensus(hub, scheduleAt(105, 100));
      const rows = [snapshotRow('XCHAIN/USD', '0.50000000', 100, 1)];
      serveSnapshotRows(hub, () => rows);
      await oc.seedLastFinalizedPrices();
      for (const [round, price] of [[101, '0.51000000'], [102, '0.52000000'], [103, '0.53000000'], [104, '0.80000000']]) {
        rows.push(snapshotRow('XCHAIN/USD', price, round, 1));
        expect(oc.noteIngestedPriceRow(snapshotRow('XCHAIN/USD', price, round, 1))).to.equal(true);
      }

      await oc.refreshLastFinalizedForRound(105);

      expect(oc.getLastFinalizedPrice('XCHAIN/USD')).to.equal('0.80000000');
      expect(oc.clampToLastFinalized('XCHAIN/USD', '0.80000000', true)).to.equal('0.80000000');
    });
  });
}

function registerPeriodicReseed() {
  describe('periodic reseed', function () {
    it('keeps the periodic reseed below the current oracle round', async function () {
      const hub = createMockHub();
      let rows = poisonedRows().filter(row => row.round_number < CURRENT_ROUND);
      const oc = new OracleConsensus(hub, scheduleAt(CURRENT_ROUND));
      serveSnapshotRows(hub, () => rows);
      const reseed = captureReseedTick();

      await oc.start();
      expect(oc.getLastFinalizedPrice('XCHAIN/USD')).to.equal(CLEAN_XCHAIN);
      rows = poisonedRows();
      hub.db.doQuery.resetHistory();

      reseed.tick();
      await settle();

      expect(oc.getLastFinalizedPrice('XCHAIN/USD')).to.equal(CLEAN_XCHAIN);
      expect(hub.db.doQuery.calledOnce).to.equal(true);
      expect(hub.db.doQuery.firstCall.args[0]).to.include('round_number < ?');
      expect(hub.db.doQuery.firstCall.args[1]).to.deep.equal([CURRENT_ROUND]);
      await oc.stop();
    });

    it('runs before the first round tick and carries a new row forward', async function () {
      const hub = createMockHub();
      const rows = [snapshotRow('XCHAIN/USD', '0.50000000', CURRENT_ROUND - 2, 1)];
      const oc = new OracleConsensus(hub, scheduleAt(CURRENT_ROUND));
      serveSnapshotRows(hub, () => rows);
      const reseed = captureReseedTick();

      await oc.start();
      rows.push(snapshotRow('XCHAIN/USD', CLEAN_XCHAIN, CURRENT_ROUND - 1, 1));
      reseed.tick();
      await settle();

      expect(oc.getLastFinalizedPrice('XCHAIN/USD')).to.equal(CLEAN_XCHAIN);
      await oc.stop();
    });
  });
}

function registerCleanDatabaseEquivalence() {
  describe('clean database equivalence', function () {
    it('matches the prior unbounded reference and clamp for a clean database', async function () {
      const oldHub = createMockHub();
      const alignedHub = createMockHub();
      const oldPath = new OracleConsensus(oldHub, { getSubmissions: sinon.stub().returns(new Map()) });
      const alignedPath = new OracleConsensus(alignedHub, scheduleAt(102));
      const rows = [snapshotRow('XCHAIN/USD', '0.80000000', 100, 8000)];
      serveSnapshotRows(oldHub, () => rows);
      serveSnapshotRows(alignedHub, () => rows);

      await oldPath.seedLastFinalizedPrices();
      await alignedPath.seedLastFinalizedPrices();
      for (const step of [
        { finalized: 101, judged: 102, price: '0.81000000', candidate: '0.83000000' },
        { finalized: 102, judged: 103, price: '0.82000000', candidate: '1.50000000' }
      ]) {
        rows.push(snapshotRow('XCHAIN/USD', step.price, step.finalized, 8000 + step.finalized));
        await oldPath.seedLastFinalizedPrices({ quiet: true });
        await alignedPath.refreshLastFinalizedForRound(step.judged);
        expect(alignedPath.getLastFinalizedPrice('XCHAIN/USD'))
          .to.equal(oldPath.getLastFinalizedPrice('XCHAIN/USD'));
        expect(alignedPath.clampToLastFinalized('XCHAIN/USD', step.candidate, true))
          .to.equal(oldPath.clampToLastFinalized('XCHAIN/USD', step.candidate, true));
      }
    });
  });
}

describe('OracleConsensus poisoned clamp-reference rows', function () {
  afterEach(function () {
    sinon.restore();
  });
  registerRoundAlignedRefresh();
  registerPeriodicReseed();
  registerCleanDatabaseEquivalence();
});
