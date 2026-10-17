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

const sinon             = require('sinon');
const { expect }        = require('chai');
const CrossChainEngine  = require('../../../src/cross_chain/engine');
const { createMockHub } = require('../../helpers/mockHub');

const ID = 'BTC:5:LTC';

let hub, engine, clock, db;

// A store that fails while `db.down` is set, after `db.latencyMs` of simulated DB time.
function wireStore() {
  db = { down: true, latencyMs: 0, calls: 0 };
  sinon.stub(engine, 'storeAttestation').callsFake(() => new Promise((resolve, reject) => {
    db.calls++;
    setTimeout(() => (db.down ? reject(new Error('ER_CON_COUNT_ERROR')) : resolve()), db.latencyMs);
  }));
}

// Open a leader round and capture how its caller promise settles.
function openLeaderRound() {
  let outcome = { settled: null, value: null };
  engine.openAttestationRound({
    attestationId: ID, sourceChain: 'BTC', sourceActionIndex: 5, destChain: 'LTC',
    confirmations: 3, digest: engine.digest(ID, 3), quorum: 2, memberPubkeys: null, btcBlockHeight: 900000
  }, v => { outcome.settled = 'resolved'; outcome.value = v; }, e => { outcome.settled = 'rejected'; outcome.value = e; });
  return outcome;
}

// Reach commit quorum on the open round, which starts the store.
function reachCommitQuorum() {
  let pending = engine.pendingAttestations.get(ID);
  pending.commits.add('aa'.repeat(33));
  pending.commits.add('bb'.repeat(33));
  engine.checkCommitQuorum(ID);
  return pending;
}

function setUp() {
  clock = sinon.useFakeTimers();
  hub = createMockHub();
  engine = new CrossChainEngine(hub);
  engine.timeout = 1000;
  engine.storeRetryBaseMs = 1;
  wireStore();
}

function tearDown() {
  engine.stop();
  clock.restore();
  sinon.restore();
}

// A quorate leader round whose store fails after the round timer fired must still land its row.
describe('CrossChainEngine attestation store re-drive', function () {
  beforeEach(setUp);
  afterEach(tearDown);

  it('re-drives a store that fails after the deadline fired, and settles the caller at the deadline', async function () {
    let emitted = [];
    engine.on('attestation:finalized', a => emitted.push(a));
    db.latencyMs = 600;
    let outcome = openLeaderRound();
    reachCommitQuorum();
    await clock.tickAsync(1000);
    expect(outcome.settled).to.equal('rejected', 'the caller hears back at the deadline');
    expect(outcome.value.message).to.match(/persistence pending/);
    await clock.tickAsync(5000);
    expect(db.calls).to.be.at.least(engine.storeRetryAttempts, 'the bounded store burst was spent');
    expect(engine.pendingAttestations.has(ID)).to.equal(true, 'the quorate round is retained');
    db.down = false;
    await clock.tickAsync(60000);
    expect(emitted).to.have.lengthOf(1, 'the row lands exactly once when the DB recovers');
    expect(engine.pendingAttestations.has(ID)).to.equal(false);
    expect(engine.finalized.has(ID)).to.equal(true);
  });

  it('refuses a second request for an attestation whose quorate round is still storing', async function () {
    openLeaderRound();
    reachCommitQuorum();
    await clock.tickAsync(100);
    let err = null;
    try { await engine.requestAttestation('BTC', 5, 'LTC'); } catch (e) { err = e; }
    expect(err).to.be.an('error');
    expect(err.message).to.match(/persistence pending/);
    expect(engine.pendingAttestations.get(ID).quorate).to.equal(true, 'the quorate round was not replaced');
  });
});

describe('CrossChainEngine attestation store re-drive', function () {
  beforeEach(setUp);
  afterEach(tearDown);

  it('keeps a quorate follower round past its eviction timer until the store lands', async function () {
    let emitted = [];
    engine.on('attestation:finalized', a => emitted.push(a));
    engine.openFollowerRound({ attestationId: ID, sourceChain: 'BTC', sourceActionIndex: 5, destChain: 'LTC',
      confirmations: 3, digest: engine.digest(ID, 3), btcBlockHeight: 900000, quorum: 2, memberPubkeys: null });
    reachCommitQuorum();
    await clock.tickAsync(2500);
    expect(engine.pendingAttestations.has(ID)).to.equal(true, 'the evictor leaves a quorate round alone');
    db.down = false;
    await clock.tickAsync(60000);
    expect(emitted).to.have.lengthOf(1);
    expect(engine.finalized.has(ID)).to.equal(true);
  });

  it('stops re-driving once the engine stops', async function () {
    openLeaderRound();
    reachCommitQuorum();
    await clock.tickAsync(100);
    let callsAtStop = db.calls;
    await engine.stop();
    await clock.tickAsync(120000);
    expect(db.calls).to.equal(callsAtStop);
  });
});
