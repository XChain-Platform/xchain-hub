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
const { DB_METHODS }     = require('../../../helpers/mockHub');

// ────────────────────────────────────────────────────────────────────────────
// Load HubDbBroadcaster with WebSocket stubbed
// ────────────────────────────────────────────────────────────────────────────

let WS_OPEN;
let HubDbBroadcaster;

function loadModule() {
    // WebSocket.OPEN = 1 in the real module
    WS_OPEN = 1;
    const WsMock = { OPEN: WS_OPEN };
    HubDbBroadcaster = proxyquire('../../../../src/peers/hub_db_broadcaster', { ws: WsMock });
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

let feature7broadcastWatermarkCadenceInstrumentationClock = null;
function registerFeature7broadcastWatermarkCadenceInstrumentationPart1() {
  it('sends a watermark stamped with the current wall clock', async function () {
    feature7broadcastWatermarkCadenceInstrumentationClock = sinon.useFakeTimers({
      now: 1785176300000,
      toFake: ['Date', 'setInterval', 'clearInterval']
    });
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    b.broadcastWatermark();
    let msg = JSON.parse(ws.send.lastCall.args[0]);
    expect(msg.type).to.equal('watermark');
    expect(msg.ts).to.equal(1785176300);
  });
  it('fires on the configured interval and records that cadence', function () {
    feature7broadcastWatermarkCadenceInstrumentationClock = sinon.useFakeTimers({
      now: 1785176300000,
      toFake: ['Date', 'setInterval', 'clearInterval']
    });
    let b = new HubDbBroadcaster({
      WS_WATERMARK_INTERVAL_MS: '10000'
    });
    feature7broadcastWatermarkCadenceInstrumentationClock.tick(30000);
    let stats = b.getWatermarkStats();
    expect(stats.interval_ms).to.equal(10000);
    expect(stats.ticks).to.equal(3);
    expect(stats.last_gap_ms).to.equal(10000);
    expect(stats.max_gap_ms).to.equal(10000);
    expect(stats.late_ticks).to.equal(0);
    expect(stats.healthy).to.be.true;
    b.stop();
  });
  it('counts a tick even with no subscribers, but reports zero delivered', function () {
    feature7broadcastWatermarkCadenceInstrumentationClock = sinon.useFakeTimers({
      now: 1785176300000,
      toFake: ['Date', 'setInterval', 'clearInterval']
    });
    let b = new HubDbBroadcaster({});
    feature7broadcastWatermarkCadenceInstrumentationClock.tick(20000);
    let stats = b.getWatermarkStats();
    expect(stats.ticks).to.equal(2);
    expect(stats.sent).to.equal(0);
    expect(stats.subscribers).to.equal(0);
    expect(stats.last_delivered).to.equal(0);
    expect(stats.last_watermark_ts).to.equal(null);
    b.stop();
  });
}
function registerFeature7broadcastWatermarkCadenceInstrumentationPart2() {
  it('reports how many open sockets the heartbeat actually reached', async function () {
    feature7broadcastWatermarkCadenceInstrumentationClock = sinon.useFakeTimers({
      now: 1785176300000,
      toFake: ['Date', 'setInterval', 'clearInterval']
    });
    let b = new HubDbBroadcaster({});
    let open = makeMockWs();
    let shut = makeMockWs({
      readyState: 3 /* CLOSED */
    });
    await b.addSubscriber(open);
    b.subscribers.add(shut); // bypass the ready-message send
    b.broadcastWatermark();
    let stats = b.getWatermarkStats();
    expect(stats.subscribers).to.equal(2);
    expect(stats.last_delivered).to.equal(1);
    expect(stats.sent).to.equal(1);
  });
  it('counts and logs a tick that lands past the late threshold', function () {
    feature7broadcastWatermarkCadenceInstrumentationClock = sinon.useFakeTimers({
      now: 1785176300000,
      toFake: ['Date']
    });
    let warn = sinon.stub(console, 'warn');
    let b = new HubDbBroadcaster({
      WS_WATERMARK_INTERVAL_MS: '10000'
    });
    b.broadcastWatermark(); // first tick: no gap to measure yet
    feature7broadcastWatermarkCadenceInstrumentationClock.tick(45000); // event loop stalled well past 2x interval
    b.broadcastWatermark();
    let stats = b.getWatermarkStats();
    expect(stats.late_ticks).to.equal(1);
    expect(stats.last_gap_ms).to.equal(45000);
    expect(stats.max_gap_ms).to.equal(45000);
    expect(warn.calledOnce).to.be.true;
    expect(warn.firstCall.args[0]).to.contain('watermark heartbeat late');
    b.stop();
  });
  it('does not count a tick that is merely a little late', function () {
    feature7broadcastWatermarkCadenceInstrumentationClock = sinon.useFakeTimers({
      now: 1785176300000,
      toFake: ['Date']
    });
    let b = new HubDbBroadcaster({
      WS_WATERMARK_INTERVAL_MS: '10000'
    });
    b.broadcastWatermark();
    feature7broadcastWatermarkCadenceInstrumentationClock.tick(19000); // late, but inside the 2x tolerance
    b.broadcastWatermark();
    let stats = b.getWatermarkStats();
    expect(stats.late_ticks).to.equal(0);
    expect(stats.last_gap_ms).to.equal(19000);
    b.stop();
  });
}
function registerFeature7broadcastWatermarkCadenceInstrumentationPart3() {
  it('derives the late threshold from the configured interval', function () {
    let b = new HubDbBroadcaster({
      WS_WATERMARK_INTERVAL_MS: '2000'
    });
    expect(b.getWatermarkStats().late_threshold_ms).to.equal(4000);
    b.stop();
  });
  it('honours WS_WATERMARK_LATE_FACTOR from config', function () {
    let b = new HubDbBroadcaster({
      WS_WATERMARK_INTERVAL_MS: '10000',
      WS_WATERMARK_LATE_FACTOR: '3'
    });
    expect(b.watermarkLateFactor).to.equal(3);
    expect(b.getWatermarkStats().late_threshold_ms).to.equal(30000);
    b.stop();
  });
  it('falls back to the default factor when the knob is below 1 or unparseable', function () {
    let low = new HubDbBroadcaster({
      WS_WATERMARK_INTERVAL_MS: '10000',
      WS_WATERMARK_LATE_FACTOR: '0.5'
    });
    expect(low.watermarkLateFactor).to.equal(2);
    low.stop();
    let junk = new HubDbBroadcaster({
      WS_WATERMARK_INTERVAL_MS: '10000',
      WS_WATERMARK_LATE_FACTOR: 'soon'
    });
    expect(junk.watermarkLateFactor).to.equal(2);
    junk.stop();
  });
  it('reports unhealthy once the last tick is older than the threshold', function () {
    feature7broadcastWatermarkCadenceInstrumentationClock = sinon.useFakeTimers({
      now: 1785176300000,
      toFake: ['Date']
    });
    let b = new HubDbBroadcaster({
      WS_WATERMARK_INTERVAL_MS: '10000'
    });
    b.broadcastWatermark();
    expect(b.getWatermarkStats().healthy).to.be.true;
    feature7broadcastWatermarkCadenceInstrumentationClock.tick(15000);
    expect(b.getWatermarkStats().healthy).to.be.true; // still inside 2x
    feature7broadcastWatermarkCadenceInstrumentationClock.tick(10000); // 25s since last tick
    let stats = b.getWatermarkStats();
    expect(stats.healthy).to.be.false;
    expect(stats.last_tick_age_ms).to.equal(25000);
    b.stop();
  });
}
function registerFeature7broadcastWatermarkCadenceInstrumentationPart4() {
  it('ages from construction when the timer has never fired, so a dead heartbeat is not read as fine', function () {
    feature7broadcastWatermarkCadenceInstrumentationClock = sinon.useFakeTimers({
      now: 1785176300000,
      toFake: ['Date']
    });
    let b = new HubDbBroadcaster({
      WS_WATERMARK_INTERVAL_MS: '10000'
    });
    expect(b.getWatermarkStats().healthy).to.be.true;
    feature7broadcastWatermarkCadenceInstrumentationClock.tick(60000);
    let stats = b.getWatermarkStats();
    expect(stats.ticks).to.equal(0);
    expect(stats.last_tick_age_ms).to.equal(60000);
    expect(stats.healthy).to.be.false;
    b.stop();
  });
  it('evaluates age against an injected instant', function () {
    feature7broadcastWatermarkCadenceInstrumentationClock = sinon.useFakeTimers({
      now: 1785176300000,
      toFake: ['Date']
    });
    let b = new HubDbBroadcaster({
      WS_WATERMARK_INTERVAL_MS: '10000'
    });
    b.broadcastWatermark();
    let stats = b.getWatermarkStats(1785176300000 + 31000);
    expect(stats.last_tick_age_ms).to.equal(31000);
    expect(stats.healthy).to.be.false;
    b.stop();
  });
  it('stops ticking after stop()', function () {
    feature7broadcastWatermarkCadenceInstrumentationClock = sinon.useFakeTimers({
      now: 1785176300000,
      toFake: ['Date', 'setInterval', 'clearInterval']
    });
    let b = new HubDbBroadcaster({
      WS_WATERMARK_INTERVAL_MS: '10000'
    });
    feature7broadcastWatermarkCadenceInstrumentationClock.tick(10000);
    expect(b.getWatermarkStats().ticks).to.equal(1);
    b.stop();
    feature7broadcastWatermarkCadenceInstrumentationClock.tick(60000);
    expect(b.getWatermarkStats().ticks).to.equal(1);
  });
}
function registerFeature7broadcastWatermarkCadenceInstrumentation() {
  describe('broadcastWatermark() cadence instrumentation', function () {
    afterEach(function () {
      if (feature7broadcastWatermarkCadenceInstrumentationClock) {
        feature7broadcastWatermarkCadenceInstrumentationClock.restore();
        feature7broadcastWatermarkCadenceInstrumentationClock = null;
      }
    });
    registerFeature7broadcastWatermarkCadenceInstrumentationPart1();
    registerFeature7broadcastWatermarkCadenceInstrumentationPart2();
    registerFeature7broadcastWatermarkCadenceInstrumentationPart3();
    registerFeature7broadcastWatermarkCadenceInstrumentationPart4();
  });
}
function registerFeature8getSubscriberCountPart1() {
  it('tracks multiple subscribers accurately', async function () {
    let b = new HubDbBroadcaster({});
    let ws1 = makeMockWs();
    let ws2 = makeMockWs();
    let ws3 = makeMockWs();
    await b.addSubscriber(ws1);
    await b.addSubscriber(ws2);
    await b.addSubscriber(ws3);
    expect(b.getSubscriberCount()).to.equal(3);
    b.removeSubscriber(ws2);
    expect(b.getSubscriberCount()).to.equal(2);
  });
}
function registerFeature8getSubscriberCount() {
  describe('getSubscriberCount()', function () {
    registerFeature8getSubscriberCountPart1();
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
  registerFeature7broadcastWatermarkCadenceInstrumentation();
  registerFeature8getSubscriberCount();
});
