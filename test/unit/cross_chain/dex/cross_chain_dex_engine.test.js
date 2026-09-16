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

function registerFeature1constructorPart1() {
  it('initialises the committed ledger as an empty Map', function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    expect(eng.committed).to.be.instanceOf(Map);
    expect(eng.committed.size).to.equal(0);
    expect(eng._inflight).to.be.instanceOf(Set);
  });
  it('reads per-coin indexer URLs from config', function () {
    let eng = new CrossChainDexEngine(makeDexHub({
      p2pConfig: {
        BTC_INDEXER_URL: 'http://btc/rpc'
      }
    }));
    expect(eng.indexers.BTC.url).to.equal('http://btc/rpc');
  });
  it('falls back to DEFAULT_POLL_MS when config is absent', function () {
    expect(new CrossChainDexEngine(makeDexHub()).pollMs).to.equal(15000);
  });
  it('reads XDEX_POLL_MS from env', function () {
    process.env.XDEX_POLL_MS = '3000';
    expect(new CrossChainDexEngine(makeDexHub()).pollMs).to.equal(3000);
  });
}
function registerFeature1constructor() {
  describe('constructor', function () {
    registerFeature1constructorPart1();
  });
}
function registerFeature2rebuildCommittedPart1() {
  it('sums finalized-match fills into both legs', async function () {
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub().resolves([{
      a_chain: 'DOGE',
      a_action_index: 7,
      a_amount: '20',
      b_chain: 'LTC',
      b_action_index: 1,
      b_amount: '40'
    }]);
    let eng = new CrossChainDexEngine(hub);
    await eng.rebuildCommitted();
    // DOGE:7 gave 20 / received 40 ; LTC:1 gave 40 / received 20
    expect(eng.committed.get('DOGE:7')).to.deep.equal({
      give: '20',
      get: '40'
    });
    expect(eng.committed.get('LTC:1')).to.deep.equal({
      give: '40',
      get: '20'
    });
  });

  // A missing table is the ONE benign rebuild failure: the schema has not been
  // created, so an empty ledger is genuinely correct and the hub may match.
  it('treats a missing table as an empty ledger and stays ready', async function () {
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub().rejects(Object.assign(new Error("Table 'xchain.cross_chain_matches' doesn't exist"), {
      errno: 1146,
      code: 'ER_NO_SUCH_TABLE'
    }));
    let eng = new CrossChainDexEngine(hub);
    expect(await eng.rebuildCommitted()).to.equal(true);
    expect(eng.committed.size).to.equal(0);
    expect(eng._committedReady).to.equal(true);
  });

  // Every other failure must NOT resolve with ZERO reservations: start() would then
  // match against an empty ledger and re-offer escrow that finalized matches hold.
}
function registerFeature2rebuildCommittedPart2() {
  // Every other failure must NOT resolve with ZERO reservations: start() would then
  // match against an empty ledger and re-offer escrow that finalized matches hold.
  it('keeps the previous ledger and goes NOT ready on any other DB failure', async function () {
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub().rejects(Object.assign(new Error('Lock wait timeout exceeded'), {
      errno: 1205,
      code: 'ER_LOCK_WAIT_TIMEOUT'
    }));
    let eng = new CrossChainDexEngine(hub);
    eng.committed.set('LTC:1', {
      give: '40',
      get: '20'
    });
    expect(await eng.rebuildCommitted()).to.equal(false);
    expect(eng._committedReady, 'a failed rebuild must not leave the hub matching').to.equal(false);
    expect(eng.committed.get('LTC:1'), 'the prior reservations must survive').to.deep.equal({
      give: '40',
      get: '20'
    });
  });
  it('proposes nothing and refuses to co-sign while the ledger is not ready', async function () {
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub().rejects(Object.assign(new Error('gone'), {
      errno: 1205
    }));
    let eng = new CrossChainDexEngine(hub);
    eng.indexers.BTC.url = 'http://btc'; // without this the fetch is unreachable anyway
    let fetch = sinon.stub(eng, 'fetchOpenOffers').resolves({
      network: 'regtest',
      orders: []
    });
    await eng.rebuildCommitted();
    await eng.discoverAndMatch();
    expect(fetch.called, 'a not-ready tick must not even read the books').to.equal(false);
    expect(await eng.validateProposedMatch({
      a_chain: 'LTC',
      b_chain: 'DOGE'
    })).to.equal(false);
  });
}
function registerFeature2rebuildCommittedPart3() {
  it('resumes matching once a later rebuild succeeds', async function () {
    let hub = makeDexHub();
    let q = sinon.stub();
    q.onFirstCall().rejects(Object.assign(new Error('gone'), {
      errno: 1205
    }));
    q.resolves([{
      a_chain: 'DOGE',
      a_action_index: 7,
      a_amount: '20',
      b_chain: 'LTC',
      b_action_index: 1,
      b_amount: '40'
    }]);
    hub.db.doQuery = q;
    let eng = new CrossChainDexEngine(hub);
    eng.indexers.BTC.url = 'http://btc'; // same reachability guard as above
    let fetch = sinon.stub(eng, 'fetchOpenOffers').resolves({
      network: 'regtest',
      orders: []
    });
    await eng.rebuildCommitted();
    expect(eng._committedReady).to.equal(false);
    await eng.discoverAndMatch(); // retries the rebuild on the poll tick
    expect(eng._committedReady).to.equal(true);
    expect(eng.committed.get('DOGE:7')).to.deep.equal({
      give: '20',
      get: '40'
    });
    expect(fetch.called, 'the recovered tick goes on to read the books').to.equal(true);
  });
}
function registerFeature2rebuildCommitted() {
  describe('rebuildCommitted()', function () {
    registerFeature2rebuildCommittedPart1();
    registerFeature2rebuildCommittedPart2();
    registerFeature2rebuildCommittedPart3();
  });
}
function registerFeature3effectiveRemainingPart1() {
  it('returns full amounts when nothing is committed', function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a
    } = makeOrderPair();
    let r = eng.effectiveRemaining(a);
    expect(r.give).to.equal('100');
    expect(r.get).to.equal('50');
  });
  it('subtracts committed fills and never goes below zero', function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let {
      a
    } = makeOrderPair();
    eng.committed.set('LTC:1', {
      give: '40',
      get: '20'
    });
    let r = eng.effectiveRemaining(a);
    expect(r.give).to.equal('60');
    expect(r.get).to.equal('30');
  });
  it('treats an ownership side as a unit (amount 1)', function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    let off = {
      home_coin: 'LTC',
      action_index: 9,
      give_ownership: 1,
      give_amount: '1',
      get_amount: '5',
      get_ownership: 0
    };
    expect(eng.effectiveRemaining(off).give).to.equal('1');
  });
}
function registerFeature3effectiveRemaining() {
  describe('effectiveRemaining()', function () {
    registerFeature3effectiveRemainingPart1();
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
  registerFeature1constructor();
  registerFeature2rebuildCommitted();
  registerFeature3effectiveRemaining();
});
