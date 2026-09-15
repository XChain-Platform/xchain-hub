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

let feature4findMatchesSWAPEng;
function registerFeature4findMatchesSWAPPart1() {
  it('finds a valid exact pair', function () {
    let {
      a,
      b
    } = makePair();
    let m = feature4findMatchesSWAPEng.findMatches({
      BTC: [a],
      LTC: [b],
      DOGE: []
    });
    expect(m).to.have.length(1);
    expect(m[0].loKind).to.equal('swap');
  });
  it('returns empty when no matching pairs exist', function () {
    let a = makeOffer({
      give_amount: '100',
      get_amount: '500'
    });
    let b = makeOffer({
      home_coin: 'LTC',
      give_amount: '999',
      get_amount: '1'
    });
    expect(feature4findMatchesSWAPEng.findMatches({
      BTC: [a],
      LTC: [b],
      DOGE: []
    })).to.have.length(0);
  });
  it('does not match the same offer twice in a round', function () {
    let {
      a,
      b
    } = makePair();
    expect(feature4findMatchesSWAPEng.findMatches({
      BTC: [a, a],
      LTC: [b, b],
      DOGE: []
    }).length).to.be.at.most(1);
  });
  it('orders the pair canonically (lo.home_coin <= hi.home_coin)', function () {
    let {
      a,
      b
    } = makePair();
    let m = feature4findMatchesSWAPEng.findMatches({
      BTC: [a],
      LTC: [b],
      DOGE: []
    });
    expect(m[0].lo.home_coin <= m[0].hi.home_coin).to.be.true;
  });
}
function registerFeature4findMatchesSWAPPart2() {
  it('skips a swap already fully committed', function () {
    let {
      a,
      b
    } = makePair();
    feature4findMatchesSWAPEng.committed.set('BTC:1', {
      give: '100',
      get: '500'
    }); // a fully matched
    expect(feature4findMatchesSWAPEng.findMatches({
      BTC: [a],
      LTC: [b],
      DOGE: []
    })).to.have.length(0);
    feature4findMatchesSWAPEng.committed.clear();
  });
}
function registerFeature4findMatchesSWAP() {
  describe('findMatches(): SWAP', function () {
    before(function () {
      loadModule();
      feature4findMatchesSWAPEng = new CrossChainDexEngine(makeDexHub());
    });
    registerFeature4findMatchesSWAPPart1();
    registerFeature4findMatchesSWAPPart2();
  });
}
let feature5tryOrderMatchPartialFillsEng;
function registerFeature5tryOrderMatchPartialFillsPart1() {
  it('produces the bottleneck-clamped fill (smaller side fully filled)', function () {
    let {
      a,
      b
    } = makeOrderPair();
    let d = feature5tryOrderMatchPartialFillsEng.tryMatch(a, b);
    expect(d).to.not.be.null;
    expect(d.loKind).to.equal('order');
    // lo = DOGE (canonical-lower) gives 20 DOGT, hi = LTC gives 40 LTCT
    expect(d.lo.home_coin).to.equal('DOGE');
    expect(d.loFill).to.equal('20');
    expect(d.hiFill).to.equal('40');
    expect(d.loFilledBefore).to.equal('0');
    expect(d.hiFilledBefore).to.equal('0');
  });
  it('advances filled_before on a sequential fill and yields a distinct match_id', function () {
    let {
      a,
      b
    } = makeOrderPair();
    let d1 = feature5tryOrderMatchPartialFillsEng.tryMatch(a, b);
    // simulate finalize: commit d1's fill to the ledger
    feature5tryOrderMatchPartialFillsEng.applyCommit({
      a_chain: d1.lo.home_coin,
      a_action_index: d1.lo.action_index,
      a_amount: d1.loFill,
      b_chain: d1.hi.home_coin,
      b_action_index: d1.hi.action_index,
      b_amount: d1.hiFill
    }, +1);
    // a second DOGE order fills more of A
    let c = Object.assign({}, b, {
      action_index: 9,
      block_index: 21,
      get_address: 'Daddr2'
    });
    let d2 = feature5tryOrderMatchPartialFillsEng.tryMatch(a, c);
    expect(d2.hiFilledBefore).to.equal('40'); // A already filled 40 LTCT
    let id1 = feature5tryOrderMatchPartialFillsEng._deriveMatchId(d1.lo, d1.hi, 100, d1.loFilledBefore, d1.hiFilledBefore);
    let id2 = feature5tryOrderMatchPartialFillsEng._deriveMatchId(d2.lo, d2.hi, 100, d2.loFilledBefore, d2.hiFilledBefore);
    expect(id1).to.not.equal(id2);
  });
}
function registerFeature5tryOrderMatchPartialFillsPart2() {
  it('applies the price-cross guard exactly as the local matcher (order_match.js:118)', function () {
    // maker = A (earlier): GET_PRICE = give/get = 100/50 = 2. taker = B (later).
    // The guard skips when maker.GET_PRICE > taker.GIVE_PRICE. With B wanting 30 LTCT
    // for 20 DOGT, taker.GIVE_PRICE = get/give = 30/20 = 1.5 < 2 → skipped (null).
    let {
      a,
      b
    } = makeOrderPair();
    b.get_amount = '30';
    expect(feature5tryOrderMatchPartialFillsEng.tryMatch(a, b)).to.be.null;
    // At the boundary (equal price, makeOrderPair's 40 → GIVE_PRICE 2) it matches.
    let {
      a: a2,
      b: b2
    } = makeOrderPair();
    expect(feature5tryOrderMatchPartialFillsEng.tryMatch(a2, b2)).to.not.be.null;
  });
  it('does not over-fill once an order is fully committed', function () {
    let {
      a,
      b
    } = makeOrderPair();
    feature5tryOrderMatchPartialFillsEng.committed.set('LTC:1', {
      give: '100',
      get: '50'
    }); // A fully filled
    expect(feature5tryOrderMatchPartialFillsEng.tryMatch(a, b)).to.be.null;
  });
}
function registerFeature5tryOrderMatchPartialFillsPart3() {
  it('does not cross-match a SWAP against an ORDER (carry-forward): kind, not terms, is the bar', function () {
    // ORDER on LTC: give 100 LTCT, get 50 DOGT (makeOrderPair's A, home_network 'regtest').
    let {
      a: order
    } = makeOrderPair();
    // A DOGE counterparty with terms that DO cross the order (identical to makeOrderPair's B,
    // which test 237 proves matches as order×order). CRITICAL: it must share the order's
    // network (otherwise tryMatch short-circuits on the network guard (line 245) and a null
    // would be a FALSE proof (the carry-forward branch at line 258 never runs).
    let terms = {
      home_coin: 'DOGE',
      home_network: 'regtest',
      block_index: 20,
      action_index: 7,
      give_coin: 'DOGE',
      give_tick: 'DOGT',
      give_amount: '20',
      get_coin: 'LTC',
      get_tick: 'LTCT',
      get_amount: '40',
      get_address: 'Daddr',
      give_ownership: 0,
      get_ownership: 0,
      // Required for the order×order control to reach the fill math at all: the
      // ORDER path declines a match whose give-side grid it cannot establish.
      give_decimals: 8
    };
    let swap = Object.assign({}, terms, {
      kind: 'swap'
    });
    let ordr2 = Object.assign({}, terms, {
      kind: 'order'
    });

    // SWAP↔ORDER carries forward in BOTH orderings (the only difference from the controls is kind).
    expect(feature5tryOrderMatchPartialFillsEng.tryMatch(order, swap), 'order×swap should carry forward').to.be.null;
    expect(feature5tryOrderMatchPartialFillsEng.tryMatch(swap, order), 'swap×order should carry forward').to.be.null;

    // Positive controls: the SAME crossing terms DO match when both sides are the same kind,
    // proving the null above is the SWAP↔ORDER boundary, not term incompatibility or the
    // network guard. order×order fills; swap×swap (an exact same-network pair) finalises.
    expect(feature5tryOrderMatchPartialFillsEng.tryMatch(order, ordr2), 'order×order control should match').to.not.be.null;
    let {
      a: swapA,
      b: swapB
    } = makePair();
    expect(feature5tryOrderMatchPartialFillsEng.tryMatch(swapA, swapB), 'swap×swap control should match').to.not.be.null;
  });
}
function registerFeature5tryOrderMatchPartialFills() {
  describe('tryOrderMatch(): partial fills', function () {
    beforeEach(function () {
      feature5tryOrderMatchPartialFillsEng = new CrossChainDexEngine(makeDexHub());
    });
    registerFeature5tryOrderMatchPartialFillsPart1();
    registerFeature5tryOrderMatchPartialFillsPart2();
    registerFeature5tryOrderMatchPartialFillsPart3();
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
  registerFeature4findMatchesSWAP();
  registerFeature5tryOrderMatchPartialFills();
});
