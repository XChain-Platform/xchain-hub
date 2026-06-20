/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - Hub DB Broadcaster
 *
 * Manages WebSocket subscriptions for hub DB row updates and broadcasts
 * row insertion events from PriceAggregator (and other future row sources)
 * to all connected indexers' local hub DB sync clients.
 *
 * This is the cross-chain infrastructure sync channel, separate from the
 * per-chain indexer DB sync channel in xchain-sync. Indexers
 * subscribe to receive new price_snapshots / oracle_prices rows in real
 * time and apply them to their local hub DB copy.
 *
 ********************************************************************/

const WebSocket = require('ws');

// JSON replacer that converts BigInt to string (mariadb returns BigInt for BIGINT columns)
const bigIntReplacer = (k, v) => typeof v === 'bigint' ? v.toString() : v;

class HubDbBroadcaster {

    constructor(config, db) {
        this.config = config || {};
        this.db     = db || null;      // Optional hub DB (used to stamp max IDs in the ready message)
        this.subscribers = new Set();  // Set<ws>
        this.ipConnections = new Map(); // ip -> Set<ws>, for the per-IP cap
        // Per-IP and total subscriber caps. Legitimate clients are the federation's
        // indexer/sync instances (a bounded handful), so the default is generous but
        // finite: an unauthenticated /hub-db/subscribe (HUB_API_KEY unset) is otherwise
        // an unbounded fan-out where every connect runs several SELECT MAX(id) queries.
        this.maxPerIp = parseInt(this.config.WS_MAX_PER_IP || 100);
        this.maxSubscribers = parseInt(this.config.WS_MAX_SUBSCRIBERS || 1000);
        this.maxBufferedMessages = parseInt(this.config.WS_BACKPRESSURE_LIMIT || 50);

        // Stream-position watermark heartbeat. Every interval, tell subscribers
        // "you have received every row event produced up to ts". Row events are
        // emitted synchronously at insert time in this same process, so a quiet
        // stream genuinely means no new rows exist, and the indexer's sync
        // barriers can distinguish "mirror is behind" from "the world is quiet"
        // (the row-content watermark deadlock: review items #1984/#1986).
        this.watermarkIntervalMs = parseInt(this.config.WS_WATERMARK_INTERVAL_MS || 10000);
        this._watermarkTimer = setInterval(() => this.broadcastWatermark(), this.watermarkIntervalMs);
        if (this._watermarkTimer.unref) this._watermarkTimer.unref();
    }

    // Broadcast the current stream position to all subscribers.
    broadcastWatermark() {
        if (this.subscribers.size === 0) return;
        let message = JSON.stringify({ type: 'watermark', ts: Math.floor(Date.now() / 1000) });
        for (let ws of this.subscribers) {
            this._send(ws, message);
        }
    }

    stop() {
        if (this._watermarkTimer) clearInterval(this._watermarkTimer);
        this._watermarkTimer = null;
    }

    // Add a new subscriber WebSocket. Sends a 'ready' acknowledgement once the
    // subscriber is registered so the client knows its subscription is active.
    // Includes the current per-table max row IDs (when a DB connection is available)
    // so the client can detect and fill any narrow gap between the subscription point
    // and its subsequent REST bootstrap response.
    async addSubscriber(ws, req) {
        // Enforce caps before registering: total fan-out, then per-IP. Without a cap an
        // unauthenticated subscribe is an unbounded connection + query amplifier.
        if (this.subscribers.size >= this.maxSubscribers) {
            try { ws.close(1013, 'Too many subscribers'); } catch (e) { /* ignore */ }
            return;
        }
        let ip = req ? (req.socket && req.socket.remoteAddress) || 'unknown' : 'unknown';
        if (!this.ipConnections.has(ip)) this.ipConnections.set(ip, new Set());
        let ipSet = this.ipConnections.get(ip);
        if (ipSet.size >= this.maxPerIp) {
            try { ws.close(1008, 'Too many connections from this IP'); } catch (e) { /* ignore */ }
            return;
        }

        this.subscribers.add(ws);
        ipSet.add(ws);
        ws._hubIp = ip;
        ws._hubBuffered = 0;

        ws.on('close', () => this.removeSubscriber(ws));
        ws.on('error', () => this.removeSubscriber(ws));

        console.log('HubDbBroadcaster: subscriber added (' + this.subscribers.size + ' total)');

        let maxIds = {};
        if (this.db) {
            try {
                let ps = await this.db.doQuery('SELECT MAX(id) AS max_id FROM price_snapshots');
                maxIds.price_snapshots = (ps.length > 0 && ps[0].max_id != null) ? Number(ps[0].max_id) : 0;
            } catch (e) { /* table may not exist yet */ }
            try {
                let op = await this.db.doQuery('SELECT MAX(id) AS max_id FROM oracle_prices');
                maxIds.oracle_prices = (op.length > 0 && op[0].max_id != null) ? Number(op[0].max_id) : 0;
            } catch (e) { /* table may not exist yet */ }
            try {
                // Exclude retracted rows so the advertised max_id matches what the snapshot feed
                // serves (it filters status<>'retracted'); otherwise a retracted max-id row keeps
                // the consumer's gap-detection catch-up firing forever (localMax never reaches it).
                let cm = await this.db.doQuery("SELECT MAX(id) AS max_id FROM cross_chain_matches WHERE status <> 'retracted'");
                maxIds.cross_chain_matches = (cm.length > 0 && cm[0].max_id != null) ? Number(cm[0].max_id) : 0;
            } catch (e) { /* table may not exist yet */ }
            try {
                let cs = await this.db.doQuery('SELECT MAX(id) AS max_id FROM capability_snapshots');
                maxIds.capability_snapshots = (cs.length > 0 && cs[0].max_id != null) ? Number(cs[0].max_id) : 0;
            } catch (e) { /* table may not exist yet */ }
            try {
                let sc = await this.db.doQuery('SELECT MAX(id) AS max_id FROM state_checkpoints');
                maxIds.state_checkpoints = (sc.length > 0 && sc[0].max_id != null) ? Number(sc[0].max_id) : 0;
            } catch (e) { /* table may not exist yet */ }
            try {
                let cc = await this.db.doQuery("SELECT MAX(id) AS max_id FROM cross_chain_calls WHERE status <> 'retracted'");
                maxIds.cross_chain_calls = (cc.length > 0 && cc[0].max_id != null) ? Number(cc[0].max_id) : 0;
            } catch (e) { /* table may not exist yet */ }
        }

        try {
            ws.send(JSON.stringify({ type: 'ready', max_ids: maxIds, watermark: Math.floor(Date.now() / 1000) }));
        } catch (e) { /* ignore */ }
    }

    // Remove a subscriber
    removeSubscriber(ws) {
        if (this.subscribers.has(ws)) {
            this.subscribers.delete(ws);
            let ip = ws._hubIp;
            if (ip && this.ipConnections.has(ip)) {
                let ipSet = this.ipConnections.get(ip);
                ipSet.delete(ws);
                if (ipSet.size === 0) this.ipConnections.delete(ip);
            }
            console.log('HubDbBroadcaster: subscriber removed (' + this.subscribers.size + ' remaining)');
        }
    }

    // Broadcast a row insertion event to all subscribers
    // event: { table, row }
    broadcastRow(event) {
        if (this.subscribers.size === 0) return;
        let message;
        try {
            message = JSON.stringify({ type: 'row:inserted', table: event.table, row: event.row }, bigIntReplacer);
        } catch (e) {
            console.error('HubDbBroadcaster: serialization error:', e);
            return;
        }
        for (let ws of this.subscribers) {
            this._send(ws, message);
        }
    }

    // Broadcast a reorg retraction to all subscribers so they prune their local
    // price-table copies. event: { table, source_chain, from_action_index }
    broadcastDeletion(event) {
        if (this.subscribers.size === 0) return;
        let message;
        try {
            message = JSON.stringify({
                type:              'row:deleted',
                table:             event.table,
                source_chain:      event.source_chain,
                from_action_index: event.from_action_index
            }, bigIntReplacer);
        } catch (e) {
            console.error('HubDbBroadcaster: serialization error:', e);
            return;
        }
        for (let ws of this.subscribers) {
            this._send(ws, message);
        }
    }

    // Send a message with backpressure handling
    _send(ws, message) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 0) {
            ws._hubBuffered = (ws._hubBuffered || 0) + 1;
        } else {
            ws._hubBuffered = 0;
        }
        if (ws._hubBuffered > this.maxBufferedMessages) {
            console.log('HubDbBroadcaster: subscriber backpressure exceeded, closing');
            try { ws.close(1008, 'Backpressure'); } catch (e) { /* ignore */ }
            this.removeSubscriber(ws);
            return;
        }
        try {
            ws.send(message);
        } catch (e) {
            console.warn('HubDbBroadcaster: send error:', e);
            this.removeSubscriber(ws);
        }
    }

    // Get current subscriber count
    getSubscriberCount() {
        return this.subscribers.size;
    }
}

module.exports = HubDbBroadcaster;
