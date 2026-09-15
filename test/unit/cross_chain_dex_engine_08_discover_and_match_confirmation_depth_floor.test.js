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
const { createMockHub, DB_METHODS } = require('../helpers/mockHub');
const eq             = require('../../src/equivocation_header.js');
const ccr            = require('../../src/cross_chain_royalty_activation.js');

// Warm the mathjs/bcmath require cache once, OUTSIDE any timed hook (mathjs is large and the
// first load on the Parallels share can exceed a 5s hook timeout).
require('mathjs');
require('../../src/bcmath.js');

// ────────────────────────────────────────────────────────────────────────────
// Load with axios stubbed
// ────────────────────────────────────────────────────────────────────────────

let axiosStub;
let CrossChainDexEngine;

function loadModule() {
    axiosStub = { post: sinon.stub() };
    CrossChainDexEngine = proxyquire('../../src/cross_chain/dex_engine', { axios: axiosStub });
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

function registerFeature16discoverAndMatchConfirmationDepthFloorPart1() {
  it('drops offers shallower than minConfirmations on the discovery path', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    eng.minConfirmations = {
      BTC: 6,
      LTC: 6,
      DOGE: 6
    }; // per-coin map
    eng.indexers.BTC.url = 'http://btc'; // pass the per-coin URL guard
    // latest tip 20: block 11 is 10 deep (kept), block 19 is 2 deep (dropped at floor 6).
    sinon.stub(eng, '_indexerCall').resolves({
      network: 'regtest',
      latest_block_index: 20,
      orders: [{
        action_index: 1,
        block_index: 11
      }, {
        action_index: 2,
        block_index: 19
      }]
    });
    let captured;
    sinon.stub(eng, 'findMatches').callsFake(obc => {
      captured = obc;
      return [];
    });
    await eng._discoverAndMatch();
    let seen = (captured.BTC || []).map(o => o.action_index);
    expect(seen).to.include(1);
    expect(seen).to.not.include(2);
  });
}
function registerFeature16discoverAndMatchConfirmationDepthFloorPart2() {
  it('keeps every offer at an explicit floor of 1 (regtest-style venue pin)', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    eng.minConfirmations = {
      BTC: 1,
      LTC: 1,
      DOGE: 1
    }; // XDEX_MIN_CONFIRMATIONS=1 venue pin (defaults are now per-coin 6/12/60)
    eng.indexers.BTC.url = 'http://btc';
    sinon.stub(eng, '_indexerCall').resolves({
      network: 'regtest',
      latest_block_index: 20,
      orders: [{
        action_index: 1,
        block_index: 20
      }, {
        action_index: 2,
        block_index: 11
      }]
    });
    let captured;
    sinon.stub(eng, 'findMatches').callsFake(obc => {
      captured = obc;
      return [];
    });
    await eng._discoverAndMatch();
    expect((captured.BTC || []).map(o => o.action_index)).to.have.members([1, 2]);
  });
}
function registerFeature16discoverAndMatchConfirmationDepthFloor() {
  describe('_discoverAndMatch(): confirmation-depth floor', function () {
    registerFeature16discoverAndMatchConfirmationDepthFloorPart1();
    registerFeature16discoverAndMatchConfirmationDepthFloorPart2();
  });
}
function registerFeature17fetchOpenOffersKeysetCursorPagingXCC2Part1() {
  it('follows next_cursor across truncated pages and accumulates the full book', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let call = sinon.stub(eng, '_indexerCall');
    // Page 1: truncated, next_cursor 2. Page 2: truncated, next_cursor 4. Page 3: tail.
    call.onCall(0).resolves({
      network: 'regtest',
      latest_block_index: 100,
      truncated: true,
      next_cursor: 2,
      orders: [{
        action_index: 1,
        block_index: 1
      }, {
        action_index: 2,
        block_index: 1
      }]
    });
    call.onCall(1).resolves({
      network: 'regtest',
      latest_block_index: 101,
      truncated: true,
      next_cursor: 4,
      orders: [{
        action_index: 3,
        block_index: 1
      }, {
        action_index: 4,
        block_index: 1
      }]
    });
    call.onCall(2).resolves({
      network: 'regtest',
      latest_block_index: 102,
      truncated: false,
      next_cursor: 5,
      orders: [{
        action_index: 5,
        block_index: 1
      }]
    });
    let res = await eng.fetchOpenOffers('BTC', {
      limit: 2
    });
    expect(res.orders.map(o => o.action_index)).to.deep.equal([1, 2, 3, 4, 5]);
    // network + latest pinned to the FIRST page for a consistent confirmation-depth tip.
    expect(res.network).to.equal('regtest');
    expect(res.latest_block_index).to.equal(100);
    expect(call.callCount).to.equal(3);
    // The cursor is threaded from each page's next_cursor.
    expect(call.getCall(1).args[2]).to.deep.equal({
      limit: 2,
      after_action_index: 2
    });
    expect(call.getCall(2).args[2]).to.deep.equal({
      limit: 2,
      after_action_index: 4
    });
  });
}
function registerFeature17fetchOpenOffersKeysetCursorPagingXCC2Part2() {
  it('makes a single call when the first page is not truncated (backward compatible)', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let call = sinon.stub(eng, '_indexerCall').resolves({
      network: 'regtest',
      latest_block_index: 20,
      orders: [{
        action_index: 1,
        block_index: 11
      }] // no `truncated` field = pre-XCC-2 indexer
    });
    let res = await eng.fetchOpenOffers('BTC', {
      limit: 500
    });
    expect(call.callCount).to.equal(1);
    expect(res.orders.map(o => o.action_index)).to.deep.equal([1]);
  });
  it('falls back to the batch max action_index when the indexer omits next_cursor', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let call = sinon.stub(eng, '_indexerCall');
    call.onCall(0).resolves({
      network: 'regtest',
      latest_block_index: 9,
      truncated: true,
      orders: [{
        action_index: 3,
        block_index: 1
      }, {
        action_index: 8,
        block_index: 1
      }]
    });
    call.onCall(1).resolves({
      network: 'regtest',
      latest_block_index: 9,
      truncated: false,
      orders: [{
        action_index: 12,
        block_index: 1
      }]
    });
    let res = await eng.fetchOpenOffers('BTC', {
      limit: 2
    });
    expect(res.orders.map(o => o.action_index)).to.deep.equal([3, 8, 12]);
    expect(call.getCall(1).args[2]).to.deep.equal({
      limit: 2,
      after_action_index: 8
    });
  });
}
function registerFeature17fetchOpenOffersKeysetCursorPagingXCC2Part3() {
  it('breaks (never spins) when a truncated page fails to advance the cursor', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    // Always truncated with a non-advancing cursor: the guard must stop after page 2.
    let call = sinon.stub(eng, '_indexerCall').resolves({
      network: 'regtest',
      latest_block_index: 5,
      truncated: true,
      next_cursor: 4,
      orders: [{
        action_index: 4,
        block_index: 1
      }]
    });
    let res = await eng.fetchOpenOffers('BTC', {
      limit: 1
    });
    // page 0 sets after=4; page 1 returns next_cursor 4 (<= 4) → break. Two calls, no spin.
    expect(call.callCount).to.equal(2);
    expect(res.orders.length).to.be.greaterThan(0);
  });
}
function registerFeature17fetchOpenOffersKeysetCursorPagingXCC2Part4() {
  it('_discoverAndMatch pages the book and matches an offer beyond the first page', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    eng.minConfirmations = {
      BTC: 1,
      LTC: 1,
      DOGE: 1
    };
    eng.indexers.BTC.url = 'http://btc';
    let call = sinon.stub(eng, '_indexerCall');
    call.onCall(0).resolves({
      network: 'regtest',
      latest_block_index: 50,
      truncated: true,
      next_cursor: 1,
      orders: [{
        action_index: 1,
        block_index: 10
      }]
    });
    call.onCall(1).resolves({
      network: 'regtest',
      latest_block_index: 55,
      truncated: false,
      next_cursor: 2,
      orders: [{
        action_index: 2,
        block_index: 10
      }]
    });
    let captured;
    sinon.stub(eng, 'findMatches').callsFake(obc => {
      captured = obc;
      return [];
    });
    await eng._discoverAndMatch();
    // Both pages' offers reach the matcher; the confirmation-depth tip is the first page's.
    expect((captured.BTC || []).map(o => o.action_index)).to.have.members([1, 2]);
  });
}
function registerFeature17fetchOpenOffersKeysetCursorPagingXCC2() {
  describe('fetchOpenOffers(): keyset cursor paging (XCC-2)', function () {
    registerFeature17fetchOpenOffersKeysetCursorPagingXCC2Part1();
    registerFeature17fetchOpenOffersKeysetCursorPagingXCC2Part2();
    registerFeature17fetchOpenOffersKeysetCursorPagingXCC2Part3();
    registerFeature17fetchOpenOffersKeysetCursorPagingXCC2Part4();
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
  registerFeature16discoverAndMatchConfirmationDepthFloor();
  registerFeature17fetchOpenOffersKeysetCursorPagingXCC2();
});
