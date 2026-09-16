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

function registerFeature11retractMatchesForReorgPart1() {
  it('marks rows retracted and restores committed capacity', async function () {
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub();
    hub.db.doQuery.onFirstCall().resolves([{
      match_id: 'mid1',
      a_chain: 'DOGE',
      a_action_index: 7,
      a_amount: '20',
      b_chain: 'LTC',
      b_action_index: 1,
      b_amount: '40'
    }]);
    hub.db.doQuery.resolves([]);
    let eng = new CrossChainDexEngine(hub);
    eng.applyCommit({
      a_chain: 'DOGE',
      a_action_index: 7,
      a_amount: '20',
      b_chain: 'LTC',
      b_action_index: 1,
      b_amount: '40'
    }, +1);
    await eng.retractMatchesForReorg('DOGE', 7);
    expect(eng.committed.get('LTC:1')).to.deep.equal({
      give: '0',
      get: '0'
    });
    expect(eng.committed.get('DOGE:7')).to.deep.equal({
      give: '0',
      get: '0'
    });
  });
  it('broadcasts deletion when broadcaster is available', async function () {
    let broadcaster = {
      broadcastDeletion: sinon.stub(),
      broadcastRow: sinon.stub()
    };
    let hub = makeDexHub({
      hubDbBroadcaster: broadcaster
    });
    hub.db.doQuery = sinon.stub();
    hub.db.doQuery.onFirstCall().resolves([{
      match_id: 'mid1',
      a_chain: 'BTC',
      a_action_index: 5,
      a_amount: '1',
      b_chain: 'LTC',
      b_action_index: 8,
      b_amount: '2'
    }]);
    hub.db.doQuery.resolves([]);
    let eng = new CrossChainDexEngine(hub);
    eng.broadcaster = broadcaster;
    await eng.retractMatchesForReorg('BTC', 5);
    expect(broadcaster.broadcastDeletion.calledOnce).to.be.true;
  });
}
function registerFeature11retractMatchesForReorgPart2() {
  it('handles empty result set gracefully', async function () {
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub().resolves([]);
    let eng = new CrossChainDexEngine(hub);
    await eng.retractMatchesForReorg('BTC', 999);
  });
  it('bounds both legs to a closed range and carries to_action_index on the broadcast (item 5296)', async function () {
    let broadcaster = {
      broadcastDeletion: sinon.stub(),
      broadcastRow: sinon.stub()
    };
    let hub = makeDexHub({
      hubDbBroadcaster: broadcaster
    });
    hub.db.doQuery = sinon.stub();
    hub.db.doQuery.onFirstCall().resolves([{
      match_id: 'mid1',
      a_chain: 'BTC',
      a_action_index: 5,
      a_amount: '1',
      b_chain: 'LTC',
      b_action_index: 8,
      b_amount: '2'
    }]);
    hub.db.doQuery.resolves([]);
    let eng = new CrossChainDexEngine(hub);
    eng.broadcaster = broadcaster;
    await eng.retractMatchesForReorg('BTC', 5, 75);

    // The SELECT must carry the bound on BOTH legs with the ceiling param.
    let selectCall = hub.db.doQuery.getCall(0);
    expect(selectCall.args[0]).to.match(/a_action_index >= \? AND a_action_index <= \?/);
    expect(selectCall.args[0]).to.match(/b_action_index >= \? AND b_action_index <= \?/);
    expect(selectCall.args[1]).to.deep.equal(['BTC', 5, 75, 'BTC', 5, 75]);
    expect(broadcaster.broadcastDeletion.firstCall.args[0]).to.deep.include({
      table: 'cross_chain_matches',
      source_chain: 'BTC',
      from_action_index: 5,
      to_action_index: 75
    });
  });
}
function registerFeature11retractMatchesForReorgPart3() {
  it('gen-fences each leg by its OWN generation column and carries retraction_generation (item 5308)', async function () {
    let broadcaster = {
      broadcastDeletion: sinon.stub(),
      broadcastRow: sinon.stub()
    };
    let hub = makeDexHub({
      hubDbBroadcaster: broadcaster
    });
    hub.db.doQuery = sinon.stub();
    hub.db.doQuery.onFirstCall().resolves([{
      match_id: 'mid1',
      a_chain: 'BTC',
      a_action_index: 5,
      a_amount: '1',
      b_chain: 'LTC',
      b_action_index: 8,
      b_amount: '2'
    }]);
    hub.db.doQuery.resolves([]);
    let eng = new CrossChainDexEngine(hub);
    eng.broadcaster = broadcaster;
    await eng.retractMatchesForReorg('BTC', 5, 75, 9);

    // Per-leg fence: a-leg uses a_push_generation, b-leg uses b_push_generation.
    let selectCall = hub.db.doQuery.getCall(0);
    expect(selectCall.args[0]).to.match(/a_action_index <= \? AND a_push_generation <= \?/);
    expect(selectCall.args[0]).to.match(/b_action_index <= \? AND b_push_generation <= \?/);
    // params: [chain, from, to, gen] per leg, concatenated for the two legs.
    expect(selectCall.args[1]).to.deep.equal(['BTC', 5, 75, 9, 'BTC', 5, 75, 9]);
    expect(broadcaster.broadcastDeletion.firstCall.args[0]).to.deep.include({
      table: 'cross_chain_matches',
      source_chain: 'BTC',
      from_action_index: 5,
      to_action_index: 75,
      retraction_generation: 9
    });
  });

  // a supplied-but-malformed bound must ABORT before the SELECT. Fail-open
  // here widened a fenced rollback into an open-ended retraction that also restored
  // capacity via applyCommit(-1) and broadcast the widened event to peers.
}
function registerFeature11retractMatchesForReorgPart4() {
  // a supplied-but-malformed bound must ABORT before the SELECT. Fail-open
  // here widened a fenced rollback into an open-ended retraction that also restored
  // capacity via applyCommit(-1) and broadcast the widened event to peers.
  it('aborts on a supplied-but-malformed bound instead of widening the retraction', async function () {
    for (const args of [['BTC', 'abc'], ['BTC', 5, 'abc'], ['BTC', 5, 75, 'abc'], ['BTC', 5, 1]]) {
      let broadcaster = {
        broadcastDeletion: sinon.stub(),
        broadcastRow: sinon.stub()
      };
      let hub = makeDexHub({
        hubDbBroadcaster: broadcaster
      });
      hub.db.doQuery = sinon.stub().resolves([]);
      let eng = new CrossChainDexEngine(hub);
      eng.broadcaster = broadcaster;
      let threw = false;
      try {
        await eng.retractMatchesForReorg(...args);
      } catch (e) {
        threw = /^invalid /.test(e.message);
      }
      expect(threw).to.equal(true, 'expected abort for ' + JSON.stringify(args));
      expect(hub.db.doQuery.called).to.equal(false);
      expect(broadcaster.broadcastDeletion.called).to.equal(false);
    }
  });

  // The absent-bound contract (older indexers omit to/generation) must survive the guard.
  it('still treats an ABSENT bound as open-ended and unfenced', async function () {
    let hub = makeDexHub();
    hub.db.doQuery = sinon.stub().resolves([]);
    let eng = new CrossChainDexEngine(hub);
    await eng.retractMatchesForReorg('BTC', 5, null, undefined);
    let selectCall = hub.db.doQuery.getCall(0);
    expect(selectCall.args[0]).to.not.match(/<= \?/);
    expect(selectCall.args[1]).to.deep.equal(['BTC', 5, 'BTC', 5]);
  });
}
function registerFeature11retractMatchesForReorg() {
  describe('retractMatchesForReorg()', function () {
    registerFeature11retractMatchesForReorgPart1();
    registerFeature11retractMatchesForReorgPart2();
    registerFeature11retractMatchesForReorgPart3();
    registerFeature11retractMatchesForReorgPart4();
  });
}
function registerFeature12resolveCapabilityValidatorsPart1() {
  it('returns snapshot validators when capSnapshot provides them', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    eng.capSnapshot = {
      getSnapshot: sinon.stub().resolves({
        validators: [{
          pubkey: 'p1',
          amount: '9'
        }]
      })
    };
    let v = await eng.resolveCapabilityValidators('cross_chain', 100);
    expect(v).to.have.length(1);
    expect(v[0].pubkey).to.equal('p1');
  });
  it('seeds this hub\'s pubkey when no snapshot and _seedLocalValidator=true', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    eng.capSnapshot = null;
    eng._seedLocalValidator = true;
    let v = await eng.resolveCapabilityValidators('cross_chain', 100);
    expect(v).to.have.length(1);
    expect(v[0].pubkey).to.equal(eng.identity.getPubkeyHex());
  });
  it('returns empty when no snapshot and _seedLocalValidator=false', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    eng.capSnapshot = null;
    eng._seedLocalValidator = false;
    expect(await eng.resolveCapabilityValidators('cross_chain', 100)).to.have.length(0);
  });
}
function registerFeature12resolveCapabilityValidators() {
  describe('resolveCapabilityValidators()', function () {
    registerFeature12resolveCapabilityValidatorsPart1();
  });
}
function registerFeature13resolveSnapshotBlockPart1() {
  it('delegates to hub.resolveBtcLatestBlock', async function () {
    let hub = makeDexHub();
    hub.resolveBtcLatestBlock = sinon.stub().resolves(500);
    expect(await new CrossChainDexEngine(hub).resolveSnapshotBlock()).to.equal(500);
  });
  it('falls back to XDEX_SNAPSHOT_BLOCK override when BTC tip is null', async function () {
    let hub = makeDexHub();
    hub.resolveBtcLatestBlock = sinon.stub().resolves(null);
    let eng = new CrossChainDexEngine(hub);
    eng._snapshotBlockOverride = 42;
    expect(await eng.resolveSnapshotBlock()).to.equal(42);
  });
  it('returns null when no BTC tip and no override', async function () {
    let hub = makeDexHub();
    hub.resolveBtcLatestBlock = sinon.stub().resolves(null);
    let eng = new CrossChainDexEngine(hub);
    eng._snapshotBlockOverride = NaN;
    expect(await eng.resolveSnapshotBlock()).to.be.null;
  });
}
function registerFeature13resolveSnapshotBlock() {
  describe('resolveSnapshotBlock()', function () {
    registerFeature13resolveSnapshotBlockPart1();
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
  registerFeature11retractMatchesForReorg();
  registerFeature12resolveCapabilityValidators();
  registerFeature13resolveSnapshotBlock();
});
