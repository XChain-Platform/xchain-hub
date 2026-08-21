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

        // A NaN cap makes every `size >= cap` comparison false, so an unparseable
        // knob would unarm the caps entirely rather than degrade to the default.
        it('falls back to the defaults on unparseable knobs', function () {
            sinon.stub(console, 'warn');
            let b = new HubDbBroadcaster({
                WS_MAX_PER_IP:            'many',
                WS_MAX_SUBSCRIBERS:       'lots',
                WS_BACKPRESSURE_LIMIT:    'some',
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
                WS_MAX_PER_IP:            '-1',
                WS_MAX_SUBSCRIBERS:       '-100',
                WS_BACKPRESSURE_LIMIT:    '0',
                WS_WATERMARK_INTERVAL_MS: '-5000'
            });
            expect(b.maxPerIp).to.equal(100);
            expect(b.maxSubscribers).to.equal(1000);
            expect(b.maxBufferedMessages).to.equal(50);
            expect(b.watermarkIntervalMs).to.equal(10000);
            b.stop();
        });

        it('still honours well-formed positive knobs', function () {
            let b = new HubDbBroadcaster({
                WS_MAX_PER_IP:            '7',
                WS_MAX_SUBSCRIBERS:       '9',
                WS_BACKPRESSURE_LIMIT:    '11',
                WS_WATERMARK_INTERVAL_MS: '2500'
            });
            expect(b.maxPerIp).to.equal(7);
            expect(b.maxSubscribers).to.equal(9);
            expect(b.maxBufferedMessages).to.equal(11);
            expect(b.watermarkIntervalMs).to.equal(2500);
            b.stop();
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
                doQuery: sinon.stub().callsFake(async (sql) => {
                    asked.push(String(sql));
                    return [{ max_id: 7 }];
                })
            });
            let b  = new HubDbBroadcaster({}, db);
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            let msg = JSON.parse(ws.send.firstCall.args[0]);
            for (const table of ['state_checkpoints', 'anchor_reward_attestations']) {
                expect(msg.max_ids, 'ready frame omits ' + table + ', so the consumer never runs its gap catch-up for it')
                    .to.have.property(table, 7);
                expect(asked.some(sql => sql.includes('FROM ' + table)),
                    'no MAX(id) query was issued for ' + table).to.equal(true);
            }
            // Append-only table: an unfiltered ceiling is what the snapshot feed serves,
            // so a status filter here would strand the consumer's catch-up.
            expect(asked.some(sql => sql.includes('FROM anchor_reward_attestations') && sql.includes('status')))
                .to.equal(false);
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

    // ── dropAllForResync (item 4459) ─────────────────────────────────────────

    describe('dropAllForResync()', function () {
        it('closes every subscriber with a retryable code and deregisters it', async function () {
            let b   = new HubDbBroadcaster({});
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
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws, { socket: { remoteAddress: '10.0.0.9' } });
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

    // ── broadcastWatermark / heartbeat cadence ───────────────────────

    describe('broadcastWatermark() cadence instrumentation', function () {

        let clock = null;

        afterEach(function () {
            if (clock) { clock.restore(); clock = null; }
        });

        it('sends a watermark stamped with the current wall clock', async function () {
            clock = sinon.useFakeTimers({ now: 1785176300000, toFake: ['Date', 'setInterval', 'clearInterval'] });
            let b  = new HubDbBroadcaster({});
            let ws = makeMockWs();
            await b.addSubscriber(ws);
            b.broadcastWatermark();
            let msg = JSON.parse(ws.send.lastCall.args[0]);
            expect(msg.type).to.equal('watermark');
            expect(msg.ts).to.equal(1785176300);
        });

        it('fires on the configured interval and records that cadence', function () {
            clock = sinon.useFakeTimers({ now: 1785176300000, toFake: ['Date', 'setInterval', 'clearInterval'] });
            let b = new HubDbBroadcaster({ WS_WATERMARK_INTERVAL_MS: '10000' });
            clock.tick(30000);
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
            clock = sinon.useFakeTimers({ now: 1785176300000, toFake: ['Date', 'setInterval', 'clearInterval'] });
            let b = new HubDbBroadcaster({});
            clock.tick(20000);
            let stats = b.getWatermarkStats();
            expect(stats.ticks).to.equal(2);
            expect(stats.sent).to.equal(0);
            expect(stats.subscribers).to.equal(0);
            expect(stats.last_delivered).to.equal(0);
            expect(stats.last_watermark_ts).to.equal(null);
            b.stop();
        });

        it('reports how many open sockets the heartbeat actually reached', async function () {
            clock = sinon.useFakeTimers({ now: 1785176300000, toFake: ['Date', 'setInterval', 'clearInterval'] });
            let b     = new HubDbBroadcaster({});
            let open  = makeMockWs();
            let shut  = makeMockWs({ readyState: 3 /* CLOSED */ });
            await b.addSubscriber(open);
            b.subscribers.add(shut);        // bypass the ready-message send
            b.broadcastWatermark();
            let stats = b.getWatermarkStats();
            expect(stats.subscribers).to.equal(2);
            expect(stats.last_delivered).to.equal(1);
            expect(stats.sent).to.equal(1);
        });

        it('counts and logs a tick that lands past the late threshold', function () {
            clock = sinon.useFakeTimers({ now: 1785176300000, toFake: ['Date'] });
            let warn = sinon.stub(console, 'warn');
            let b = new HubDbBroadcaster({ WS_WATERMARK_INTERVAL_MS: '10000' });
            b.broadcastWatermark();          // first tick: no gap to measure yet
            clock.tick(45000);               // event loop stalled well past 2x interval
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
            clock = sinon.useFakeTimers({ now: 1785176300000, toFake: ['Date'] });
            let b = new HubDbBroadcaster({ WS_WATERMARK_INTERVAL_MS: '10000' });
            b.broadcastWatermark();
            clock.tick(19000);               // late, but inside the 2x tolerance
            b.broadcastWatermark();
            let stats = b.getWatermarkStats();
            expect(stats.late_ticks).to.equal(0);
            expect(stats.last_gap_ms).to.equal(19000);
            b.stop();
        });

        it('derives the late threshold from the configured interval', function () {
            let b = new HubDbBroadcaster({ WS_WATERMARK_INTERVAL_MS: '2000' });
            expect(b.getWatermarkStats().late_threshold_ms).to.equal(4000);
            b.stop();
        });

        it('honours WS_WATERMARK_LATE_FACTOR from config', function () {
            let b = new HubDbBroadcaster({ WS_WATERMARK_INTERVAL_MS: '10000', WS_WATERMARK_LATE_FACTOR: '3' });
            expect(b.watermarkLateFactor).to.equal(3);
            expect(b.getWatermarkStats().late_threshold_ms).to.equal(30000);
            b.stop();
        });

        it('falls back to the default factor when the knob is below 1 or unparseable', function () {
            let low = new HubDbBroadcaster({ WS_WATERMARK_INTERVAL_MS: '10000', WS_WATERMARK_LATE_FACTOR: '0.5' });
            expect(low.watermarkLateFactor).to.equal(2);
            low.stop();
            let junk = new HubDbBroadcaster({ WS_WATERMARK_INTERVAL_MS: '10000', WS_WATERMARK_LATE_FACTOR: 'soon' });
            expect(junk.watermarkLateFactor).to.equal(2);
            junk.stop();
        });

        it('reports unhealthy once the last tick is older than the threshold', function () {
            clock = sinon.useFakeTimers({ now: 1785176300000, toFake: ['Date'] });
            let b = new HubDbBroadcaster({ WS_WATERMARK_INTERVAL_MS: '10000' });
            b.broadcastWatermark();
            expect(b.getWatermarkStats().healthy).to.be.true;
            clock.tick(15000);
            expect(b.getWatermarkStats().healthy).to.be.true;   // still inside 2x
            clock.tick(10000);                                  // 25s since last tick
            let stats = b.getWatermarkStats();
            expect(stats.healthy).to.be.false;
            expect(stats.last_tick_age_ms).to.equal(25000);
            b.stop();
        });

        it('ages from construction when the timer has never fired, so a dead heartbeat is not read as fine', function () {
            clock = sinon.useFakeTimers({ now: 1785176300000, toFake: ['Date'] });
            let b = new HubDbBroadcaster({ WS_WATERMARK_INTERVAL_MS: '10000' });
            expect(b.getWatermarkStats().healthy).to.be.true;
            clock.tick(60000);
            let stats = b.getWatermarkStats();
            expect(stats.ticks).to.equal(0);
            expect(stats.last_tick_age_ms).to.equal(60000);
            expect(stats.healthy).to.be.false;
            b.stop();
        });

        it('evaluates age against an injected instant', function () {
            clock = sinon.useFakeTimers({ now: 1785176300000, toFake: ['Date'] });
            let b = new HubDbBroadcaster({ WS_WATERMARK_INTERVAL_MS: '10000' });
            b.broadcastWatermark();
            let stats = b.getWatermarkStats(1785176300000 + 31000);
            expect(stats.last_tick_age_ms).to.equal(31000);
            expect(stats.healthy).to.be.false;
            b.stop();
        });

        it('stops ticking after stop()', function () {
            clock = sinon.useFakeTimers({ now: 1785176300000, toFake: ['Date', 'setInterval', 'clearInterval'] });
            let b = new HubDbBroadcaster({ WS_WATERMARK_INTERVAL_MS: '10000' });
            clock.tick(10000);
            expect(b.getWatermarkStats().ticks).to.equal(1);
            b.stop();
            clock.tick(60000);
            expect(b.getWatermarkStats().ticks).to.equal(1);
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
