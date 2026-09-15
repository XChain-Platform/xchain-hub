'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.
//
// LOST-ROUND WATCHDOG: a price round that opens on this hub and then
// never finalizes must leave a durable 'skipped' record here, not just on
// whichever hub happened to take a store-skipped branch. Testnet rounds 25-27
// (2026-08-28) finalized nothing anywhere yet only ONE of five validators held
// any row for them, so the federation could not even agree the rounds had
// happened. Every seat that observed the round open now arms an abandonment
// watchdog, so round presence is a fact every hub records.
const sinon = require('sinon');
const {
  expect
} = require('chai');
const OracleConsensus = require('../../../../src/oracle/consensus');
const {
  createMockHub
} = require('../../../helpers/mockHub');
const {
  VALIDATORS_3,
  buildSubmissions
} = require('../../../helpers/fixtures');
function registryFor(validators) {
  let m = new Map();
  for (let v of validators) m.set(v.addr, v.pubkey);
  return m;
}
function snapshotOf(validators, blockIndex) {
  return {
    capability: 'price',
    blockIndex: blockIndex,
    count: validators.length,
    validators: validators.map(v => ({
      pubkey: v.pubkey,
      amount: '100'
    }))
  };
}
const PRICES = [{
  coinPair: 'BTC/USD',
  price: '100000'
}];

// Round 3 over the 3-member snapshot elects v1 (sorted pubkeys, 3 % 3 = 0).
const ROUND = 3;
const HEIGHT = 100;
const TIME = 1700000000;
let oracleConsensusALostRoundIsDurablyRecordedSuite1Hub, oracleConsensusALostRoundIsDurablyRecordedSuite1Pm, oracleConsensusALostRoundIsDurablyRecordedSuite1Oc, oracleConsensusALostRoundIsDurablyRecordedSuite1OracleRound, oracleConsensusALostRoundIsDurablyRecordedSuite1Clock, oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped;

// Seat this hub as `me` (a member of VALIDATORS_3) and give the round a
// full submission set, so finalizeRound reaches the leader election rather
// than an early store-skipped branch.
function oracleConsensusALostRoundIsDurablyRecordedSuite1Seat(me) {
  oracleConsensusALostRoundIsDurablyRecordedSuite1Hub = createMockHub();
  oracleConsensusALostRoundIsDurablyRecordedSuite1Pm = oracleConsensusALostRoundIsDurablyRecordedSuite1Hub._peerManager;
  oracleConsensusALostRoundIsDurablyRecordedSuite1Pm.validatorAddr = me.addr;
  oracleConsensusALostRoundIsDurablyRecordedSuite1Pm.validatorPubkeys = registryFor(VALIDATORS_3);
  oracleConsensusALostRoundIsDurablyRecordedSuite1Hub._identity.getPubkeyHex.returns(me.pubkey);
  oracleConsensusALostRoundIsDurablyRecordedSuite1Hub.capabilitySnapshot = {
    getSnapshot: sinon.stub().resolves(snapshotOf(VALIDATORS_3, HEIGHT)),
    getWeightSnapshot: sinon.stub().resolves(null),
    getQuorum: sinon.stub().returns(2)
  };
  oracleConsensusALostRoundIsDurablyRecordedSuite1OracleRound = {
    getSubmissions: sinon.stub().returns(buildSubmissions(VALIDATORS_3.map(v => ({
      sender: v.addr,
      prices: PRICES
    })))),
    priceFetcher: null
  };
  oracleConsensusALostRoundIsDurablyRecordedSuite1Oc = new OracleConsensus(oracleConsensusALostRoundIsDurablyRecordedSuite1Hub, oracleConsensusALostRoundIsDurablyRecordedSuite1OracleRound);
  oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.setValidatorSet(VALIDATORS_3);
  oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped = sinon.spy(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc, 'storeSkippedRound');
}

// Advance past every timer the round arms (leader timeout, fallback grace,
// finalization timeout, watchdog grace) and let the async skip store settle.
async function oracleConsensusALostRoundIsDurablyRecordedSuite1AbandonRound() {
  await oracleConsensusALostRoundIsDurablyRecordedSuite1Clock.tickAsync(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.roundAbandonMs() + 1000);
  await Promise.resolve();
}
function registerOracleConsensusALostRoundIsDurablyRecordedSuite1Part1() {
  beforeEach(function () {
    oracleConsensusALostRoundIsDurablyRecordedSuite1Clock = sinon.useFakeTimers({
      now: TIME * 1000,
      shouldAdvanceTime: false
    });
  });
  afterEach(function () {
    oracleConsensusALostRoundIsDurablyRecordedSuite1Clock.restore();
    sinon.restore();
  });
  it('a follower that is neither leader nor fallback records the lost round', async function () {
    // v3: the snapshot leader (v1) submitted and is expected to propose, and
    // v2 (not v3) is the elected fallback. Before this fix this seat returned
    // from finalizeRound with no timer and no row: the round vanished here.
    oracleConsensusALostRoundIsDurablyRecordedSuite1Seat(VALIDATORS_3[2]);
    await oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.finalizeRound(ROUND, HEIGHT, TIME);
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped.called, 'nothing durable yet, the round is still live').to.be.false;
    await oracleConsensusALostRoundIsDurablyRecordedSuite1AbandonRound();
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped.calledOnce, 'the watchdog stored a skipped round').to.be.true;
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.locallySkipped.has(ROUND)).to.be.true;
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.finalized.has(ROUND)).to.be.false;
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Hub.db.doQuery.called).to.be.true;
  });
  it('the elected fallback records the lost round when its own PROPOSE never commits', async function () {
    // v2 is the fallback for round 3 (lowest addr other than leader v1). Its
    // leader-timeout fires, it proposes, and the PROPOSE never reaches commit
    // quorum: without the watchdog, the pending timer evicts the round in silence.
    oracleConsensusALostRoundIsDurablyRecordedSuite1Seat(VALIDATORS_3[1]);
    await oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.finalizeRound(ROUND, HEIGHT, TIME);
    await oracleConsensusALostRoundIsDurablyRecordedSuite1AbandonRound();
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped.calledOnce).to.be.true;
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.locallySkipped.has(ROUND)).to.be.true;
  });
  it('the leader records the lost round when its own PROPOSE never commits', async function () {
    oracleConsensusALostRoundIsDurablyRecordedSuite1Seat(VALIDATORS_3[0]);
    await oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.finalizeRound(ROUND, HEIGHT, TIME);
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Pm.broadcast.calledOnce, 'the leader proposed').to.be.true;
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped.called).to.be.false;
    await oracleConsensusALostRoundIsDurablyRecordedSuite1AbandonRound();
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped.calledOnce).to.be.true;
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.locallySkipped.has(ROUND)).to.be.true;
  });
}
function registerOracleConsensusALostRoundIsDurablyRecordedSuite1Part2() {
  it('a round that finalizes normally never gets a watchdog skip', async function () {
    oracleConsensusALostRoundIsDurablyRecordedSuite1Seat(VALIDATORS_3[2]);
    await oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.finalizeRound(ROUND, HEIGHT, TIME);
    // The federation finalized while the watchdog was armed.
    sinon.stub(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc, 'storeSnapshot').resolves();
    oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.pendingRounds.set(ROUND, {
      prepares: new Set(['a', 'b', 'c']),
      commits: new Set(['a', 'b', 'c']),
      signatures: new Map(),
      prices: PRICES,
      btcBlockHeight: HEIGHT,
      btcBlockTime: TIME,
      finalized: true
    });
    await oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.finalizeCommittedRound(ROUND);
    await oracleConsensusALostRoundIsDurablyRecordedSuite1AbandonRound();
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped.called, 'a finalized round is never re-skipped').to.be.false;
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.roundWatchdogs.has(ROUND), 'the watchdog was disarmed').to.be.false;
  });
  it('a round already stored as skipped does not arm a second watchdog', async function () {
    oracleConsensusALostRoundIsDurablyRecordedSuite1Seat(VALIDATORS_3[2]);
    // No submissions at all -> finalizeRound stores the skip immediately.
    oracleConsensusALostRoundIsDurablyRecordedSuite1OracleRound.getSubmissions.returns(new Map());
    await oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.finalizeRound(ROUND, HEIGHT, TIME);
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped.calledOnce).to.be.true;
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.roundWatchdogs.has(ROUND)).to.be.false;
    await oracleConsensusALostRoundIsDurablyRecordedSuite1AbandonRound();
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped.calledOnce, 'still exactly one skip store').to.be.true;
  });
  it('a hub that only ever saw the round via gossip records it too', async function () {
    // This seat's own finalizeRound never ran (its round scheduler missed the
    // boundary); the round exists here only because a PROPOSE opened it.
    oracleConsensusALostRoundIsDurablyRecordedSuite1Seat(VALIDATORS_3[2]);
    await oracleConsensusALostRoundIsDurablyRecordedSuite1Oc._handlePropose({
      sender: VALIDATORS_3[0].addr,
      sig_pubkey: VALIDATORS_3[0].pubkey,
      data: {
        round: ROUND,
        prices: PRICES,
        digest: oracleConsensusALostRoundIsDurablyRecordedSuite1Oc._digest(ROUND, PRICES),
        btcBlockHeight: HEIGHT,
        btcBlockTime: TIME
      }
    });
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.pendingRounds.has(ROUND), 'the PROPOSE opened the round').to.be.true;
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.roundWatchdogs.has(ROUND), 'and armed the watchdog').to.be.true;
    await oracleConsensusALostRoundIsDurablyRecordedSuite1AbandonRound();
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped.calledOnce).to.be.true;
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.locallySkipped.has(ROUND)).to.be.true;
  });
}
function registerOracleConsensusALostRoundIsDurablyRecordedSuite1Part3() {
  it('the skip reason names the abandonment so operators can tell it apart', async function () {
    oracleConsensusALostRoundIsDurablyRecordedSuite1Seat(VALIDATORS_3[2]);
    await oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.finalizeRound(ROUND, HEIGHT, TIME);
    await oracleConsensusALostRoundIsDurablyRecordedSuite1AbandonRound();
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped.firstCall.args[3]).to.match(/abandoned/i);
    // The round keeps its real BTC anchor, not a fresh one: every hub writes
    // the same reference_block for the round so the rows are comparable.
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped.firstCall.args[1]).to.equal(HEIGHT);
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped.firstCall.args[2]).to.equal(TIME);
  });
  it('counts the abandonment, so a hub losing rounds is legible without a DB query', async function () {
    oracleConsensusALostRoundIsDurablyRecordedSuite1Seat(VALIDATORS_3[2]);
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc._abandonedRounds).to.equal(0);
    await oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.finalizeRound(ROUND, HEIGHT, TIME);
    await oracleConsensusALostRoundIsDurablyRecordedSuite1AbandonRound();
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc._abandonedRounds).to.equal(1);
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc._lastAbandonedRound).to.equal(ROUND);
    // The follower seat holds no pending round, so the PBFT timeout counter
    // never moves for it: this is the counter that sees the failure at all.
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc._roundTimeouts || 0).to.equal(0);
  });
  it('stop() disarms armed watchdogs, recording the open round once and never again', async function () {
    oracleConsensusALostRoundIsDurablyRecordedSuite1Seat(VALIDATORS_3[2]);
    await oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.finalizeRound(ROUND, HEIGHT, TIME);
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.roundWatchdogs.size).to.equal(1);
    await oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.stop();
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Oc.roundWatchdogs.size).to.equal(0);
    // stop() writes the skipped row itself, so a restart between open and
    // finalize leaves a record before the process is gone...
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped.calledOnce, 'stop() records the in-flight round').to.be.true;
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped.firstCall.args[3]).to.match(/stopped/);
    // ...and the disarmed watchdog never fires afterwards.
    await oracleConsensusALostRoundIsDurablyRecordedSuite1AbandonRound();
    expect(oracleConsensusALostRoundIsDurablyRecordedSuite1Skipped.calledOnce, 'a stopped engine writes nothing more').to.be.true;
  });
}
describe('OracleConsensus: a lost round is durably recorded on every hub', function () {
  registerOracleConsensusALostRoundIsDurablyRecordedSuite1Part1.call(this);
  registerOracleConsensusALostRoundIsDurablyRecordedSuite1Part2.call(this);
  registerOracleConsensusALostRoundIsDurablyRecordedSuite1Part3.call(this);
});
