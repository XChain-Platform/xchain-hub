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

let feature6deriveMatchIdEng;
function registerFeature6deriveMatchIdPart1() {
  it('produces a 64-hex string', function () {
    let {
      a,
      b
    } = makePair();
    expect(feature6deriveMatchIdEng._deriveMatchId(a, b, 100, '0', '0')).to.match(/^[0-9a-f]{64}$/);
  });
  it('is deterministic for the same inputs', function () {
    let {
      a,
      b
    } = makePair();
    expect(feature6deriveMatchIdEng._deriveMatchId(a, b, 100, '0', '0')).to.equal(feature6deriveMatchIdEng._deriveMatchId(a, b, 100, '0', '0'));
  });
  it('differs when snapshot block changes', function () {
    let {
      a,
      b
    } = makePair();
    expect(feature6deriveMatchIdEng._deriveMatchId(a, b, 100, '0', '0')).to.not.equal(feature6deriveMatchIdEng._deriveMatchId(a, b, 101, '0', '0'));
  });
  it('differs when a filled-before offset changes (sequential fills)', function () {
    let {
      a,
      b
    } = makePair();
    expect(feature6deriveMatchIdEng._deriveMatchId(a, b, 100, '0', '0')).to.not.equal(feature6deriveMatchIdEng._deriveMatchId(a, b, 100, '40', '0'));
  });
  it('treats 0 and 0.00000000 offsets as the same id', function () {
    let {
      a,
      b
    } = makePair();
    expect(feature6deriveMatchIdEng._deriveMatchId(a, b, 100, '0', '0')).to.equal(feature6deriveMatchIdEng._deriveMatchId(a, b, 100, '0.00000000', '0'));
  });
  it('differs for different networks at same block (no collision)', function () {
    let {
      a: a1,
      b: b1
    } = makePair();
    let {
      a: a2,
      b: b2
    } = makePair();
    a2.home_network = 'testnet';
    b2.home_network = 'testnet';
    expect(feature6deriveMatchIdEng._deriveMatchId(a1, b1, 100, '0', '0')).to.not.equal(feature6deriveMatchIdEng._deriveMatchId(a2, b2, 100, '0', '0'));
  });
}
function registerFeature6deriveMatchId() {
  describe('_deriveMatchId()', function () {
    before(function () {
      loadModule();
      feature6deriveMatchIdEng = new CrossChainDexEngine(makeDexHub());
    });
    registerFeature6deriveMatchIdPart1();
  });
}
let feature7canonicalMatchEng;
function feature7canonicalMatchSampleRow() {
  return {
    match_id: 'abc',
    snapshot_block: 100,
    network: 'regtest',
    a_chain: 'DOGE',
    a_action_index: 7,
    a_kind: 'order',
    a_tick: 'DOGT',
    a_amount: '20',
    a_filled_before: '0',
    a_ownership: 0,
    a_payout_addr: 'Laddr',
    b_chain: 'LTC',
    b_action_index: 1,
    b_kind: 'order',
    b_tick: 'LTCT',
    b_amount: '40',
    b_filled_before: '40',
    b_ownership: 0,
    b_payout_addr: 'Daddr',
    effective_time: 1700000000
  };
}

// The indexer's cross_settle._canonical is kept here byte-for-byte so a drift breaks CI.
// EQUIV active in regtest (WI-2 bump 2): TAG=XDEX, ROUND_ID=match_id, VIEW=finalizing_view (default 0).
// The indexer's cross_settle._canonical is kept here byte-for-byte so a drift breaks CI.
// EQUIV active in regtest (WI-2 bump 2): TAG=XDEX, ROUND_ID=match_id, VIEW=finalizing_view (default 0).
function feature7canonicalMatchIndexerCanonical(m) {
  let raw = ['XMATCH', m.match_id, String(m.snapshot_block), m.a_chain, String(m.a_action_index), m.a_tick || '', String(m.a_amount), String(m.a_ownership), m.a_payout_addr, m.b_chain, String(m.b_action_index), m.b_tick || '', String(m.b_amount), String(m.b_ownership), m.b_payout_addr, String(m.effective_time), m.network || '', m.a_kind || 'swap', String(m.a_filled_before != null ? m.a_filled_before : '0'), m.b_kind || 'swap', String(m.b_filled_before != null ? m.b_filled_before : '0')].join('|');
  // Royalty legs ride the signed match at/above CROSS_CHAIN_ROYALTY (regtest genesis).
  if (ccr.isCrossChainRoyaltyActive(m.snapshot_block, m.network)) raw += '|' + String(m.a_payout_legs || '') + '|' + String(m.b_payout_legs || '');
  if (eq.isEquivHeaderActive(m.snapshot_block, m.network)) return eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, m.match_id, m.finalizing_view != null ? m.finalizing_view : 0, raw);
  return raw;
}
function registerFeature7canonicalMatchPart1() {
  it('wraps the XMATCH content in the EQUIV header and appends the fill + royalty fields after network', function () {
    let canon = feature7canonicalMatchEng._canonicalMatch(feature7canonicalMatchSampleRow());
    expect(canon).to.match(/^EQUIV\|XDEX\|abc\|0\|\|XMATCH\|/); // gated (regtest); header then content
    expect(canon.endsWith('|regtest|order|0|order|40||')).to.be.true; // trailing '||' = empty royalty legs
  });
  it('byte-matches the indexer cross_settle._canonical', function () {
    let row = feature7canonicalMatchSampleRow();
    expect(feature7canonicalMatchEng._canonicalMatch(row)).to.equal(feature7canonicalMatchIndexerCanonical(row));
  });
  it('signs non-null royalty legs into the canonical bytes (strip changes the bytes)', function () {
    let row = feature7canonicalMatchSampleRow();
    row.a_payout_legs = JSON.stringify([{
      to: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
      bps: 500
    }]);
    expect(feature7canonicalMatchEng._canonicalMatch(row)).to.equal(feature7canonicalMatchIndexerCanonical(row));
    expect(feature7canonicalMatchEng._canonicalMatch(row)).to.not.equal(feature7canonicalMatchEng._canonicalMatch(feature7canonicalMatchSampleRow()));
  });
  it('defaults kind/filled_before for a legacy (swap) row', function () {
    let row = feature7canonicalMatchSampleRow();
    delete row.a_kind;
    delete row.a_filled_before;
    delete row.b_kind;
    delete row.b_filled_before;
    expect(feature7canonicalMatchEng._canonicalMatch(row)).to.equal(feature7canonicalMatchIndexerCanonical(row));
    expect(feature7canonicalMatchEng._canonicalMatch(row).endsWith('|swap|0|swap|0||')).to.be.true;
  });
}
function registerFeature7canonicalMatch() {
  describe('_canonicalMatch()', function () {
    before(function () {
      loadModule();
      feature7canonicalMatchEng = new CrossChainDexEngine(makeDexHub());
    });
    registerFeature7canonicalMatchPart1();
  });
}
let feature8normalizeAmountAmountsEqualEng;
function registerFeature8normalizeAmountAmountsEqualPart1() {
  it('strips leading and trailing zeros', function () {
    expect(feature8normalizeAmountAmountsEqualEng.normalizeAmount('007.50')).to.equal('7.5');
    expect(feature8normalizeAmountAmountsEqualEng.normalizeAmount('100.00000000')).to.equal('100');
  });
  it('treats null / empty as empty', function () {
    expect(feature8normalizeAmountAmountsEqualEng.normalizeAmount(null)).to.equal('');
    expect(feature8normalizeAmountAmountsEqualEng.normalizeAmount('')).to.equal('');
  });
  it('treats 100 and 100.00000000 as equal', function () {
    expect(feature8normalizeAmountAmountsEqualEng.amountsEqual('100', '100.00000000')).to.be.true;
  });
  it('returns false for unequal amounts', function () {
    expect(feature8normalizeAmountAmountsEqualEng.amountsEqual('100', '101')).to.be.false;
  });
}
function registerFeature8normalizeAmountAmountsEqual() {
  describe('normalizeAmount() / amountsEqual()', function () {
    before(function () {
      loadModule();
      feature8normalizeAmountAmountsEqualEng = new CrossChainDexEngine(makeDexHub());
    });
    registerFeature8normalizeAmountAmountsEqualPart1();
  });
}
let feature9isExactMatchEng;
function registerFeature9isExactMatchPart1() {
  it('returns true for a valid cross-chain exact match', function () {
    let {
      a,
      b
    } = makePair();
    expect(feature9isExactMatchEng.isExactMatch(a, b)).to.be.true;
  });
  it('returns false on same chain / differing network / non-mirrored amounts', function () {
    let {
      a,
      b
    } = makePair();
    expect(feature9isExactMatchEng.isExactMatch(a, makeOffer({
      home_coin: 'BTC',
      action_index: 2
    }))).to.be.false;
    let p2 = makePair();
    p2.b.home_network = 'testnet';
    expect(feature9isExactMatchEng.isExactMatch(p2.a, p2.b)).to.be.false;
    let p3 = makePair();
    p3.b.give_amount = '999';
    expect(feature9isExactMatchEng.isExactMatch(p3.a, p3.b)).to.be.false;
  });
}
function registerFeature9isExactMatch() {
  describe('isExactMatch()', function () {
    before(function () {
      loadModule();
      feature9isExactMatchEng = new CrossChainDexEngine(makeDexHub());
    });
    registerFeature9isExactMatchPart1();
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
  registerFeature6deriveMatchId();
  registerFeature7canonicalMatch();
  registerFeature8normalizeAmountAmountsEqual();
  registerFeature9isExactMatch();
});
