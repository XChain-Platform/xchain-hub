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
// Finding F7 (standing-federation Phase 1, 2026-06-11): PREPARE/COMMIT
// arrives before this hub's pendingRounds entry exists, and gets silently
// dropped. handlePropose awaits the block-boundary snapshot fetch, and
// the whole PBFT burst completes inside that window. The hub then never
// reached commit quorum locally and the round vanished from its
// price_snapshots even though the federation finalized. These tests pin
// the early-message buffer that fixes it.
const sinon = require('sinon');
const {
  expect
} = require('chai');
const OracleConsensus = require('../../../../src/oracle/consensus');
const {
  createMockHub
} = require('../../../helpers/mockHub');
const {
  pubkeyForTestSender,
  makeCapabilitySnapshotStub
} = require('../../../helpers/fixtures');
let oracleConsensusEarlyMessageBufferForF7Suite1Hub, oracleConsensusEarlyMessageBufferForF7Suite1Pm, oracleConsensusEarlyMessageBufferForF7Suite1Oc, oracleConsensusEarlyMessageBufferForF7Suite1OracleRound;
// Each entry needs its signing key: votes are tallied by key, so a validator
// with no key casts nothing.
const oracleConsensusEarlyMessageBufferForF7Suite1VALSET = [{
  addr: 'ws://val-a:10001',
  pubkey: 'a1'.repeat(32)
}, {
  addr: 'ws://val-b:10002',
  pubkey: 'b2'.repeat(32)
}, {
  addr: 'ws://val-c:10003',
  pubkey: 'c3'.repeat(32)
}];
// round % 3 === 0 → leader is VALSET[0]
const oracleConsensusEarlyMessageBufferForF7Suite1ROUND = 300;
const oracleConsensusEarlyMessageBufferForF7Suite1PRICES = [{
  coinPair: 'BTC/USD',
  price: '100.00000000'
}];
function oracleConsensusEarlyMessageBufferForF7Suite1ProposeEnvelope(digest) {
  return {
    type: 'ORACLE_PROPOSE',
    sender: oracleConsensusEarlyMessageBufferForF7Suite1VALSET[0].addr,
    sig_pubkey: oracleConsensusEarlyMessageBufferForF7Suite1VALSET[0].pubkey,
    data: {
      round: oracleConsensusEarlyMessageBufferForF7Suite1ROUND,
      prices: oracleConsensusEarlyMessageBufferForF7Suite1PRICES,
      digest,
      btcBlockHeight: 1000,
      btcBlockTime: 1700000000
    }
  };
}
function oracleConsensusEarlyMessageBufferForF7Suite1VoteEnvelope(type, sender, digest) {
  let v = oracleConsensusEarlyMessageBufferForF7Suite1VALSET.find(x => x.addr === sender);
  // Senders outside VALSET (the flood case) still need a distinct admissible
  // key: the buffer cap only has something to cap once a vote is countable.
  return {
    type,
    sender,
    sig_pubkey: v ? v.pubkey : pubkeyForTestSender(sender),
    data: {
      round: oracleConsensusEarlyMessageBufferForF7Suite1ROUND,
      digest
    }
  };
}
function registerOracleConsensusEarlyMessageBufferForF7Suite1Part1() {
  beforeEach(function () {
    oracleConsensusEarlyMessageBufferForF7Suite1Hub = createMockHub({
      validatorAddr: oracleConsensusEarlyMessageBufferForF7Suite1VALSET[1].addr
    }); // we are val-b (follower)
    // The follower bounds the leader-stamped btcBlockHeight against its own BTC
    // tip, which a real federated hub always has. Same height the PROPOSE carries.
    oracleConsensusEarlyMessageBufferForF7Suite1Hub.resolveBtcLatestBlock = sinon.stub().resolves(1000);
    oracleConsensusEarlyMessageBufferForF7Suite1Pm = oracleConsensusEarlyMessageBufferForF7Suite1Hub._peerManager;
    oracleConsensusEarlyMessageBufferForF7Suite1OracleRound = {
      getSubmissions: sinon.stub().returns(new Map())
    };
    // A federated hub refuses a round with no deterministic capability snapshot, so the
    // harness models one over the same validators: these cases are about something else,
    // not about the snapshot being unreachable.
    oracleConsensusEarlyMessageBufferForF7Suite1Hub.capabilitySnapshot = makeCapabilitySnapshotStub(oracleConsensusEarlyMessageBufferForF7Suite1VALSET);
    oracleConsensusEarlyMessageBufferForF7Suite1Oc = new OracleConsensus(oracleConsensusEarlyMessageBufferForF7Suite1Hub, oracleConsensusEarlyMessageBufferForF7Suite1OracleRound);
    oracleConsensusEarlyMessageBufferForF7Suite1Oc.setValidatorSet(oracleConsensusEarlyMessageBufferForF7Suite1VALSET);
    // Finalized history for the proposed pair so the unverifiable-pair
    // co-sign gate stays out of the way; buffering mechanics are under test.
    oracleConsensusEarlyMessageBufferForF7Suite1Oc._lastFinalizedPrices = new Map([['BTC/USD', '100.00000000']]);
  });
  afterEach(function () {
    oracleConsensusEarlyMessageBufferForF7Suite1Oc.stop();
    sinon.restore();
  });
  it('buffers a PREPARE that arrives before any pending round exists', function () {
    let digest = oracleConsensusEarlyMessageBufferForF7Suite1Oc.digest(oracleConsensusEarlyMessageBufferForF7Suite1ROUND, oracleConsensusEarlyMessageBufferForF7Suite1PRICES);
    oracleConsensusEarlyMessageBufferForF7Suite1Oc.handlePrepare(oracleConsensusEarlyMessageBufferForF7Suite1VoteEnvelope('ORACLE_PREPARE', oracleConsensusEarlyMessageBufferForF7Suite1VALSET[2].addr, digest));
    expect(oracleConsensusEarlyMessageBufferForF7Suite1Oc.pendingRounds.has(oracleConsensusEarlyMessageBufferForF7Suite1ROUND)).to.be.false;
    expect(oracleConsensusEarlyMessageBufferForF7Suite1Oc.earlyMessages.get(oracleConsensusEarlyMessageBufferForF7Suite1ROUND)).to.have.length(1);
  });
  it('buffers a COMMIT that arrives before any pending round exists', function () {
    let digest = oracleConsensusEarlyMessageBufferForF7Suite1Oc.digest(oracleConsensusEarlyMessageBufferForF7Suite1ROUND, oracleConsensusEarlyMessageBufferForF7Suite1PRICES);
    oracleConsensusEarlyMessageBufferForF7Suite1Oc.handleCommit(oracleConsensusEarlyMessageBufferForF7Suite1VoteEnvelope('ORACLE_COMMIT', oracleConsensusEarlyMessageBufferForF7Suite1VALSET[2].addr, digest));
    expect(oracleConsensusEarlyMessageBufferForF7Suite1Oc.earlyMessages.get(oracleConsensusEarlyMessageBufferForF7Suite1ROUND)).to.have.length(1);
  });
  it('does NOT buffer for rounds already finalized', function () {
    let digest = oracleConsensusEarlyMessageBufferForF7Suite1Oc.digest(oracleConsensusEarlyMessageBufferForF7Suite1ROUND, oracleConsensusEarlyMessageBufferForF7Suite1PRICES);
    oracleConsensusEarlyMessageBufferForF7Suite1Oc.finalized.add(oracleConsensusEarlyMessageBufferForF7Suite1ROUND);
    oracleConsensusEarlyMessageBufferForF7Suite1Oc.handlePrepare(oracleConsensusEarlyMessageBufferForF7Suite1VoteEnvelope('ORACLE_PREPARE', oracleConsensusEarlyMessageBufferForF7Suite1VALSET[2].addr, digest));
    expect(oracleConsensusEarlyMessageBufferForF7Suite1Oc.earlyMessages.has(oracleConsensusEarlyMessageBufferForF7Suite1ROUND)).to.be.false;
  });
  it('caps the buffer per round', function () {
    let digest = oracleConsensusEarlyMessageBufferForF7Suite1Oc.digest(oracleConsensusEarlyMessageBufferForF7Suite1ROUND, oracleConsensusEarlyMessageBufferForF7Suite1PRICES);
    for (let i = 0; i < oracleConsensusEarlyMessageBufferForF7Suite1Oc.earlyMessageMaxPerRound + 10; i++) {
      oracleConsensusEarlyMessageBufferForF7Suite1Oc.handlePrepare(oracleConsensusEarlyMessageBufferForF7Suite1VoteEnvelope('ORACLE_PREPARE', 'ws://flood-' + i + ':1', digest));
    }
    expect(oracleConsensusEarlyMessageBufferForF7Suite1Oc.earlyMessages.get(oracleConsensusEarlyMessageBufferForF7Suite1ROUND)).to.have.length(oracleConsensusEarlyMessageBufferForF7Suite1Oc.earlyMessageMaxPerRound);
  });
}
function registerOracleConsensusEarlyMessageBufferForF7Suite1Part2() {
  it('drains buffered votes into the pending round once the PROPOSE lands', async function () {
    let digest = oracleConsensusEarlyMessageBufferForF7Suite1Oc.digest(oracleConsensusEarlyMessageBufferForF7Suite1ROUND, oracleConsensusEarlyMessageBufferForF7Suite1PRICES);

    // Votes from val-c beat the proposal (the F7 race).
    oracleConsensusEarlyMessageBufferForF7Suite1Oc.handlePrepare(oracleConsensusEarlyMessageBufferForF7Suite1VoteEnvelope('ORACLE_PREPARE', oracleConsensusEarlyMessageBufferForF7Suite1VALSET[2].addr, digest));
    oracleConsensusEarlyMessageBufferForF7Suite1Oc.handleCommit(oracleConsensusEarlyMessageBufferForF7Suite1VoteEnvelope('ORACLE_COMMIT', oracleConsensusEarlyMessageBufferForF7Suite1VALSET[2].addr, digest));
    expect(oracleConsensusEarlyMessageBufferForF7Suite1Oc.earlyMessages.get(oracleConsensusEarlyMessageBufferForF7Suite1ROUND)).to.have.length(2);

    // Leader's PROPOSE arrives late.
    await oracleConsensusEarlyMessageBufferForF7Suite1Oc.handlePropose(oracleConsensusEarlyMessageBufferForF7Suite1ProposeEnvelope(digest));
    expect(oracleConsensusEarlyMessageBufferForF7Suite1Oc.earlyMessages.has(oracleConsensusEarlyMessageBufferForF7Suite1ROUND)).to.be.false; // drained
    let pending = oracleConsensusEarlyMessageBufferForF7Suite1Oc.pendingRounds.get(oracleConsensusEarlyMessageBufferForF7Suite1ROUND);
    expect(pending, 'pending round must exist').to.exist;
    expect(pending.prepares.has(oracleConsensusEarlyMessageBufferForF7Suite1VALSET[2].pubkey)).to.be.true; // replayed
    expect(pending.commits.has(oracleConsensusEarlyMessageBufferForF7Suite1VALSET[2].pubkey)).to.be.true; // replayed
  });
  it('reaches commit quorum from replayed votes alone (the missed-round scenario)', async function () {
    let digest = oracleConsensusEarlyMessageBufferForF7Suite1Oc.digest(oracleConsensusEarlyMessageBufferForF7Suite1ROUND, oracleConsensusEarlyMessageBufferForF7Suite1PRICES);

    // Both peers' COMMITs arrive while our PROPOSE handling is delayed.
    oracleConsensusEarlyMessageBufferForF7Suite1Oc.handleCommit(oracleConsensusEarlyMessageBufferForF7Suite1VoteEnvelope('ORACLE_COMMIT', oracleConsensusEarlyMessageBufferForF7Suite1VALSET[0].addr, digest));
    oracleConsensusEarlyMessageBufferForF7Suite1Oc.handleCommit(oracleConsensusEarlyMessageBufferForF7Suite1VoteEnvelope('ORACLE_COMMIT', oracleConsensusEarlyMessageBufferForF7Suite1VALSET[2].addr, digest));
    await oracleConsensusEarlyMessageBufferForF7Suite1Oc.handlePropose(oracleConsensusEarlyMessageBufferForF7Suite1ProposeEnvelope(digest));
    // checkCommitQuorum stores via async db call; let it settle.
    await new Promise(r => setImmediate(r));

    // quorum for N=3 is 2. replayed commits must finalize the round.
    expect(oracleConsensusEarlyMessageBufferForF7Suite1Oc.finalized.has(oracleConsensusEarlyMessageBufferForF7Suite1ROUND)).to.be.true;
    expect(oracleConsensusEarlyMessageBufferForF7Suite1Hub.db.doQuery.getCalls().some(c => String(c.args[0]).includes('INSERT INTO price_snapshots'))).to.be.true;
  });
  it('drains at the proposer site too (proposeRound)', function () {
    let digest = null; // computed inside proposeRound from aggregated submissions
    let subs = new Map([[oracleConsensusEarlyMessageBufferForF7Suite1VALSET[1].addr, {
      sender: oracleConsensusEarlyMessageBufferForF7Suite1VALSET[1].addr,
      prices: oracleConsensusEarlyMessageBufferForF7Suite1PRICES
    }]]);
    // Buffer a vote keyed by the round before proposing. Digest must match
    // what proposeRound computes over its own aggregation.
    let aggregated = oracleConsensusEarlyMessageBufferForF7Suite1Oc.aggregateAll(subs);
    digest = oracleConsensusEarlyMessageBufferForF7Suite1Oc.digest(oracleConsensusEarlyMessageBufferForF7Suite1ROUND, aggregated);
    oracleConsensusEarlyMessageBufferForF7Suite1Oc.handleCommit(oracleConsensusEarlyMessageBufferForF7Suite1VoteEnvelope('ORACLE_COMMIT', oracleConsensusEarlyMessageBufferForF7Suite1VALSET[2].addr, digest));
    oracleConsensusEarlyMessageBufferForF7Suite1Oc.proposeRound(oracleConsensusEarlyMessageBufferForF7Suite1ROUND, subs, false, 1000, 1700000000, null, 2);
    let pending = oracleConsensusEarlyMessageBufferForF7Suite1Oc.pendingRounds.get(oracleConsensusEarlyMessageBufferForF7Suite1ROUND);
    expect(pending).to.exist;
    expect(pending.commits.has(oracleConsensusEarlyMessageBufferForF7Suite1VALSET[2].pubkey)).to.be.true;
    expect(oracleConsensusEarlyMessageBufferForF7Suite1Oc.earlyMessages.has(oracleConsensusEarlyMessageBufferForF7Suite1ROUND)).to.be.false;
  });
}
function registerOracleConsensusEarlyMessageBufferForF7Suite1Part3() {
  it('bounds the number of distinct buffered rounds (memory-DoS guard, FIFO evict)', function () {
    // A Byzantine peer streams votes with fresh attacker-chosen round numbers.
    // The distinct-round count must stay capped and evict the oldest first.
    oracleConsensusEarlyMessageBufferForF7Suite1Oc.earlyMessageMaxRounds = 8;
    for (let r = 0; r < 100; r++) {
      oracleConsensusEarlyMessageBufferForF7Suite1Oc.bufferEarlyMessage(r, oracleConsensusEarlyMessageBufferForF7Suite1VoteEnvelope('ORACLE_PREPARE', oracleConsensusEarlyMessageBufferForF7Suite1VALSET[2].addr, 'd' + r));
    }
    expect(oracleConsensusEarlyMessageBufferForF7Suite1Oc.earlyMessages.size).to.equal(8);
    // FIFO: only the newest 8 round keys survive (92..99); round 0 evicted.
    expect(oracleConsensusEarlyMessageBufferForF7Suite1Oc.earlyMessages.has(0)).to.be.false;
    expect(oracleConsensusEarlyMessageBufferForF7Suite1Oc.earlyMessages.has(99)).to.be.true;
    expect(oracleConsensusEarlyMessageBufferForF7Suite1Oc.earlyMessages.has(92)).to.be.true;
    // TTL map does not leak past the eviction bound either.
    expect(oracleConsensusEarlyMessageBufferForF7Suite1Oc.earlyMessageTtl.size).to.equal(8);
  });
}
describe('OracleConsensus: early-message buffer for F7', function () {
  registerOracleConsensusEarlyMessageBufferForF7Suite1Part1.call(this);
  registerOracleConsensusEarlyMessageBufferForF7Suite1Part2.call(this);
  registerOracleConsensusEarlyMessageBufferForF7Suite1Part3.call(this);
});
