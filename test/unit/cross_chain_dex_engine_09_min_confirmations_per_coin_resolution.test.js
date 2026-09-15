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

const feature18minConfirmationsPerCoinResolutionCLEAR = ['XDEX_MIN_CONFIRMATIONS', 'XDEX_MIN_CONFIRMATIONS_BTC', 'XDEX_MIN_CONFIRMATIONS_DOGE'];
let feature18minConfirmationsPerCoinResolutionSaved = {};
function registerFeature18minConfirmationsPerCoinResolutionPart1() {
  it('defaults to the per-chain registry depths (BTC 6 / LTC 12 / DOGE 60)', function () {
    const coins = require('../../src/coins');
    let eng = new CrossChainDexEngine(makeDexHub());
    expect(eng.minConfirmations.BTC).to.equal(coins.DEFAULT_CONFIRMATIONS.BTC);
    expect(eng.minConfirmations.LTC).to.equal(coins.DEFAULT_CONFIRMATIONS.LTC);
    expect(eng.minConfirmations.DOGE).to.equal(coins.DEFAULT_CONFIRMATIONS.DOGE);
  });
  it('flat XDEX_MIN_CONFIRMATIONS pins every coin (regtest venue knob)', function () {
    process.env.XDEX_MIN_CONFIRMATIONS = '1';
    let eng = new CrossChainDexEngine(makeDexHub());
    expect(eng.minConfirmations).to.deep.equal({
      BTC: 1,
      LTC: 1,
      DOGE: 1
    });
  });
  it('per-coin XDEX_MIN_CONFIRMATIONS_<COIN> beats the flat knob', function () {
    process.env.XDEX_MIN_CONFIRMATIONS = '1';
    process.env.XDEX_MIN_CONFIRMATIONS_DOGE = '30';
    let eng = new CrossChainDexEngine(makeDexHub());
    expect(eng.minConfirmations.DOGE).to.equal(30);
    expect(eng.minConfirmations.BTC).to.equal(1);
  });

  // XDEX-CONF-1 / CF-1: an override may only RAISE the depth on mainnet and testnet,
  // because a lowered one lets this hub co-sign an escrow the federation calls reorg-able.
  for (const net of ['mainnet', 'testnet']) {
    it('clamps a lowered override back up to the per-coin floor on ' + net, function () {
      const coins = require('../../src/coins');
      process.env.XDEX_MIN_CONFIRMATIONS = '1';
      process.env.XDEX_MIN_CONFIRMATIONS_DOGE = '2';
      let hub = makeDexHub();
      hub.network = net;
      let warn = sinon.stub(console, 'warn');
      let eng;
      try {
        eng = new CrossChainDexEngine(hub);
      } finally {
        warn.restore();
      }
      expect(eng.minConfirmations.BTC).to.equal(coins.DEFAULT_CONFIRMATIONS.BTC);
      expect(eng.minConfirmations.LTC).to.equal(coins.DEFAULT_CONFIRMATIONS.LTC);
      expect(eng.minConfirmations.DOGE).to.equal(coins.DEFAULT_CONFIRMATIONS.DOGE);
      expect(warn.callCount).to.equal(3);
    });
    it('still honours an override that RAISES the depth on ' + net, function () {
      const coins = require('../../src/coins');
      process.env.XDEX_MIN_CONFIRMATIONS_BTC = String(coins.DEFAULT_CONFIRMATIONS.BTC + 5);
      let hub = makeDexHub();
      hub.network = net;
      let eng = new CrossChainDexEngine(hub);
      expect(eng.minConfirmations.BTC).to.equal(coins.DEFAULT_CONFIRMATIONS.BTC + 5);
    });
  }
}
function registerFeature18minConfirmationsPerCoinResolutionPart2() {
  it('leaves the regtest venue pin of 1 untouched', function () {
    process.env.XDEX_MIN_CONFIRMATIONS = '1';
    let hub = makeDexHub();
    hub.network = 'regtest';
    let eng = new CrossChainDexEngine(hub);
    expect(eng.minConfirmations).to.deep.equal({
      BTC: 1,
      LTC: 1,
      DOGE: 1
    });
  });
}
function registerFeature18minConfirmationsPerCoinResolution() {
  describe('minConfirmations per-coin resolution', function () {
    beforeEach(function () {
      for (let k of feature18minConfirmationsPerCoinResolutionCLEAR) {
        feature18minConfirmationsPerCoinResolutionSaved[k] = process.env[k];
        delete process.env[k];
      }
    });
    afterEach(function () {
      for (let k of feature18minConfirmationsPerCoinResolutionCLEAR) {
        if (feature18minConfirmationsPerCoinResolutionSaved[k] !== undefined) process.env[k] = feature18minConfirmationsPerCoinResolutionSaved[k];else delete process.env[k];
      }
    });
    registerFeature18minConfirmationsPerCoinResolutionPart1();
    registerFeature18minConfirmationsPerCoinResolutionPart2();
  });
}
const feature19insertMatchRowRetractedRowReviveReviveRow = () => ({
  match_id: 'm'.repeat(64),
  validator_signatures: '[]',
  finalizing_view: 0,
  effective_time: 1700000000,
  a_chain: 'DOGE',
  a_action_index: 7,
  a_kind: 'order',
  a_tick: 'DOGT',
  a_amount: '20',
  a_filled_before: '0',
  a_ownership: 0,
  a_payout_addr: 'Da',
  a_payout_legs: null,
  b_chain: 'LTC',
  b_action_index: 1,
  b_kind: 'order',
  b_tick: 'LTCT',
  b_amount: '40',
  b_filled_before: '0',
  b_ownership: 0,
  b_payout_addr: 'Lb',
  b_payout_legs: null,
  a_push_generation: 0,
  b_push_generation: 0
});
function registerFeature19insertMatchRowRetractedRowRevivePart1() {
  it('revives a retracted row to finalized when INSERT IGNORE no-ops', async function () {
    let hub = makeDexHub();
    let q = sinon.stub();
    q.onCall(0).resolves({
      affectedRows: 0
    }); // INSERT IGNORE hits the retained retracted row
    q.onCall(1).resolves({
      affectedRows: 1
    }); // UPDATE ... WHERE status='retracted' revives it
    q.resolves([]); // broadcast re-read
    hub.db.doQuery = q;
    let eng = new CrossChainDexEngine(hub);
    let inserted = await eng._insertMatchRow(feature19insertMatchRowRetractedRowReviveReviveRow());
    expect(inserted).to.be.true;
    let updateSql = q.getCall(1).args[0];
    expect(updateSql).to.match(/UPDATE cross_chain_matches SET status = 'finalized'/);
    expect(updateSql).to.match(/status = 'retracted'/);
  });
  it('stays a no-op when the existing row is already finalized (no double-count)', async function () {
    let hub = makeDexHub();
    let q = sinon.stub();
    q.onCall(0).resolves({
      affectedRows: 0
    }); // genuine duplicate finalize
    q.onCall(1).resolves({
      affectedRows: 0
    }); // revive matches nothing (row is 'finalized', not 'retracted')
    q.resolves([]);
    hub.db.doQuery = q;
    let eng = new CrossChainDexEngine(hub);
    let inserted = await eng._insertMatchRow(feature19insertMatchRowRetractedRowReviveReviveRow());
    expect(inserted).to.be.false;
  });

  // The INSERT names its columns, so a column added to one side only fails
  // at runtime on the venue rather than here. The chain-identity stamp (btc_chain_id)
  // is the newest of them; the assertion is the general rule, not that one column.
}
function registerFeature19insertMatchRowRetractedRowRevivePart2() {
  // The INSERT names its columns, so a column added to one side only fails
  // at runtime on the venue rather than here. The chain-identity stamp (btc_chain_id)
  // is the newest of them; the assertion is the general rule, not that one column.
  it('names only columns the cross_chain_matches DDL declares', async function () {
    let hub = makeDexHub();
    let q = sinon.stub().resolves({
      affectedRows: 1
    });
    hub.db.doQuery = q;
    hub.db.getChainTip = sinon.stub().resolves({
      blockHeight: 131,
      blockTime: 1,
      chainId: 'a'.repeat(64)
    });
    let eng = new CrossChainDexEngine(hub);
    await eng._insertMatchRow(feature19insertMatchRowRetractedRowReviveReviveRow());
    let sql = String(q.getCall(0).args[0]);
    let cols = sql.match(/\(([^)]*)\) VALUES/)[1].split(',').map(s => s.trim());
    let ddl = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'sql', 'cross_chain_matches.sql'), 'utf8');
    let declared = new Set();
    for (let line of ddl.split('\n')) {
      let m = line.match(/^\s{4}([a-z_]+)\s+[A-Z]/);
      if (m) declared.add(m[1]);
    }
    for (let c of cols) expect(declared.has(c), 'INSERT names a column the DDL does not declare: ' + c).to.be.true;
    expect(cols).to.include('btc_chain_id');
    expect(q.getCall(0).args[1]).to.have.lengthOf(cols.length);
  });
}
function registerFeature19insertMatchRowRetractedRowRevive() {
  describe('_insertMatchRow(): retracted-row revive', function () {
    registerFeature19insertMatchRowRetractedRowRevivePart1();
    registerFeature19insertMatchRowRetractedRowRevivePart2();
  });
}
function registerFeature20stopPart1() {
  it('clears the poll timer and stops consensus', async function () {
    let eng = new CrossChainDexEngine(makeDexHub());
    eng._pollTimer = setTimeout(() => {}, 100000);
    let stopSpy = sinon.stub(eng.consensus, 'stop').resolves();
    await eng.stop();
    expect(eng._pollTimer).to.be.null;
    expect(stopSpy.calledOnce).to.be.true;
  });
}
function registerFeature20stop() {
  describe('stop()', function () {
    registerFeature20stopPart1();
  });
}
function registerFeature21eventEmitterPart1() {
  it('emits match:finalized when a match is inserted', async function () {
    let hub = makeDexHub();
    hub._resolveBtcLatestBlock = sinon.stub().resolves(100);
    // _insertMatchRow reads affectedRows then re-reads the row; consensus single-node finalizes inline.
    hub.db.doQuery = sinon.stub().resolves({
      affectedRows: 1
    });
    let eng = new CrossChainDexEngine(hub);
    eng._snapshotBlockOverride = 100;
    eng._seedLocalValidator = true;
    sinon.stub(eng, '_persistCapabilitySnapshot').resolves(1);
    let {
      a,
      b
    } = makeOrderPair();
    let desc = eng.tryMatch(a, b);
    let emitted = false;
    eng.on('match:finalized', () => {
      emitted = true;
    });
    await eng.finalizeMatch(desc);
    await new Promise(r => setImmediate(r));
    expect(emitted).to.be.true;
  });
}
function registerFeature21eventEmitter() {
  describe('EventEmitter', function () {
    registerFeature21eventEmitterPart1();
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
  registerFeature18minConfirmationsPerCoinResolution();
  registerFeature19insertMatchRowRetractedRowRevive();
  registerFeature20stop();
  registerFeature21eventEmitter();
});
