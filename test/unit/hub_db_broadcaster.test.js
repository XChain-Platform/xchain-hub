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

const sinon              = require('sinon');
const { expect }         = require('chai');
const proxyquire         = require('proxyquire');
const { DB_METHODS }     = require('../helpers/mockHub');

// ────────────────────────────────────────────────────────────────────────────
// Load HubDbBroadcaster with WebSocket stubbed
// ────────────────────────────────────────────────────────────────────────────

let WS_OPEN;
let HubDbBroadcaster;

function loadModule() {
    // WebSocket.OPEN = 1 in the real module
    WS_OPEN = 1;
    const WsMock = { OPEN: WS_OPEN };
    HubDbBroadcaster = proxyquire('../../src/peers/hub_db_broadcaster', { ws: WsMock });
}

// ────────────────────────────────────────────────────────────────────────────
// Helper: make a mock WebSocket
// ────────────────────────────────────────────────────────────────────────────

function makeMockWs(overrides) {
    let ws = {
        readyState:     WS_OPEN,
        bufferedAmount: 0,
        _hubBuffered:   0,
        send:           sinon.stub(),
        close:          sinon.stub(),
        on:             sinon.stub(),
        ...(overrides || {})
    };
    // Capture event handlers registered by addSubscriber
    ws._handlers = {};
    ws.on.callsFake((event, fn) => { ws._handlers[event] = fn; });
    return ws;
}

function makeDb(overrides) {
    return {
        // Spread first: the ready frame's max_id lookups now call named getters
        // (getPriceSnapshotsMaxId and its seven siblings) instead of issuing SQL
        // inline, and every one of them calls this.doQuery, which stays whichever
        // doQuery this call site declares afterwards.
        ...DB_METHODS,
        doQuery: sinon.stub().resolves([]),
        ...(overrides || {})
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

function registerFeature1constructorPart1() {
  it('initialises with an empty subscriber set', function () {
    let b = new HubDbBroadcaster({});
    expect(b.getSubscriberCount()).to.equal(0);
  });
  it('reads WS_BACKPRESSURE_LIMIT from config', function () {
    let b = new HubDbBroadcaster({
      WS_BACKPRESSURE_LIMIT: '100'
    });
    expect(b.maxBufferedMessages).to.equal(100);
  });
  it('uses default backpressure limit of 50 when not configured', function () {
    let b = new HubDbBroadcaster({});
    expect(b.maxBufferedMessages).to.equal(50);
  });

  // A NaN cap makes every `size >= cap` comparison false, so an unparseable
  // knob would unarm the caps entirely rather than degrade to the default.
  it('falls back to the defaults on unparseable knobs', function () {
    sinon.stub(console, 'warn');
    let b = new HubDbBroadcaster({
      WS_MAX_PER_IP: 'many',
      WS_MAX_SUBSCRIBERS: 'lots',
      WS_BACKPRESSURE_LIMIT: 'some',
      WS_WATERMARK_INTERVAL_MS: 'soon'
    });
    expect(b.maxPerIp).to.equal(100);
    expect(b.maxSubscribers).to.equal(1000);
    expect(b.maxBufferedMessages).to.equal(50);
    expect(b.watermarkIntervalMs).to.equal(10000);
    b.stop();
  });
  it('falls back to the defaults on negative and zero knobs', function () {
    sinon.stub(console, 'warn');
    let b = new HubDbBroadcaster({
      WS_MAX_PER_IP: '-1',
      WS_MAX_SUBSCRIBERS: '-100',
      WS_BACKPRESSURE_LIMIT: '0',
      WS_WATERMARK_INTERVAL_MS: '-5000'
    });
    expect(b.maxPerIp).to.equal(100);
    expect(b.maxSubscribers).to.equal(1000);
    expect(b.maxBufferedMessages).to.equal(50);
    expect(b.watermarkIntervalMs).to.equal(10000);
    b.stop();
  });
}
function registerFeature1constructorPart2() {
  it('still honours well-formed positive knobs', function () {
    let b = new HubDbBroadcaster({
      WS_MAX_PER_IP: '7',
      WS_MAX_SUBSCRIBERS: '9',
      WS_BACKPRESSURE_LIMIT: '11',
      WS_WATERMARK_INTERVAL_MS: '2500'
    });
    expect(b.maxPerIp).to.equal(7);
    expect(b.maxSubscribers).to.equal(9);
    expect(b.maxBufferedMessages).to.equal(11);
    expect(b.watermarkIntervalMs).to.equal(2500);
    b.stop();
  });
}
function registerFeature1constructor() {
  describe('constructor', function () {
    registerFeature1constructorPart1();
    registerFeature1constructorPart2();
  });
}
function registerFeature2addSubscriberPart1() {
  it('adds the subscriber and increments count', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    expect(b.getSubscriberCount()).to.equal(1);
  });
  it('sends a ready message to the new subscriber', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    expect(ws.send.calledOnce).to.be.true;
    let msg = JSON.parse(ws.send.firstCall.args[0]);
    expect(msg.type).to.equal('ready');
  });
  it('includes max_ids when db is provided', async function () {
    let db = makeDb({
      doQuery: sinon.stub().onFirstCall().resolves([{
        max_id: 10
      }]).onSecondCall().resolves([{
        max_id: 20
      }]).onThirdCall().resolves([{
        max_id: 30
      }]).onCall(3).resolves([{
        max_id: 40
      }])
    });
    let b = new HubDbBroadcaster({}, db);
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    let msg = JSON.parse(ws.send.firstCall.args[0]);
    expect(msg.max_ids).to.have.property('price_snapshots', 10);
    expect(msg.max_ids).to.have.property('oracle_prices', 20);
  });

  // The consumer's window-repair catch-up (xchain-indexer HubDbSync) is gated on
  // this frame carrying an entry for the table, and skips any table it does not
  // find here. Both members of the indexer's HUB_STATE_TABLES mirror set are
  // outside its FULL_REPAGE_TABLES, so the advertised ceiling is the only repair
  // they get; anchor_reward_attestations was omitted when it joined the set, which
  // silently disabled the repair for the table the BTC indexer derives
  // COLLECT-spendable validator_rewards from. Asserted by table name so the next
  // mirror-set addition has to be advertised too.
}
function registerFeature2addSubscriberPart2() {
  // The consumer's window-repair catch-up (xchain-indexer HubDbSync) is gated on
  // this frame carrying an entry for the table, and skips any table it does not
  // find here. Both members of the indexer's HUB_STATE_TABLES mirror set are
  // outside its FULL_REPAGE_TABLES, so the advertised ceiling is the only repair
  // they get; anchor_reward_attestations was omitted when it joined the set, which
  // silently disabled the repair for the table the BTC indexer derives
  // COLLECT-spendable validator_rewards from. Asserted by table name so the next
  // mirror-set addition has to be advertised too.
  it('advertises a max_id for every hub-state mirror table (state_checkpoints + anchor_reward_attestations)', async function () {
    let asked = [];
    let db = makeDb({
      doQuery: sinon.stub().callsFake(async sql => {
        asked.push(String(sql));
        return [{
          max_id: 7
        }];
      })
    });
    // Spy every named getter the ready frame's max_id scan can reach. The caller
    // wraps each one in a try/catch with an empty catch body (a missing table is
    // not an error), so a getter that is not a function on db throws AND is
    // swallowed silently: neither the missing-key case above nor a thrown call
    // would otherwise be distinguishable from a healthy empty table. Asserting no
    // spied call threw closes that gap; a future regression that drops one of
    // these named methods from the double fails here loudly instead of quietly
    // reporting 0.
    let methodSpies = Object.keys(DB_METHODS).map(name => sinon.spy(db, name));
    let b = new HubDbBroadcaster({}, db);
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    for (const spy of methodSpies) {
      for (let i = 0; i < spy.callCount; i++) {
        expect(spy.getCall(i).threw(), spy.name + ' threw and was swallowed by the ready-frame scan').to.equal(false);
      }
    }
    let msg = JSON.parse(ws.send.firstCall.args[0]);
    for (const table of ['state_checkpoints', 'anchor_reward_attestations']) {
      expect(msg.max_ids, 'ready frame omits ' + table + ', so the consumer never runs its gap catch-up for it').to.have.property(table, 7);
      expect(asked.some(sql => sql.includes('FROM ' + table)), 'no MAX(id) query was issued for ' + table).to.equal(true);
    }
    // Append-only table: an unfiltered ceiling is what the snapshot feed serves,
    // so a status filter here would strand the consumer's catch-up.
    expect(asked.some(sql => sql.includes('FROM anchor_reward_attestations') && sql.includes('status'))).to.equal(false);
  });
  it('handles DB error in max_id queries gracefully', async function () {
    let db = makeDb({
      doQuery: sinon.stub().rejects(new Error('db error'))
    });
    let b = new HubDbBroadcaster({}, db);
    let ws = makeMockWs();
    await b.addSubscriber(ws); // must not throw
    expect(ws.send.calledOnce).to.be.true;
  });
}
function registerFeature2addSubscriberPart3() {
  it('handles ws.send() throwing during ready message gracefully', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs({
      send: sinon.stub().throws(new Error('ws broken'))
    });
    await b.addSubscriber(ws); // must not throw
  });
  it('registers close and error handlers on the WebSocket', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    expect(ws.on.calledWith('close')).to.be.true;
    expect(ws.on.calledWith('error')).to.be.true;
  });
  it('removes subscriber when close event fires', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    expect(b.getSubscriberCount()).to.equal(1);
    // Trigger the close handler
    ws._handlers['close']();
    expect(b.getSubscriberCount()).to.equal(0);
  });
  it('removes subscriber when error event fires', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    ws._handlers['error']();
    expect(b.getSubscriberCount()).to.equal(0);
  });
}
function registerFeature2addSubscriber() {
  describe('addSubscriber()', function () {
    registerFeature2addSubscriberPart1();
    registerFeature2addSubscriberPart2();
    registerFeature2addSubscriberPart3();
  });
}
function registerFeature3removeSubscriberPart1() {
  it('decrements subscriber count', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    b.removeSubscriber(ws);
    expect(b.getSubscriberCount()).to.equal(0);
  });
  it('is idempotent (removing twice does not throw)', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    b.removeSubscriber(ws);
    b.removeSubscriber(ws);
    expect(b.getSubscriberCount()).to.equal(0);
  });
}
function registerFeature3removeSubscriber() {
  describe('removeSubscriber()', function () {
    registerFeature3removeSubscriberPart1();
  });
}
function registerFeature4dropAllForResyncPart1() {
  it('closes every subscriber with a retryable code and deregisters it', async function () {
    let b = new HubDbBroadcaster({});
    let ws1 = makeMockWs();
    let ws2 = makeMockWs();
    await b.addSubscriber(ws1);
    await b.addSubscriber(ws2);
    let dropped = b.dropAllForResync('price-round broadcast gap');
    expect(dropped).to.equal(2);
    expect(b.getSubscriberCount()).to.equal(0);
    for (let ws of [ws1, ws2]) {
      expect(ws.close.calledOnce).to.be.true;
      expect(ws.close.firstCall.args[0]).to.equal(1012);
      expect(ws.close.firstCall.args[1]).to.equal('price-round broadcast gap');
    }
  });
  it('clears the per-IP bookkeeping so the reconnect is not counted twice', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws, {
      socket: {
        remoteAddress: '10.0.0.9'
      }
    });
    b.dropAllForResync('gap');
    expect(b.ipConnections.has('10.0.0.9')).to.be.false;
  });
  it('is a no-op with no subscribers and survives a close() that throws', async function () {
    let b = new HubDbBroadcaster({});
    expect(b.dropAllForResync('gap')).to.equal(0);
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    ws.close.throws(new Error('already closed'));
    expect(b.dropAllForResync('gap')).to.equal(1);
    expect(b.getSubscriberCount()).to.equal(0);
  });
}
function registerFeature4dropAllForResync() {
  describe('dropAllForResync()', function () {
    registerFeature4dropAllForResyncPart1();
  });
}
describe('HubDbBroadcaster', function () {
  beforeEach(function () {
    loadModule();
  });
  afterEach(function () {
    sinon.restore();
  });

  // ── Constructor ─────────────────────────────────────────────────────────
  registerFeature1constructor();
  registerFeature2addSubscriber();
  registerFeature3removeSubscriber();
  registerFeature4dropAllForResync();
});
