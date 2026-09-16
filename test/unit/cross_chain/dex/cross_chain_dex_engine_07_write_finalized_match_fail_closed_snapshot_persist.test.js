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

const sinon          = require('sinon');
const { expect }     = require('chai');
const proxyquire     = require('proxyquire');
const { createMockHub, DB_METHODS } = require('../../../helpers/mockHub');
const eq             = require('../../../../src/consensus/equivocation_header.js');

// Warm the mathjs/bcmath require cache once, OUTSIDE any timed hook (mathjs is large and the
// first load on the Parallels share can exceed a 5s hook timeout).
require('mathjs');
require('../../../../src/bcmath.js');

// ────────────────────────────────────────────────────────────────────────────
// Load with axios stubbed
// ────────────────────────────────────────────────────────────────────────────

let axiosStub;
let CrossChainDexEngine;

function loadModule() {
    axiosStub = { post: sinon.stub() };
    CrossChainDexEngine = proxyquire('../../../../src/cross_chain/dex_engine', { axios: axiosStub });
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeDexHub(overrides) {
    let hub = createMockHub(overrides);
    // DB_METHODS first: the engine calls named query methods, and each of them
    // routes its statement through the doQuery stub, so a test that swaps doQuery
    // still sees every statement and its args. getChainTip stays a null-resolving
    // stub, as in createMockHub: the real one issues its own doQuery, which would
    // shift every scripted onCall(n) below by one and answer the engine's
    // btc_chain_id lookup with a row meant for the statement under test.
    hub.db = { ...DB_METHODS,
        doQuery: sinon.stub().resolves([]),
        getChainTip: sinon.stub().resolves(null),
        ...(overrides && overrides.db ? overrides.db : {})
    };
    hub.hubDbBroadcaster = overrides && overrides.hubDbBroadcaster !== undefined
        ? overrides.hubDbBroadcaster : null;
    hub.capabilitySnapshot = overrides && overrides.capabilitySnapshot !== undefined
        ? overrides.capabilitySnapshot : null;
    return hub;
}

// A minimal SWAP offer (no `kind` → swap path).
// give_decimals is the give-side decimal grid the offer's HOME indexer reports
// (getopencrosschainorders). The ORDER path quantizes its derived fills
// on it and DECLINES the match when it is absent, so every offer fixture carries it,
// exactly as a real book page does.
function makeOffer(overrides) {
    return {
        action_index:  1,
        home_coin:     'BTC',
        home_network:  'mainnet',
        give_coin:     'BTC',
        give_tick:     'XCH',
        give_amount:   '100',
        get_coin:      'LTC',
        get_tick:      'XCH',
        get_amount:    '500',
        get_address:   'ltc1abc',
        give_ownership: 0,
        get_ownership:  0,
        give_decimals: 8,
        block_index:   10,
        ...(overrides || {})
    };
}

// A matching SWAP pair (BTC offer ↔ LTC offer), exact amounts.
function makePair() {
    let a = makeOffer({
        action_index: 1, home_coin: 'BTC', give_coin: 'BTC', give_tick: 'XCH', give_amount: '100',
        get_coin: 'LTC', get_tick: 'XCH', get_amount: '500', get_address: 'ltc1abc'
    });
    let b = makeOffer({
        action_index: 2, home_coin: 'LTC', give_coin: 'LTC', give_tick: 'XCH', give_amount: '500',
        get_coin: 'BTC', get_tick: 'XCH', get_amount: '100', get_address: 'bc1xyz'
    });
    return { a, b };
}

// A crossing ORDER pair where B is smaller, so A partially fills.
//   A (LTC): give 100 LTCT, get 50 DOGT   (0.5 DOGT per LTCT)
//   B (DOGE): give 20 DOGT, get 40 LTCT   (same price; smaller)
// Expected fill: B gives 20 DOGT / gets 40 LTCT; A gives 40 LTCT / gets 20 DOGT.
function makeOrderPair() {
    let a = {
        kind: 'order', action_index: 1, home_coin: 'LTC', home_network: 'regtest', block_index: 10,
        give_coin: 'LTC', give_tick: 'LTCT', give_amount: '100', give_ownership: 0,
        get_coin: 'DOGE', get_tick: 'DOGT', get_amount: '50', get_ownership: 0, get_address: 'Laddr',
        give_decimals: 8
    };
    let b = {
        kind: 'order', action_index: 7, home_coin: 'DOGE', home_network: 'regtest', block_index: 20,
        give_coin: 'DOGE', give_tick: 'DOGT', give_amount: '20', give_ownership: 0,
        get_coin: 'LTC', get_tick: 'LTCT', get_amount: '40', get_ownership: 0, get_address: 'Daddr',
        give_decimals: 8
    };
    return { a, b };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

function feature15writeFinalizedMatchFailClosedSnapshotPersistFinalizeRow() {
  return {
    match_id: 'f'.repeat(64),
    snapshot_block: 150,
    network: 'regtest',
    a_chain: 'LTC',
    a_action_index: 1,
    a_kind: 'swap',
    a_tick: 'XCH',
    a_amount: '100',
    a_filled_before: '0',
    a_ownership: 0,
    a_payout_addr: 'La',
    b_chain: 'DOGE',
    b_action_index: 2,
    b_kind: 'swap',
    b_tick: 'XCH',
    b_amount: '500',
    b_filled_before: '0',
    b_ownership: 0,
    b_payout_addr: 'Db',
    effective_time: 1700000000
  };
}
function registerFeature15writeFinalizedMatchFailClosedSnapshotPersistPart1() {
  it('skips insert/commit and defers when the snapshot persist throws', async function () {
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub().resolves({
      affectedRows: 1
    });
    let eng = new CrossChainDexEngine(hub);
    sinon.stub(eng, 'persistCapabilitySnapshot').rejects(new Error('db down'));
    let insert = sinon.stub(eng, 'insertMatchRow').resolves(true);
    let commit = sinon.stub(eng, 'applyCommit');
    let forget = sinon.stub(eng.consensus, 'forgetFinalized');
    let row = feature15writeFinalizedMatchFailClosedSnapshotPersistFinalizeRow();
    eng._inflight.add(row.match_id);
    await eng.writeFinalizedMatch({
      row,
      signatures: [{
        pubkey: 'a'.repeat(64),
        sig: '1'.repeat(128)
      }]
    });
    expect(insert.called, 'must NOT insert the match row').to.be.false;
    expect(commit.called, 'must NOT apply the committed-ledger fill').to.be.false;
    expect(forget.calledWith(row.match_id), 'must forget the finalized id for re-propose').to.be.true;
    expect(eng._inflight.has(row.match_id), 'must clear the in-flight reservation').to.be.false;
  });
  it('skips insert/commit and defers when the snapshot persist writes zero rows', async function () {
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub().resolves({
      affectedRows: 1
    });
    let eng = new CrossChainDexEngine(hub);
    // Degraded/null snapshot => zero validators resolved => zero rows persisted.
    sinon.stub(eng, 'persistCapabilitySnapshot').resolves(0);
    let insert = sinon.stub(eng, 'insertMatchRow').resolves(true);
    let commit = sinon.stub(eng, 'applyCommit');
    let forget = sinon.stub(eng.consensus, 'forgetFinalized');
    let row = feature15writeFinalizedMatchFailClosedSnapshotPersistFinalizeRow();
    eng._inflight.add(row.match_id);
    await eng.writeFinalizedMatch({
      row,
      signatures: [{
        pubkey: 'a'.repeat(64),
        sig: '1'.repeat(128)
      }]
    });
    expect(insert.called, 'must NOT insert the match row').to.be.false;
    expect(commit.called, 'must NOT apply the committed-ledger fill').to.be.false;
    expect(forget.calledWith(row.match_id), 'must forget the finalized id for re-propose').to.be.true;
    expect(eng._inflight.has(row.match_id)).to.be.false;
  });
}
function registerFeature15writeFinalizedMatchFailClosedSnapshotPersistPart2() {
  it('inserts + commits when the snapshot persisted at least one row', async function () {
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub().resolves({
      affectedRows: 1
    });
    let eng = new CrossChainDexEngine(hub);
    sinon.stub(eng, 'persistCapabilitySnapshot').resolves(3);
    let insert = sinon.stub(eng, 'insertMatchRow').resolves(true);
    let commit = sinon.stub(eng, 'applyCommit');
    let row = feature15writeFinalizedMatchFailClosedSnapshotPersistFinalizeRow();
    eng._inflight.add(row.match_id);
    await eng.writeFinalizedMatch({
      row,
      signatures: [{
        pubkey: 'a'.repeat(64),
        sig: '1'.repeat(128)
      }]
    });
    expect(insert.calledOnce, 'must insert the match row').to.be.true;
    expect(commit.calledWith(row, +1), 'must apply the committed-ledger fill').to.be.true;
  });

  // The durable fill must be accounted BEFORE any fallible delivery step. A mirror
  // living inside insertMatchRow, between the INSERT and its return, lets a failed
  // re-read throw past `if(inserted) this.applyCommit(row, +1)` and leaves the DB
  // holding a finalized fill the in-memory reservation ledger does not know about.
}
function registerFeature15writeFinalizedMatchFailClosedSnapshotPersistPart3() {
  // The durable fill must be accounted BEFORE any fallible delivery step. A mirror
  // living inside insertMatchRow, between the INSERT and its return, lets a failed
  // re-read throw past `if(inserted) this.applyCommit(row, +1)` and leaves the DB
  // holding a finalized fill the in-memory reservation ledger does not know about.
  it('credits the ledger and releases the round even when the mirror read fails', async function () {
    let broadcaster = {
      broadcastRow: sinon.stub(),
      dropAllForResync: sinon.stub()
    };
    let hub = makeDexHub({
      hubDbBroadcaster: broadcaster
    });
    let q = sinon.stub();
    q.onFirstCall().resolves({
      affectedRows: 1
    }); // the INSERT: durable
    q.rejects(new Error('connection lost')); // the mirror re-read
    hub.db.doQuery = q;
    let eng = new CrossChainDexEngine(hub);
    eng.broadcaster = broadcaster;
    sinon.stub(eng, 'persistCapabilitySnapshot').resolves(3);
    let commit = sinon.stub(eng, 'applyCommit');
    let row = feature15writeFinalizedMatchFailClosedSnapshotPersistFinalizeRow();
    eng._inflight.add(row.match_id);
    await eng.writeFinalizedMatch({
      row,
      signatures: [{
        pubkey: 'a'.repeat(64),
        sig: '1'.repeat(128)
      }]
    });
    expect(commit.calledWith(row, +1), 'the durable fill must still reach the ledger').to.be.true;
    expect(eng._inflight.has(row.match_id), 'the in-flight slot must be released').to.be.false;
    expect(broadcaster.dropAllForResync.calledOnce, 'an undeliverable row must force a resync').to.be.true;
  });
}
function registerFeature15writeFinalizedMatchFailClosedSnapshotPersistPart4() {
  it('mirrors the committed row on the happy path', async function () {
    let broadcaster = {
      broadcastRow: sinon.stub(),
      dropAllForResync: sinon.stub()
    };
    let hub = makeDexHub({
      hubDbBroadcaster: broadcaster
    });
    let q = sinon.stub();
    q.onFirstCall().resolves({
      affectedRows: 1
    });
    q.resolves([{
      id: 9,
      match_id: 'f'.repeat(64)
    }]);
    hub.db.doQuery = q;
    let eng = new CrossChainDexEngine(hub);
    eng.broadcaster = broadcaster;
    sinon.stub(eng, 'persistCapabilitySnapshot').resolves(3);
    sinon.stub(eng, 'applyCommit');
    await eng.writeFinalizedMatch({
      row: feature15writeFinalizedMatchFailClosedSnapshotPersistFinalizeRow(),
      signatures: []
    });
    expect(broadcaster.broadcastRow.calledOnce).to.be.true;
    expect(broadcaster.broadcastRow.firstCall.args[0].table).to.equal('cross_chain_matches');
    expect(broadcaster.dropAllForResync.called).to.be.false;
  });

  // A write that throws means nothing was committed here, so the round must be
  // released for re-propose rather than staying in-flight and retired in consensus.
  it('defers the match when the row write itself throws', async function () {
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub().resolves({
      affectedRows: 1
    });
    let eng = new CrossChainDexEngine(hub);
    sinon.stub(eng, 'persistCapabilitySnapshot').resolves(3);
    sinon.stub(eng, 'insertMatchRow').rejects(new Error('deadlock'));
    let commit = sinon.stub(eng, 'applyCommit');
    let forget = sinon.stub(eng.consensus, 'forgetFinalized');
    let row = feature15writeFinalizedMatchFailClosedSnapshotPersistFinalizeRow();
    eng._inflight.add(row.match_id);
    await eng.writeFinalizedMatch({
      row,
      signatures: []
    });
    expect(commit.called, 'nothing was written, so nothing may be committed').to.be.false;
    expect(eng._inflight.has(row.match_id)).to.be.false;
    expect(forget.calledWith(row.match_id), 'the match must be re-proposable').to.be.true;
  });
}
function registerFeature15writeFinalizedMatchFailClosedSnapshotPersist() {
  describe('writeFinalizedMatch(): fail-closed snapshot persist', function () {
    registerFeature15writeFinalizedMatchFailClosedSnapshotPersistPart1();
    registerFeature15writeFinalizedMatchFailClosedSnapshotPersistPart2();
    registerFeature15writeFinalizedMatchFailClosedSnapshotPersistPart3();
    registerFeature15writeFinalizedMatchFailClosedSnapshotPersistPart4();
  });
}
describe('CrossChainDexEngine', function () {
  beforeEach(function () {
    loadModule();
    delete process.env.XDEX_POLL_MS;
    delete process.env.XDEX_SNAPSHOT_BLOCK;
    delete process.env.XDEX_SEED_LOCAL_VALIDATOR;
  });
  afterEach(function () {
    sinon.restore();
  });

  // ── Constructor ─────────────────────────────────────────────────────────
  registerFeature15writeFinalizedMatchFailClosedSnapshotPersist();
});
