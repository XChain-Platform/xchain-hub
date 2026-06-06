/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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
 * This is the cross-chain infrastructure sync channel — separate from the
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
        this.db     = db || null;      // Optional hub DB — used to stamp max IDs in the ready message
        this.subscribers = new Set();  // Set<ws>
        this.maxBufferedMessages = parseInt(this.config.WS_BACKPRESSURE_LIMIT || 50);
    }

    // Add a new subscriber WebSocket. Sends a 'ready' acknowledgement once the
    // subscriber is registered so the client knows its subscription is active.
    // Includes the current per-table max row IDs (when a DB connection is available)
    // so the client can detect and fill any narrow gap between the subscription point
    // and its subsequent REST bootstrap response.
    async addSubscriber(ws) {
        this.subscribers.add(ws);
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
        }

        try {
            ws.send(JSON.stringify({ type: 'ready', max_ids: maxIds }));
        } catch (e) { /* ignore */ }
    }

    // Remove a subscriber
    removeSubscriber(ws) {
        if (this.subscribers.has(ws)) {
            this.subscribers.delete(ws);
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
