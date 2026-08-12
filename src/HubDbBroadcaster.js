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
const { HUB_SCHEMA_VERSION } = require('./hub-schema-version');

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
        // Resolution order env -> config -> default, matching the rest of the hub
        // (e.g. api.js P2P_WS_PING_INTERVAL). p2pConfig carries no WS_* key and a
        // standalone hub receives {}, so without the process.env arm these caps were
        // permanently pinned to their defaults and the CHANGELOG's WS_BACKPRESSURE_LIMIT
        // operator knob could never take effect.
        this.maxPerIp = parseInt(process.env.WS_MAX_PER_IP || this.config.WS_MAX_PER_IP || 100);
        this.maxSubscribers = parseInt(process.env.WS_MAX_SUBSCRIBERS || this.config.WS_MAX_SUBSCRIBERS || 1000);
        this.maxBufferedMessages = parseInt(process.env.WS_BACKPRESSURE_LIMIT || this.config.WS_BACKPRESSURE_LIMIT || 50);

        // Stream-position watermark heartbeat. Every interval, tell subscribers
        // "you have received every row event produced up to ts". Row events are
        // emitted synchronously at insert time in this same process, so a quiet
        // stream genuinely means no new rows exist, and the indexer's sync
        // barriers can distinguish "mirror is behind" from "the world is quiet"
        // (the row-content watermark deadlock: review items #1984/#1986).
        this.watermarkIntervalMs = parseInt(process.env.WS_WATERMARK_INTERVAL_MS || this.config.WS_WATERMARK_INTERVAL_MS || 10000);

        // Heartbeat-cadence instrumentation . Whether a consumer's price
        // stream watermark sits within one heartbeat of wall clock used to be
        // observable only from the indexer's barrier-timeout log line, which was
        // the sole place the stream watermark was ever printed. The action-scoped
        // barrier stopped that line from being emitted, so fixing the defect also
        // removed its only instrument. Measure the cadence HERE, at the producer
        // that owns it: the payload ts is stamped at send time, so a consumer can
        // never be further behind wall clock than the gap between two ticks plus
        // flight time. A gap past watermarkLateThresholdMs is counted and logged,
        // and getWatermarkStats() exposes the whole picture for /health.
        let lateFactor = parseFloat(process.env.WS_WATERMARK_LATE_FACTOR || this.config.WS_WATERMARK_LATE_FACTOR || 2);
        // A factor below 1 would mark an exactly-on-time tick late, so a bad knob
        // degrades to the default instead of producing permanent false alarms.
        if (!isFinite(lateFactor) || lateFactor < 1) lateFactor = 2;
        this.watermarkLateFactor      = lateFactor;
        this.watermarkLateThresholdMs = Math.round(this.watermarkIntervalMs * lateFactor);
        this._watermarkStats = {
            ticks:           0,     // timer firings, counted even with no subscribers
            sent:            0,     // firings that actually broadcast to someone
            lateTicks:       0,
            lastTickAtMs:    null,
            lastGapMs:       null,
            maxGapMs:        null,
            lastWatermarkTs: null,
            lastDelivered:   0,
            startedAtMs:     Date.now()
        };

        this._watermarkTimer = setInterval(() => this.broadcastWatermark(), this.watermarkIntervalMs);
        if (this._watermarkTimer.unref) this._watermarkTimer.unref();
    }

    broadcastWatermark() {
        let nowMs = Date.now();
        let stats = this._watermarkStats;
        // Tick-to-tick gap, recorded before the no-subscriber early return: a
        // stalled event loop delays the heartbeat whether or not anyone is
        // listening, and that is exactly what this instrument is for.
        let gapMs = (stats.lastTickAtMs === null) ? null : nowMs - stats.lastTickAtMs;
        stats.ticks++;
        stats.lastTickAtMs = nowMs;
        stats.lastGapMs    = gapMs;
        if (gapMs !== null) {
            if (stats.maxGapMs === null || gapMs > stats.maxGapMs) stats.maxGapMs = gapMs;
            if (gapMs > this.watermarkLateThresholdMs) {
                stats.lateTicks++;
                console.warn('HubDbBroadcaster: watermark heartbeat late (' + gapMs + 'ms since previous, interval '
                    + this.watermarkIntervalMs + 'ms, late ticks ' + stats.lateTicks + ')');
            }
        }

        if (this.subscribers.size === 0) {
            stats.lastDelivered = 0;
            return;
        }
        let ts = Math.floor(nowMs / 1000);
        let message = JSON.stringify({ type: 'watermark', ts: ts });
        let delivered = 0;
        for (let ws of this.subscribers) {
            if (this._send(ws, message)) delivered++;
        }
        stats.sent++;
        stats.lastWatermarkTs = ts;
        // Sockets the heartbeat actually reached. A live subscriber count with a
        // zero delivered count means every socket is closed or dropped by
        // backpressure, which reads to a consumer exactly like a stalled hub.
        stats.lastDelivered = delivered;
    }

    // Producer-side view of the heartbeat: cadence actually achieved, not the
    // cadence configured. `healthy` is the testable form of "the consumer's
    // watermark sits within one heartbeat of wall clock", asserted where the
    // heartbeat is produced. nowMs is injectable so callers (and tests) can
    // evaluate the age against a fixed instant.
    getWatermarkStats(nowMs) {
        let now   = (typeof nowMs === 'number') ? nowMs : Date.now();
        let stats = this._watermarkStats;
        // Before the first tick, age runs from construction, so a broadcaster
        // whose timer never fired at all still shows up as stale rather than
        // reporting a null age that a probe would read as fine.
        let ageMs = (stats.lastTickAtMs === null) ? now - stats.startedAtMs : now - stats.lastTickAtMs;
        return {
            interval_ms:       this.watermarkIntervalMs,
            late_threshold_ms: this.watermarkLateThresholdMs,
            ticks:             stats.ticks,
            sent:              stats.sent,
            late_ticks:        stats.lateTicks,
            last_gap_ms:       stats.lastGapMs,
            max_gap_ms:        stats.maxGapMs,
            last_watermark_ts: stats.lastWatermarkTs,
            last_tick_age_ms:  ageMs,
            subscribers:       this.subscribers.size,
            last_delivered:    stats.lastDelivered,
            healthy:           ageMs <= this.watermarkLateThresholdMs
        };
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
            // watermark_interval_ms lets the consumer size its heartbeat watchdog from
            // the hub's ACTUAL cadence instead of a locally-guessed env default, so an
            // operator raising WS_WATERMARK_INTERVAL_MS on the hub can never make a
            // consumer terminate a healthy socket (the two knobs used to be linked only
            // by a prose comment). Additive: older consumers ignore the field.
            ws.send(JSON.stringify({ type: 'ready', max_ids: maxIds, watermark: Math.floor(Date.now() / 1000), watermark_interval_ms: this.watermarkIntervalMs }));
        } catch (e) { /* ignore */ }
    }

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

    // Force every subscriber to reconnect after a row event this producer could NOT
    // deliver. The watermark heartbeat certifies "you have every row produced through
    // ts" on a wall clock that never learns a broadcast was dropped, and a consumer's
    // only gap repair (the max_ids catch-up in its bootstrap) runs at connect time, so
    // a silently-dropped row leaves the consumer certifying completeness past a
    // committed row forever (item 4459). Closing the socket is the sanctioned repair:
    // the consumer resets its drain gate on close, reconnects, and re-drains from the
    // max_ids in the next 'ready' frame. 1012 (Service Restart) is a retryable close
    // code. Returns how many sockets were dropped, so the caller can log the repair.
    dropAllForResync(reason) {
        let why = reason || 'resync';
        let dropped = 0;
        for (let ws of Array.from(this.subscribers)) {
            try { ws.close(1012, why); } catch (e) { /* ignore */ }
            this.removeSubscriber(ws);
            dropped++;
        }
        if (dropped > 0)
            console.warn('HubDbBroadcaster: dropped ' + dropped + ' subscriber(s) for resync (' + why + ')');
        return dropped;
    }

    // event: { table, row }
    broadcastRow(event) {
        if (this.subscribers.size === 0) return;
        let message;
        try {
            // schema_version lets the indexer reject a row whose mirrored table has a
            // DDL change it has not migrated yet, rather than silently dropping columns.
            message = JSON.stringify({ type: 'row:inserted', table: event.table, row: event.row, schema_version: HUB_SCHEMA_VERSION }, bigIntReplacer);
        } catch (e) {
            console.error('HubDbBroadcaster: serialization error:', e);
            return;
        }
        for (let ws of this.subscribers) {
            this._send(ws, message);
        }
    }

    // Broadcast a reorg retraction to all subscribers so they prune their local
    // price-table copies. event: { table, source_chain, from_action_index, to_action_index?, retraction_generation? }
    // to_action_index is included only for a CLOSED-range (deferred) retraction so subscribers
    // bound their mirrored delete identically to the hub (item 5296); absent => open-ended.
    // retraction_generation (item 5308) is the source chain's rollback generation; subscribers
    // fence their mirrored delete to rows with push_generation <= it, so a re-published row at a
    // recycled action_index survives. Absent => no fence (older hub/indexer == prior behavior).
    broadcastDeletion(event) {
        if (this.subscribers.size === 0) return;
        let message;
        try {
            let payload = {
                type:              'row:deleted',
                table:             event.table,
                source_chain:      event.source_chain,
                from_action_index: event.from_action_index,
                schema_version:    HUB_SCHEMA_VERSION
            };
            if (event.to_action_index !== undefined && event.to_action_index !== null)
                payload.to_action_index = event.to_action_index;
            if (event.retraction_generation !== undefined && event.retraction_generation !== null)
                payload.retraction_generation = event.retraction_generation;
            //  signed retraction: the RetractionConsensus round stamps the
            // BTC-anchored snapshot_block that selects the validator set plus the
            // 2f+1 cross_chain co-signature set over the XRETRACTV1 canonical.
            // Mirrors past the RETRACTION_SIGNING flag-day refuse quorum-class
            // deletions without them. Absent (legacy / sub-gate) => prior wire shape.
            if (event.snapshot_block !== undefined && event.snapshot_block !== null)
                payload.snapshot_block = event.snapshot_block;
            if (Array.isArray(event.retraction_signatures) && event.retraction_signatures.length > 0)
                payload.retraction_signatures = event.retraction_signatures;
            message = JSON.stringify(payload, bigIntReplacer);
        } catch (e) {
            console.error('HubDbBroadcaster: serialization error:', e);
            return;
        }
        for (let ws of this.subscribers) {
            this._send(ws, message);
        }
    }

    // Returns true only when the message was handed to an open socket, so the
    // watermark heartbeat can report how many subscribers it actually reached
    // rather than how many are merely registered.
    _send(ws, message) {
        if (ws.readyState !== WebSocket.OPEN) return false;
        if (ws.bufferedAmount > 0) {
            ws._hubBuffered = (ws._hubBuffered || 0) + 1;
        } else {
            ws._hubBuffered = 0;
        }
        if (ws._hubBuffered > this.maxBufferedMessages) {
            console.log('HubDbBroadcaster: subscriber backpressure exceeded, closing');
            try { ws.close(1008, 'Backpressure'); } catch (e) { /* ignore */ }
            this.removeSubscriber(ws);
            return false;
        }
        try {
            ws.send(message);
        } catch (e) {
            console.warn('HubDbBroadcaster: send error:', e);
            this.removeSubscriber(ws);
            return false;
        }
        return true;
    }

    getSubscriberCount() {
        return this.subscribers.size;
    }
}

module.exports = HubDbBroadcaster;
