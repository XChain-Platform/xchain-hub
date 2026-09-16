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

function registerFeature5broadcastRowPart1() {
  it('sends row:inserted event to all subscribers', async function () {
    let b = new HubDbBroadcaster({});
    let ws1 = makeMockWs();
    let ws2 = makeMockWs();
    await b.addSubscriber(ws1);
    await b.addSubscriber(ws2);
    b.broadcastRow({
      table: 'price_snapshots',
      row: {
        id: 1,
        price: 100
      }
    });
    // Each ws has 2 sends (ready + broadcast)
    expect(ws1.send.callCount).to.equal(2);
    expect(ws2.send.callCount).to.equal(2);
    let msg = JSON.parse(ws1.send.lastCall.args[0]);
    expect(msg.type).to.equal('row:inserted');
    expect(msg.table).to.equal('price_snapshots');
  });
  it('does nothing when there are no subscribers', function () {
    let b = new HubDbBroadcaster({});
    // Should not throw
    b.broadcastRow({
      table: 'price_snapshots',
      row: {
        id: 1
      }
    });
  });
  it('serializes BigInt values as strings', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    // Use a safe integer to avoid float-truncation in test; BigInt serializer is exercised
    b.broadcastRow({
      table: 'oracle_prices',
      row: {
        id: BigInt(42)
      }
    });
    let msg = JSON.parse(ws.send.lastCall.args[0]);
    expect(msg.row.id).to.equal('42');
  });
}
function registerFeature5broadcastRowPart2() {
  it('removes the subscriber when send() throws', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    // Override send to throw on the second call (first was ready)
    ws.send.onCall(1).throws(new Error('socket broken'));
    b.broadcastRow({
      table: 'price_snapshots',
      row: {
        id: 1
      }
    });
    expect(b.getSubscriberCount()).to.equal(0);
  });
  it('skips subscribers whose readyState is not OPEN', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs({
      readyState: 3 /* CLOSED */
    });
    // Bypass the ready-message send check
    b.subscribers.add(ws);
    ws._hubBuffered = 0;
    b.broadcastRow({
      table: 'price_snapshots',
      row: {
        id: 1
      }
    });
    expect(ws.send.called).to.be.false;
  });
  it('closes subscriber on backpressure overflow', async function () {
    let b = new HubDbBroadcaster({
      WS_BACKPRESSURE_LIMIT: '2'
    });
    let ws = makeMockWs({
      bufferedAmount: 1000
    });
    await b.addSubscriber(ws);
    // Saturate the backpressure counter
    ws._hubBuffered = 3;
    b.broadcastRow({
      table: 'price_snapshots',
      row: {
        id: 1
      }
    });
    expect(ws.close.called).to.be.true;
    expect(b.getSubscriberCount()).to.equal(0);
  });
}
function registerFeature5broadcastRow() {
  describe('broadcastRow()', function () {
    registerFeature5broadcastRowPart1();
    registerFeature5broadcastRowPart2();
  });
}
function registerFeature6broadcastDeletionPart1() {
  it('sends row:deleted event to all subscribers', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    b.broadcastDeletion({
      table: 'cross_chain_matches',
      source_chain: 'BTC',
      from_action_index: 100
    });
    let msg = JSON.parse(ws.send.lastCall.args[0]);
    expect(msg.type).to.equal('row:deleted');
    expect(msg.table).to.equal('cross_chain_matches');
    expect(msg.source_chain).to.equal('BTC');
    expect(msg.from_action_index).to.equal(100);
  });
  it('does nothing when there are no subscribers', function () {
    let b = new HubDbBroadcaster({});
    b.broadcastDeletion({
      table: 'cross_chain_matches',
      source_chain: 'BTC',
      from_action_index: 100
    });
  });
  it('includes to_action_index for a closed-range (deferred) retraction (item 5296)', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    b.broadcastDeletion({
      table: 'oracle_prices',
      source_chain: 'BTC',
      from_action_index: 50,
      to_action_index: 75
    });
    let msg = JSON.parse(ws.send.lastCall.args[0]);
    expect(msg.from_action_index).to.equal(50);
    expect(msg.to_action_index).to.equal(75);
  });
  it('omits to_action_index for an open-ended (live) retraction', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    b.broadcastDeletion({
      table: 'oracle_prices',
      source_chain: 'BTC',
      from_action_index: 50
    });
    let msg = JSON.parse(ws.send.lastCall.args[0]);
    expect(msg).to.not.have.property('to_action_index');
  });
}
function registerFeature6broadcastDeletionPart2() {
  it('includes retraction_generation when present so replicas fence identically (item 5308)', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    b.broadcastDeletion({
      table: 'oracle_prices',
      source_chain: 'BTC',
      from_action_index: 50,
      to_action_index: 75,
      retraction_generation: 5
    });
    let msg = JSON.parse(ws.send.lastCall.args[0]);
    expect(msg.retraction_generation).to.equal(5);
  });
  it('omits retraction_generation when absent (older indexer / no fence)', async function () {
    let b = new HubDbBroadcaster({});
    let ws = makeMockWs();
    await b.addSubscriber(ws);
    b.broadcastDeletion({
      table: 'oracle_prices',
      source_chain: 'BTC',
      from_action_index: 50
    });
    let msg = JSON.parse(ws.send.lastCall.args[0]);
    expect(msg).to.not.have.property('retraction_generation');
  });
}
function registerFeature6broadcastDeletion() {
  describe('broadcastDeletion()', function () {
    registerFeature6broadcastDeletionPart1();
    registerFeature6broadcastDeletionPart2();
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
  registerFeature5broadcastRow();
  registerFeature6broadcastDeletion();
});
