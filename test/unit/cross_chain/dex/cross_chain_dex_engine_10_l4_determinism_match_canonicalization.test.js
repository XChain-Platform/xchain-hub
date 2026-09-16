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

const feature22l4DeterminismMatchCanonicalizationBaseMatch = () => ({
  match_id: 'm1',
  snapshot_block: 800000,
  network: 'mainnet',
  a_chain: 'BTC',
  a_action_index: 5,
  a_tick: 'XCH',
  a_amount: '100',
  a_ownership: 0,
  a_payout_addr: 'bc1a',
  a_kind: 'swap',
  a_filled_before: '0',
  b_chain: 'LTC',
  b_action_index: 9,
  b_tick: 'XCH',
  b_amount: '500',
  b_ownership: 0,
  b_payout_addr: 'ltc1b',
  b_kind: 'swap',
  b_filled_before: '0',
  effective_time: 1700000000
});
function registerFeature22l4DeterminismMatchCanonicalizationPart1() {
  it('two independent engines produce the identical canonical for the same match', function () {
    const e1 = new CrossChainDexEngine(makeDexHub());
    const e2 = new CrossChainDexEngine(makeDexHub());
    expect(e1.canonicalMatch(feature22l4DeterminismMatchCanonicalizationBaseMatch(), 0)).to.equal(e2.canonicalMatch(feature22l4DeterminismMatchCanonicalizationBaseMatch(), 0));
  });
  it('is invariant to object key order', function () {
    const eng = new CrossChainDexEngine(makeDexHub());
    const r = feature22l4DeterminismMatchCanonicalizationBaseMatch();
    const shuffled = {};
    for (const k of Object.keys(r).reverse()) shuffled[k] = r[k];
    expect(eng.canonicalMatch(shuffled, 0)).to.equal(eng.canonicalMatch(r, 0));
  });
  it('is invariant to numeric field TYPE (String-coerced)', function () {
    const eng = new CrossChainDexEngine(makeDexHub());
    const v1 = {
      ...feature22l4DeterminismMatchCanonicalizationBaseMatch(),
      a_action_index: 5,
      a_amount: '100',
      snapshot_block: 800000
    };
    const v2 = {
      ...feature22l4DeterminismMatchCanonicalizationBaseMatch(),
      a_action_index: '5',
      a_amount: 100,
      snapshot_block: '800000'
    };
    expect(eng.canonicalMatch(v1, 0)).to.equal(eng.canonicalMatch(v2, 0));
  });
  it('treats an absent optional tick as empty consistently (null vs undefined)', function () {
    const eng = new CrossChainDexEngine(makeDexHub());
    const withNull = {
      ...feature22l4DeterminismMatchCanonicalizationBaseMatch(),
      a_tick: null
    };
    const withUndef = {
      ...feature22l4DeterminismMatchCanonicalizationBaseMatch()
    };
    delete withUndef.a_tick;
    expect(eng.canonicalMatch(withNull, 0)).to.equal(eng.canonicalMatch(withUndef, 0));
  });
}
function registerFeature22l4DeterminismMatchCanonicalization() {
  describe('L4 determinism: match canonicalization', function () {
    registerFeature22l4DeterminismMatchCanonicalizationPart1();
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
  registerFeature22l4DeterminismMatchCanonicalization();
});
