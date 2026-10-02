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
// item 4459 WATERMARK-OVERTAKE GUARD: the post-commit row broadcast used to swallow
// a failed re-read of the finalized round. The watermark heartbeat runs on its own
// wall-clock timer and would then certify the stream complete through an instant past
// a round no subscriber ever received, and the consumer's only gap repair (the max_ids
// catch-up inside its bootstrap) runs at connect time, so nothing on a healthy socket
// ever refilled it. A dropped broadcast must therefore force subscribers to resync.
const sinon = require('sinon');
const {
  expect
} = require('chai');
const OracleConsensus = require('../../../../src/oracle/consensus');
const {
  createMockHub
} = require('../../../helpers/mockHub');
const oracleConsensusPostCommitPriceBroadcastGapSuite1ROUND = 41;
const oracleConsensusPostCommitPriceBroadcastGapSuite1PRICES = [{
  coinPair: 'BTC/USD',
  price: '100000'
}];
let oracleConsensusPostCommitPriceBroadcastGapSuite1Hub, oracleConsensusPostCommitPriceBroadcastGapSuite1Oc, oracleConsensusPostCommitPriceBroadcastGapSuite1Broadcaster;
function oracleConsensusPostCommitPriceBroadcastGapSuite1IsRoundSelect(sql) {
  return typeof sql === 'string' && /SELECT \* FROM price_snapshots/.test(sql);
}
function registerOracleConsensusPostCommitPriceBroadcastGapSuite1Part1() {
  beforeEach(function () {
    oracleConsensusPostCommitPriceBroadcastGapSuite1Hub = createMockHub();
    oracleConsensusPostCommitPriceBroadcastGapSuite1Broadcaster = {
      broadcastRow: sinon.stub(),
      dropAllForResync: sinon.stub().returns(1)
    };
    oracleConsensusPostCommitPriceBroadcastGapSuite1Hub.hubDbBroadcaster = oracleConsensusPostCommitPriceBroadcastGapSuite1Broadcaster;
    oracleConsensusPostCommitPriceBroadcastGapSuite1Oc = new OracleConsensus(oracleConsensusPostCommitPriceBroadcastGapSuite1Hub, {
      getSubmissions: sinon.stub().returns(new Map())
    });
    sinon.stub(console, 'error');
    sinon.stub(console, 'warn');
  });
  afterEach(function () {
    sinon.restore();
  });
  it('broadcasts each finalized row and does not resync when the re-read succeeds', async function () {
    oracleConsensusPostCommitPriceBroadcastGapSuite1Oc.db.doQuery.callsFake(async sql => oracleConsensusPostCommitPriceBroadcastGapSuite1IsRoundSelect(sql) ? [{
      id: 1,
      round_number: oracleConsensusPostCommitPriceBroadcastGapSuite1ROUND,
      coin_pair: 'BTC/USD'
    }] : []);
    await oracleConsensusPostCommitPriceBroadcastGapSuite1Oc.storeSnapshot(oracleConsensusPostCommitPriceBroadcastGapSuite1ROUND, oracleConsensusPostCommitPriceBroadcastGapSuite1PRICES, 3, '[]', 900001, 1700000000);
    expect(oracleConsensusPostCommitPriceBroadcastGapSuite1Broadcaster.broadcastRow.calledOnce).to.be.true;
    expect(oracleConsensusPostCommitPriceBroadcastGapSuite1Broadcaster.broadcastRow.firstCall.args[0].table).to.equal('price_snapshots');
    expect(oracleConsensusPostCommitPriceBroadcastGapSuite1Broadcaster.dropAllForResync.called).to.be.false;
  });
  it('forces a subscriber resync when the post-commit re-read fails', async function () {
    oracleConsensusPostCommitPriceBroadcastGapSuite1Oc.db.doQuery.callsFake(async sql => {
      if (oracleConsensusPostCommitPriceBroadcastGapSuite1IsRoundSelect(sql)) throw new Error('connection reset');
      return [];
    });
    await oracleConsensusPostCommitPriceBroadcastGapSuite1Oc.storeSnapshot(oracleConsensusPostCommitPriceBroadcastGapSuite1ROUND, oracleConsensusPostCommitPriceBroadcastGapSuite1PRICES, 3, '[]', 900001, 1700000000);
    expect(oracleConsensusPostCommitPriceBroadcastGapSuite1Broadcaster.broadcastRow.called, 'no row reached a subscriber').to.be.false;
    expect(oracleConsensusPostCommitPriceBroadcastGapSuite1Broadcaster.dropAllForResync.calledOnce, 'subscribers dropped for resync').to.be.true;
    expect(oracleConsensusPostCommitPriceBroadcastGapSuite1Broadcaster.dropAllForResync.firstCall.args[0]).to.equal('price-round broadcast gap');
    expect(console.error.called, 'the drop is logged, not swallowed').to.be.true;
  });
  it('never fails the finalized write when the resync repair itself throws', async function () {
    oracleConsensusPostCommitPriceBroadcastGapSuite1Oc.db.doQuery.callsFake(async sql => {
      if (oracleConsensusPostCommitPriceBroadcastGapSuite1IsRoundSelect(sql)) throw new Error('connection reset');
      return [];
    });
    oracleConsensusPostCommitPriceBroadcastGapSuite1Broadcaster.dropAllForResync.throws(new Error('broadcaster gone'));

    // Resolves rather than rejecting: finalizeCommittedRound treats a throw here as a
    // store failure and would retain + retry an already-durable round.
    await oracleConsensusPostCommitPriceBroadcastGapSuite1Oc.storeSnapshot(oracleConsensusPostCommitPriceBroadcastGapSuite1ROUND, oracleConsensusPostCommitPriceBroadcastGapSuite1PRICES, 3, '[]', 900001, 1700000000);
    expect(oracleConsensusPostCommitPriceBroadcastGapSuite1Broadcaster.dropAllForResync.calledOnce).to.be.true;
  });
}
describe('OracleConsensus: post-commit price broadcast gap (#4459)', function () {
  registerOracleConsensusPostCommitPriceBroadcastGapSuite1Part1.call(this);
});

// The skipped-round writer feeds the same mirrored price_snapshots table, so its
// post-commit re-read takes the same resync repair as the finalized path.
describe('OracleConsensus: post-commit skipped-round broadcast gap', function () {
  const ROUND = 42;
  let hub, oc, b;
  function failRoundSelect() {
    oc.db.doQuery.callsFake(async sql => {
      if (oracleConsensusPostCommitPriceBroadcastGapSuite1IsRoundSelect(sql)) throw new Error('connection reset');
      return [];
    });
  }
  beforeEach(function () {
    hub = createMockHub();
    b = { broadcastRow: sinon.stub(), dropAllForResync: sinon.stub().returns(1) };
    hub.hubDbBroadcaster = b;
    oc = new OracleConsensus(hub, { getSubmissions: sinon.stub().returns(new Map()) });
    sinon.stub(console, 'error');
    sinon.stub(console, 'warn');
  });
  afterEach(function () {
    sinon.restore();
  });
  it('broadcasts each skipped row and does not resync when the re-read succeeds', async function () {
    oc.db.doQuery.callsFake(async sql => oracleConsensusPostCommitPriceBroadcastGapSuite1IsRoundSelect(sql)
      ? [{ id: 7, round_number: ROUND, coin_pair: 'BTC/USD', status: 'skipped' }] : []);
    await oc.storeSkippedRound(ROUND, 900001, 1700000000, 'no submissions');
    expect(b.broadcastRow.calledOnce).to.be.true;
    expect(b.broadcastRow.firstCall.args[0].table).to.equal('price_snapshots');
    expect(b.dropAllForResync.called).to.be.false;
  });
  it('forces a subscriber resync and logs when the skipped-round re-read fails', async function () {
    failRoundSelect();
    await oc.storeSkippedRound(ROUND, 900001, 1700000000, 'no submissions');
    expect(b.broadcastRow.called, 'no row reached a subscriber').to.be.false;
    expect(b.dropAllForResync.calledOnce, 'subscribers dropped for resync').to.be.true;
    expect(b.dropAllForResync.firstCall.args[0]).to.equal('price-round broadcast gap');
    expect(console.error.called, 'the drop is logged, not swallowed').to.be.true;
  });
  it('still marks the round locally skipped when the resync repair itself throws', async function () {
    failRoundSelect();
    b.dropAllForResync.throws(new Error('broadcaster gone'));
    await oc.storeSkippedRound(ROUND, 900001, 1700000000, 'no submissions');
    expect(b.dropAllForResync.calledOnce).to.be.true;
    expect(oc._locallySkippedOrder).to.include(ROUND);
  });
});
