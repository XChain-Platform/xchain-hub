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
const eq             = require('../../../../src/equivocation_header.js');
const ccr            = require('../../../../src/cross_chain_royalty_activation.js');

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

function registerFeature14persistCapabilitySnapshotPart1() {
  it('inserts rows from capability snapshot validators', async function () {
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub().resolves([]);
    let eng = new CrossChainDexEngine(hub);
    eng.capSnapshot = {
      getSnapshot: sinon.stub().resolves({
        validators: [{
          pubkey: 'pub1',
          amount: '50000'
        }]
      })
    };
    await eng.persistCapabilitySnapshot('cross_chain', 100);
    expect(hub.db.doQuery.calledWith(sinon.match(/INSERT IGNORE INTO capability_snapshots/))).to.be.true;
  });
}
function registerFeature14persistCapabilitySnapshotPart2() {
  it('writeFinalizedMatch persists the snapshot on EVERY hub, not just the leader', async function () {
    // Bug-C analog: indexers verify match signatures against
    // capability_snapshots in whichever hub DB they mirror, and a
    // follower's DB may be the only one they read (leader-only
    // persistence (quorum-0 inline + broadcastPropose) left follower
    // DBs without it.
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub().resolves({
      affectedRows: 1
    });
    let eng = new CrossChainDexEngine(hub);
    let persist = sinon.stub(eng, 'persistCapabilitySnapshot').resolves(1);
    let row = {
      match_id: 'm'.repeat(64),
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
    await eng.writeFinalizedMatch({
      row,
      signatures: [{
        pubkey: 'a'.repeat(64),
        sig: '1'.repeat(128)
      }]
    });
    expect(persist.calledWith('cross_chain', 150)).to.be.true;
  });
}
function registerFeature14persistCapabilitySnapshotPart3() {
  it('does nothing when no validators and _seedLocalValidator=false', async function () {
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub().resolves([]);
    let eng = new CrossChainDexEngine(hub);
    eng._seedLocalValidator = false;
    eng.capSnapshot = {
      getSnapshot: sinon.stub().resolves({
        validators: []
      })
    };
    let n = await eng.persistCapabilitySnapshot('cross_chain', 100);
    expect(hub.db.doQuery.called).to.be.false;
    expect(n).to.equal(0);
  });

  // SWQ-TRUNC-MIRROR. The .truncated marker is a JS array property and
  // capability_snapshots has no column for it, so mirroring a capped set hands the
  // off-BTC verifiers a partial stake denominator they read back as COMPLETE and
  // finalize against, while this hub's own meetsStakeThreshold rejects it. Persist
  // must fail closed instead: no rows, no mirror stream, and the 0 return that the
  // writeFinalizedMatch caller already treats as "defer this match".
  it('refuses to persist or mirror a TRUNCATED set', async function () {
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub().resolves([]);
    let eng = new CrossChainDexEngine(hub);
    let capped = [{
      pubkey: 'pub1',
      source: 'srcA',
      weight: '50000',
      amount: '50000'
    }];
    capped.truncated = true;
    sinon.stub(eng, 'resolveCapabilityValidators').resolves(capped);
    let n = await eng.persistCapabilitySnapshot('cross_chain', 100);
    expect(n, 'zero rows is the caller\'s fail-closed signal').to.equal(0);
    expect(hub.db.doQuery.called, 'no capability_snapshots row may be written').to.be.false;
  });
  it('still persists an untruncated set (the guard is not a blanket refusal)', async function () {
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub().resolves([]);
    let eng = new CrossChainDexEngine(hub);
    let full = [{
      pubkey: 'pub1',
      source: 'srcA',
      weight: '50000',
      amount: '50000'
    }];
    full.truncated = false;
    sinon.stub(eng, 'resolveCapabilityValidators').resolves(full);
    let n = await eng.persistCapabilitySnapshot('cross_chain', 100);
    expect(n).to.equal(1);
    expect(hub.db.doQuery.calledWith(sinon.match(/INSERT IGNORE INTO capability_snapshots/))).to.be.true;
  });
}
function registerFeature14persistCapabilitySnapshot() {
  describe('persistCapabilitySnapshot()', function () {
    registerFeature14persistCapabilitySnapshotPart1();
    registerFeature14persistCapabilitySnapshotPart2();
    registerFeature14persistCapabilitySnapshotPart3();
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
  registerFeature14persistCapabilitySnapshot();
});
