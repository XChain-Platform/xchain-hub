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

// Build the row finalizeMatch would produce for an ORDER pair.
function feature10validateProposedMatchFragment2OrderRow(eng, a, b, block) {
  let d = eng.tryMatch(a, b);
  return {
    match_id: eng._deriveMatchId(d.lo, d.hi, block, d.loFilledBefore, d.hiFilledBefore),
    snapshot_block: block,
    network: d.network,
    a_chain: d.lo.home_coin,
    a_action_index: d.lo.action_index,
    a_kind: d.loKind,
    a_tick: d.lo.give_tick,
    a_amount: d.loFill,
    a_filled_before: d.loFilledBefore,
    a_ownership: d.lo.give_ownership,
    a_payout_addr: d.lo.get_address,
    a_payout_legs: d.lo.payout_legs || null,
    b_chain: d.hi.home_coin,
    b_action_index: d.hi.action_index,
    b_kind: d.hiKind,
    b_tick: d.hi.give_tick,
    b_amount: d.hiFill,
    b_filled_before: d.hiFilledBefore,
    b_ownership: d.hi.give_ownership,
    b_payout_addr: d.hi.get_address,
    b_payout_legs: d.hi.payout_legs || null,
    // Honest leaders stamp _nowSeconds() plus a forward propagation margin sized to
    // the slower leg; validateProposedMatch bounds it ASYMMETRICALLY against the
    // follower's clock. A far-future stamp would lock both escrows, and a stamp at
    // or behind now would make the match settleable before it had reached both
    // chains' indexers (#4202). So: the engine's own clock plus a margin, never a
    // fixed timestamp.
    effective_time: eng._nowSeconds() + 600
  };
}
// Cross-chain royalty legs: the canonical is built from the PROPOSED row, so the
// follower must confirm the row's legs against its own indexer's view of each order.
const feature10validateProposedMatchFragment2LEGS = JSON.stringify([{
  to: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
  bps: 500
}]);
function registerFeature10validateProposedMatchFragment2Part1() {
  // #4204. The indexer's settlement pass rebuilds the signed canonical from the
  // mirrored BIGINT row, so a leader-supplied '041' for an action index passes
  // every Number()-based re-derivation here yet finalizes a match no settling
  // indexer can verify - leaving both escrows locked with nothing to retry.
  it('returns false for a noncanonical integer spelling on a signed field', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    sinon.stub(eng, '_findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : a);

    // The canonical spelling of the same value, as a number or a string, passes.
    let ok = feature10validateProposedMatchFragment2OrderRow(eng, a, b, 100);
    ok.a_action_index = String(Number(ok.a_action_index));
    expect(await eng.validateProposedMatch(ok)).to.be.true;
    for (const field of ['a_action_index', 'b_action_index', 'snapshot_block', 'effective_time']) {
      let row = feature10validateProposedMatchFragment2OrderRow(eng, a, b, 100);
      row[field] = '0' + String(Number(row[field]));
      expect(await eng.validateProposedMatch(row), 'signed a match with a leading-zero ' + field).to.be.false;
    }
    let nulled = feature10validateProposedMatchFragment2OrderRow(eng, a, b, 100);
    nulled.a_ownership = null; // signs the literal 'null', persists as 0
    expect(await eng.validateProposedMatch(nulled)).to.be.false;
  });

  // ── XDEX-GEN-FORGE-1: the per-leg source-reorg fence (a_/b_push_generation) is not
  // in the signed canonical or match_id, so a follower must re-derive it from its own
  // offer view or a Byzantine leader can stamp an inflated generation no honest
  // retraction can ever fence (a match on a rolled-back order that is never retracted).
  // ── XDEX-GEN-FORGE-1: the per-leg source-reorg fence (a_/b_push_generation) is not
  // in the signed canonical or match_id, so a follower must re-derive it from its own
  // offer view or a Byzantine leader can stamp an inflated generation no honest
  // retraction can ever fence (a match on a rolled-back order that is never retracted).
  it('returns true when the proposed push_generation matches our own offer view', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    // a=LTC (row b-leg / desc.hi), b=DOGE (row a-leg / desc.lo) since 'DOGE' < 'LTC'.
    b.push_generation = 3;
    a.push_generation = 5;
    let row = feature10validateProposedMatchFragment2OrderRow(eng, a, b, 100);
    row.a_push_generation = 3;
    row.b_push_generation = 5;
    sinon.stub(eng, '_findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : a);
    expect(await eng.validateProposedMatch(row)).to.be.true;
  });
}
function registerFeature10validateProposedMatchFragment2Part2() {
  it('returns false when the leader inflates a_push_generation (forged reorg fence)', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    b.push_generation = 3;
    a.push_generation = 5;
    let row = feature10validateProposedMatchFragment2OrderRow(eng, a, b, 100);
    // Everything re-derives identically; only the fence is inflated to a value no
    // honest retraction_generation can reach, escaping retraction forever.
    row.a_push_generation = 9007199254740992; // 2^53
    row.b_push_generation = 5;
    sinon.stub(eng, '_findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : a);
    expect(await eng.validateProposedMatch(row)).to.be.false;
  });
  it('returns false when the leader inflates b_push_generation', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    b.push_generation = 3;
    a.push_generation = 5;
    let row = feature10validateProposedMatchFragment2OrderRow(eng, a, b, 100);
    row.a_push_generation = 3;
    row.b_push_generation = 42; // does not match a.push_generation (5)
    sinon.stub(eng, '_findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : a);
    expect(await eng.validateProposedMatch(row)).to.be.false;
  });
  it('treats absent generations as 0 on both sides (legacy indexer parity)', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    let row = feature10validateProposedMatchFragment2OrderRow(eng, a, b, 100); // no push_generation set anywhere → 0 === 0
    sinon.stub(eng, '_findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : a);
    expect(await eng.validateProposedMatch(row)).to.be.true;
  });
}
function registerFeature10validateProposedMatchFragment2() {
  describe('validateProposedMatch()', function () {
    registerFeature10validateProposedMatchFragment2Part1();
    registerFeature10validateProposedMatchFragment2Part2();
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
  registerFeature10validateProposedMatchFragment2();
});
