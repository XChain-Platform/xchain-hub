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

// Build the row finalizeMatch would produce for an ORDER pair.
function feature10validateProposedMatchFragment1OrderRow(eng, a, b, block) {
  let d = eng.tryMatch(a, b);
  return {
    match_id: eng.deriveMatchId(d.lo, d.hi, block, d.loFilledBefore, d.hiFilledBefore),
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
    // Honest leaders stamp nowSeconds() plus a forward propagation margin sized to
    // the slower leg; validateProposedMatch bounds it ASYMMETRICALLY against the
    // follower's clock. A far-future stamp would lock both escrows, and a stamp at
    // or behind now would make the match settleable before it had reached both
    // chains' indexers (#4202). So: the engine's own clock plus a margin, never a
    // fixed timestamp.
    effective_time: eng.nowSeconds() + 600
  };
}
// Cross-chain royalty legs: the canonical is built from the PROPOSED row, so the
// follower must confirm the row's legs against its own indexer's view of each order.
const feature10validateProposedMatchFragment1LEGS = JSON.stringify([{
  to: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
  bps: 500
}]);
function registerFeature10validateProposedMatchFragment1Part1() {
  it('returns true when the fill re-derives identically', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    let row = feature10validateProposedMatchFragment1OrderRow(eng, a, b, 100);
    sinon.stub(eng, 'findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : a);
    expect(await eng.validateProposedMatch(row)).to.be.true;
  });
  it('returns false when a leg is no longer open', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    let row = feature10validateProposedMatchFragment1OrderRow(eng, a, b, 100);
    sinon.stub(eng, 'findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : null);
    expect(await eng.validateProposedMatch(row)).to.be.false;
  });
  it('returns false when the proposed fill amount differs from our re-derivation', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    let row = feature10validateProposedMatchFragment1OrderRow(eng, a, b, 100);
    row.a_amount = '19'; // tampered fill
    sinon.stub(eng, 'findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : a);
    expect(await eng.validateProposedMatch(row)).to.be.false;
  });
  it('returns false when the proposed match_id is tampered', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    let row = feature10validateProposedMatchFragment1OrderRow(eng, a, b, 100);
    row.match_id = 'f'.repeat(64);
    sinon.stub(eng, 'findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : a);
    expect(await eng.validateProposedMatch(row)).to.be.false;
  });

  // Cross-chain royalty legs: the canonical is built from the PROPOSED row, so the
  // follower must confirm the row's legs against its own indexer's view of each order.
}
function registerFeature10validateProposedMatchFragment1Part2() {
  it('returns true when the proposed royalty legs match our own view', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    a.payout_legs = feature10validateProposedMatchFragment1LEGS;
    let row = feature10validateProposedMatchFragment1OrderRow(eng, a, b, 100);
    sinon.stub(eng, 'findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : a);
    expect(await eng.validateProposedMatch(row)).to.be.true;
  });
  it('returns false when the leader STRIPS the royalty legs', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    a.payout_legs = feature10validateProposedMatchFragment1LEGS;
    let row = feature10validateProposedMatchFragment1OrderRow(eng, a, b, 100);
    // a is home_coin LTC → canonical-HIGHER vs DOGE ('DOGE' < 'LTC'), so a's legs
    // ride the B side of the row
    row.b_payout_legs = null;
    sinon.stub(eng, 'findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : a);
    expect(await eng.validateProposedMatch(row)).to.be.false;
  });
  it('returns false when the leader REWRITES the royalty legs', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    a.payout_legs = feature10validateProposedMatchFragment1LEGS;
    let row = feature10validateProposedMatchFragment1OrderRow(eng, a, b, 100);
    row.b_payout_legs = JSON.stringify([{
      to: 'attacker',
      bps: 500
    }]);
    sinon.stub(eng, 'findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : a);
    expect(await eng.validateProposedMatch(row)).to.be.false;
  });
  it('returns false when the row claims legs our own view does not have', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    let row = feature10validateProposedMatchFragment1OrderRow(eng, a, b, 100);
    row.b_payout_legs = feature10validateProposedMatchFragment1LEGS;
    sinon.stub(eng, 'findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : a);
    expect(await eng.validateProposedMatch(row)).to.be.false;
  });
}
function registerFeature10validateProposedMatchFragment1Part3() {
  it('returns false when the leader stamps a far-future effective_time (escrow-lock griefing, XDEX-ETIME-1)', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    let row = feature10validateProposedMatchFragment1OrderRow(eng, a, b, 100);
    // Everything else re-derives identically; only the leader's effective_time is
    // pushed far into the future. Without the bound the follower would sign it and
    // the finalized match would never settle, locking both escrows.
    row.effective_time = eng.nowSeconds() + 30 * 24 * 3600; // +30 days
    sinon.stub(eng, 'findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : a);
    expect(await eng.validateProposedMatch(row)).to.be.false;
  });
  it('returns false when effective_time is non-numeric', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    let row = feature10validateProposedMatchFragment1OrderRow(eng, a, b, 100);
    row.effective_time = 'not-a-time';
    sinon.stub(eng, 'findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : a);
    expect(await eng.validateProposedMatch(row)).to.be.false;
  });

  // #4202, the other half of the effective_time bound. The window was once
  // symmetric, so a match stamped AT the leader's clock second passed. Such a match
  // is settleable on both legs the moment it is mirrored, so the indexer that
  // already holds the row settles a block ahead of one still receiving it and the
  // two legs' settlement action indexes diverge. _finalizeMatch stamped exactly
  // that (bare nowSeconds()) before this fix, so the guard and the producer
  // margin land together.
  // #4202, the other half of the effective_time bound. The window was once
  // symmetric, so a match stamped AT the leader's clock second passed. Such a match
  // is settleable on both legs the moment it is mirrored, so the indexer that
  // already holds the row settles a block ahead of one still receiving it and the
  // two legs' settlement action indexes diverge. _finalizeMatch stamped exactly
  // that (bare nowSeconds()) before this fix, so the guard and the producer
  // margin land together.
  it('returns false when the match is effective on arrival (no propagation window)', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a,
      b
    } = makeOrderPair();
    sinon.stub(eng, 'findOpenOffer').callsFake(async coin => coin === 'DOGE' ? b : a);
    for (const delta of [0, -30, 5]) {
      let row = feature10validateProposedMatchFragment1OrderRow(eng, a, b, 100);
      row.effective_time = eng.nowSeconds() + delta;
      expect(await eng.validateProposedMatch(row), 'co-signed a match effective at now' + (delta >= 0 ? '+' : '') + delta).to.be.false;
    }
  });
}
function registerFeature10validateProposedMatchFragment1Part4() {
  it('finalizeMatch stamps a forward margin sized to the slower leg, never the bare clock second', async function () {
    let hub = makeDexHub();
    hub.resolveBtcLatestBlock = sinon.stub().resolves(100);
    hub.db.doQuery = sinon.stub().resolves({
      affectedRows: 1
    });
    let eng = new CrossChainDexEngine(hub);
    eng._snapshotBlockOverride = 100;
    eng._seedLocalValidator = true;
    sinon.stub(eng, 'persistCapabilitySnapshot').resolves(1);
    let proposed = null;
    sinon.stub(eng.consensus, 'propose').callsFake(async (id, payload) => {
      proposed = payload.row;
    });
    let {
      a,
      b
    } = makeOrderPair();
    const now = eng.nowSeconds();
    let desc = eng.tryMatch(a, b);
    await eng.finalizeMatch(desc);
    expect(proposed, 'no row was proposed').to.not.equal(null);
    // 4 blocks of the SLOWER leg: both chains must hold the mirrored row before
    // either reaches its eligible block.
    const NOMINAL = {
      BTC: 600,
      LTC: 150,
      DOGE: 60
    };
    const want = Math.min(3000, 4 * Math.max(NOMINAL[desc.lo.home_coin], NOMINAL[desc.hi.home_coin]));
    expect(want, 'fixture pair carries no margin to assert').to.be.greaterThan(0);
    expect(proposed.effective_time - now).to.equal(want);
  });

  // #4204. The indexer's settlement pass rebuilds the signed canonical from the
  // mirrored BIGINT row, so a leader-supplied '041' for an action index passes
  // every Number()-based re-derivation here yet finalizes a match no settling
  // indexer can verify - leaving both escrows locked with nothing to retry.
}
function registerFeature10validateProposedMatchFragment1() {
  describe('validateProposedMatch()', function () {
    registerFeature10validateProposedMatchFragment1Part1();
    registerFeature10validateProposedMatchFragment1Part2();
    registerFeature10validateProposedMatchFragment1Part3();
    registerFeature10validateProposedMatchFragment1Part4();
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
  registerFeature10validateProposedMatchFragment1();
});
