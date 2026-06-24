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

// ────────────────────────────────────────────────────────────────────────────
// Load HubDbBroadcaster with WebSocket stubbed
// ────────────────────────────────────────────────────────────────────────────

let WS_OPEN;
let HubDbBroadcaster;

function loadModule() {
    // WebSocket.OPEN = 1 in the real module
    WS_OPEN = 1;
    const WsMock = { OPEN: WS_OPEN };
    HubDbBroadcaster = proxyquire('../../src/HubDbBroadcaster', { ws: WsMock });
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
        doQuery: sinon.stub().resolves([]),
        ...(overrides || {})
    };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('HubDbBroadcaster', function () {

    beforeEach(function () {
        loadModule();
    });

    afterEach(function () {
        sinon.restore();
    });

    // ── Constructor ─────────────────────────────────────────────────────────

    describe('constructor', function () {
        it('initialises with an empty subscriber set', function () {
            let b = new HubDbBroadcaster({});
            expect(b.getSubscriberCount()).to.equal(0);
        });

        it('reads WS_BACKPRESSURE_LIMIT from config', function () {
            let b = new HubDbBroadcaster({ WS_BACKPRESSURE_LIMIT: '100' });
            expect(b.maxBufferedMessages).to.equal(100);
        });

        it('uses default backpressure limit of 50 when not configured', function () {
            let b = new HubDbBroadcaster({});
            expect(b.maxBufferedMessages).to.equal(50);
        });
    });

    // ── addSubscriber ────────────────────────────────────────────────────────

    describe('addSubscriber()', function () {
        it('adds the subscriber and increments count', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            expect(b.getSubscriberCount()).to.equal(1);
        });

        it('sends a ready message to the new subscriber', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            expect(ws.send.calledOnce).to.be.true;
            let msg = JSON.parse(ws.send.firstCall.args[0]);
            expect(msg.type).to.equal('ready');
        });

        it('includes max_ids when db is provided', async function () {
            let db = makeDb({
                doQuery: sinon.stub()
                    .onFirstCall().resolves([{ max_id: 10 }])
                    .onSecondCall().resolves([{ max_id: 20 }])
                    .onThirdCall().resolves([{ max_id: 30 }])
                    .onCall(3).resolves([{ max_id: 40 }])
            });
            let b  = new HubDbBroadcaster({}, db);
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            let msg = JSON.parse(ws.send.firstCall.args[0]);
            expect(msg.max_ids).to.have.property('price_snapshots', 10);
            expect(msg.max_ids).to.have.property('oracle_prices', 20);
        });

        it('handles DB error in max_id queries gracefully', async function () {
            let db = makeDb({ doQuery: sinon.stub().rejects(new Error('db error')) });
            let b  = new HubDbBroadcaster({}, db);
            let ws = makeMockWs();
            await b.addSubscriber(ws);  // must not throw
            expect(ws.send.calledOnce).to.be.true;
        });

        it('handles ws.send() throwing during ready message gracefully', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs({ send: sinon.stub().throws(new Error('ws broken')) });
            await b.addSubscriber(ws);  // must not throw
        });

        it('registers close and error handlers on the WebSocket', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            expect(ws.on.calledWith('close')).to.be.true;
            expect(ws.on.calledWith('error')).to.be.true;
        });

        it('removes subscriber when close event fires', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            expect(b.getSubscriberCount()).to.equal(1);
            // Trigger the close handler
            ws._handlers['close']();
            expect(b.getSubscriberCount()).to.equal(0);
        });

        it('removes subscriber when error event fires', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            ws._handlers['error']();
            expect(b.getSubscriberCount()).to.equal(0);
        });
    });

    // ── removeSubscriber ─────────────────────────────────────────────────────

    describe('removeSubscriber()', function () {
        it('decrements subscriber count', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            b.removeSubscriber(ws);
            expect(b.getSubscriberCount()).to.equal(0);
        });

        it('is idempotent (removing twice does not throw)', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            b.removeSubscriber(ws);
            b.removeSubscriber(ws);
            expect(b.getSubscriberCount()).to.equal(0);
        });
    });

    // ── broadcastRow ─────────────────────────────────────────────────────────

    describe('broadcastRow()', function () {
        it('sends row:inserted event to all subscribers', async function () {
            let b   = new HubDbBroadcaster({});
            let ws1 = makeMockWs();
            let ws2 = makeMockWs();
            await b.addSubscriber(ws1);
            await b.addSubscriber(ws2);
            b.broadcastRow({ table: 'price_snapshots', row: { id: 1, price: 100 } });
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
            b.broadcastRow({ table: 'price_snapshots', row: { id: 1 } });
        });

        it('serializes BigInt values as strings', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            // Use a safe integer to avoid float-truncation in test; BigInt serializer is exercised
            b.broadcastRow({ table: 'oracle_prices', row: { id: BigInt(42) } });
            let msg = JSON.parse(ws.send.lastCall.args[0]);
            expect(msg.row.id).to.equal('42');
        });

        it('removes the subscriber when send() throws', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            // Override send to throw on the second call (first was ready)
            ws.send.onCall(1).throws(new Error('socket broken'));
            b.broadcastRow({ table: 'price_snapshots', row: { id: 1 } });
            expect(b.getSubscriberCount()).to.equal(0);
        });

        it('skips subscribers whose readyState is not OPEN', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs({ readyState: 3 /* CLOSED */ });
            // Bypass the ready-message send check
            b.subscribers.add(ws);
            ws._hubBuffered = 0;
            b.broadcastRow({ table: 'price_snapshots', row: { id: 1 } });
            expect(ws.send.called).to.be.false;
        });

        it('closes subscriber on backpressure overflow', async function () {
            let b  = new HubDbBroadcaster({ WS_BACKPRESSURE_LIMIT: '2' });
            let ws = makeMockWs({ bufferedAmount: 1000 });
            await b.addSubscriber(ws);
            // Saturate the backpressure counter
            ws._hubBuffered = 3;
            b.broadcastRow({ table: 'price_snapshots', row: { id: 1 } });
            expect(ws.close.called).to.be.true;
            expect(b.getSubscriberCount()).to.equal(0);
        });
    });

    // ── broadcastDeletion ─────────────────────────────────────────────────────

    describe('broadcastDeletion()', function () {
        it('sends row:deleted event to all subscribers', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            b.broadcastDeletion({ table: 'cross_chain_matches', source_chain: 'BTC', from_action_index: 100 });
            let msg = JSON.parse(ws.send.lastCall.args[0]);
            expect(msg.type).to.equal('row:deleted');
            expect(msg.table).to.equal('cross_chain_matches');
            expect(msg.source_chain).to.equal('BTC');
            expect(msg.from_action_index).to.equal(100);
        });

        it('does nothing when there are no subscribers', function () {
            let b = new HubDbBroadcaster({});
            b.broadcastDeletion({ table: 'cross_chain_matches', source_chain: 'BTC', from_action_index: 100 });
        });

        it('includes to_action_index for a closed-range (deferred) retraction (item 5296)', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            b.broadcastDeletion({ table: 'oracle_prices', source_chain: 'BTC', from_action_index: 50, to_action_index: 75 });
            let msg = JSON.parse(ws.send.lastCall.args[0]);
            expect(msg.from_action_index).to.equal(50);
            expect(msg.to_action_index).to.equal(75);
        });

        it('omits to_action_index for an open-ended (live) retraction', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            b.broadcastDeletion({ table: 'oracle_prices', source_chain: 'BTC', from_action_index: 50 });
            let msg = JSON.parse(ws.send.lastCall.args[0]);
            expect(msg).to.not.have.property('to_action_index');
        });

        it('includes retraction_generation when present so replicas fence identically (item 5308)', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            b.broadcastDeletion({ table: 'oracle_prices', source_chain: 'BTC', from_action_index: 50, to_action_index: 75, retraction_generation: 5 });
            let msg = JSON.parse(ws.send.lastCall.args[0]);
            expect(msg.retraction_generation).to.equal(5);
        });

        it('omits retraction_generation when absent (older indexer / no fence)', async function () {
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            b.broadcastDeletion({ table: 'oracle_prices', source_chain: 'BTC', from_action_index: 50 });
            let msg = JSON.parse(ws.send.lastCall.args[0]);
            expect(msg).to.not.have.property('retraction_generation');
        });
    });

    // ── getSubscriberCount ────────────────────────────────────────────────────

    describe('getSubscriberCount()', function () {
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
    });
});
