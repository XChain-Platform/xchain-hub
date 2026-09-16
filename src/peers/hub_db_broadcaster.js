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
const { HUB_SCHEMA_VERSION } = require('../hub_schema_version');
const { positiveIntConfig } = require('../lib/config_int.js');

// JSON replacer that converts BigInt to string (mariadb returns BigInt for BIGINT columns)
const { bigIntReplacer } = require('../lib/bigint_replacer.js');
const hubConfig = require('../config');
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();
const { AdmissionHeightWatermark, ADMISSION_WATERMARK_TABLES } = require('./hub_db/admission_height_watermark.js');
const HubDbAdmissionSampling = require('./hub_db/admission_sampling.js');
const HubDbSubscribers = require('./hub_db/subscribers.js');

// The cadence half of the constructor: how late a watermark tick may be, and
// the counters that record how late they have actually been.
function initWatermarkCadence(broadcaster) {
    // Heartbeat-cadence instrumentation. No log line on the consumer side
    // prints the price stream watermark, so whether it sits within one
    // heartbeat of wall clock is measured HERE, at the producer that owns the
    // cadence: the payload ts is stamped at send time, so a consumer can
    // never be further behind wall clock than the gap between two ticks plus
    // flight time. A gap past watermarkLateThresholdMs is counted and logged,
    // and getWatermarkStats() exposes the whole picture for /health.
    let lateFactor = parseFloat(hubConfig.WS_WATERMARK_LATE_FACTOR || broadcaster.config.WS_WATERMARK_LATE_FACTOR || 2);
    // A factor below 1 would mark an exactly-on-time tick late, so a bad knob
    // degrades to the default instead of producing permanent false alarms.
    if (!isFinite(lateFactor) || lateFactor < 1) lateFactor = 2;
    broadcaster.watermarkLateFactor      = lateFactor;
    broadcaster.watermarkLateThresholdMs = Math.round(broadcaster.watermarkIntervalMs * lateFactor);
    broadcaster._watermarkStats = {
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

    broadcaster._watermarkTimer = setInterval(() => broadcaster.broadcastWatermark(), broadcaster.watermarkIntervalMs);
    if (broadcaster._watermarkTimer.unref) broadcaster._watermarkTimer.unref();
}

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
        // Resolve through positiveIntConfig so a malformed or non-positive knob falls
        // back to the default instead of becoming NaN: `size >= NaN` is always false,
        // which would silently unarm the very caps this block exists to enforce.
        // Zero carries no "disabled" meaning at any of these three sites (it would
        // reject every connection, or close on the first buffered message).
        this.maxPerIp = positiveIntConfig(
            hubConfig.WS_MAX_PER_IP || this.config.WS_MAX_PER_IP, 100, 'WS_MAX_PER_IP');
        this.maxSubscribers = positiveIntConfig(
            hubConfig.WS_MAX_SUBSCRIBERS || this.config.WS_MAX_SUBSCRIBERS, 1000, 'WS_MAX_SUBSCRIBERS');
        this.maxBufferedMessages = positiveIntConfig(
            hubConfig.WS_BACKPRESSURE_LIMIT || this.config.WS_BACKPRESSURE_LIMIT, 50, 'WS_BACKPRESSURE_LIMIT');

        // Stream-position watermark heartbeat. Every interval, tell subscribers
        // "you have received every row event produced up to ts". Row events are
        // emitted synchronously at insert time in this same process, so a quiet
        // stream genuinely means no new rows exist, and the indexer's sync
        // barriers can distinguish "mirror is behind" from "the world is quiet"
        // (the row-content watermark deadlock).
        // Guarded like the caps above: a NaN interval makes setInterval clamp to ~1ms,
        // storming every subscriber, and serializes as null in the 'ready' frame so
        // consumers cannot size their watchdog from it.
        this.watermarkIntervalMs = positiveIntConfig(
            hubConfig.WS_WATERMARK_INTERVAL_MS || this.config.WS_WATERMARK_INTERVAL_MS, 10000, 'WS_WATERMARK_INTERVAL_MS');

        initWatermarkCadence(this);

        // The height watermark rides the frames this class already sends. Constructed
        // here and sampled only once a source is attached, so a broadcaster built with no
        // hub (every existing caller, and every existing test) publishes an empty heights
        // object and starts no timer: additive on the wire, inert in behaviour.
        this.admissionWatermark = new AdmissionHeightWatermark(this.config);
        this.admissionSampleMs  = positiveIntConfig(
            hubConfig.ADMISSION_WATERMARK_SAMPLE_MS || this.config.ADMISSION_WATERMARK_SAMPLE_MS,
            30000, 'ADMISSION_WATERMARK_SAMPLE_MS');
        this._admissionHub   = null;
        this._admissionTimer = null;
        this._admissionFloorLoaded = false;
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
                logger.warn('HubDbBroadcaster: watermark heartbeat late (' + gapMs + 'ms since previous, interval '
                    + this.watermarkIntervalMs + 'ms, late ticks ' + stats.lateTicks + ')');
            }
        }

        if (this.subscribers.size === 0) {
            stats.lastDelivered = 0;
            return;
        }
        let ts = Math.floor(nowMs / 1000);
        // `ts` is the stream watermark, a wall clock; `heights` is the height watermark, a
        // block height per chain per table. Separate fields on one carrier, because the
        // stream-stall detector and the liveness stamp both read `ts` and neither changes.
        let message = JSON.stringify({ type: 'watermark', ts: ts, heights: this.admissionHeights(nowMs) });
        let delivered = 0;
        for (let ws of this.subscribers) {
            if (this.send(ws, message)) delivered++;
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
        if (this._admissionTimer) clearInterval(this._admissionTimer);
        this._admissionTimer = null;
    }

    // event: { table, row }
    broadcastRow(event) {
        if (this.subscribers.size === 0) return;
        // The round-abandon timeout's other half: a late finalization of a round this hub's
        // height watermark already abandoned is REFUSED rather than broadcast. The watermark
        // has already certified completeness through that height, so handing the mirror a
        // row that binds at or below it is a fork, not a late delivery. A legacy row carries
        // no admission height and is never refused, so a hub below the activation is
        // byte-identical to today.
        if (this.admissionWatermark && event) {
            let late = this.admissionWatermark.isLateFinalization(event.table, event.row);
            if (late) {
                logger.error('HubDbBroadcaster: REFUSING to broadcast a ' + event.table + ' row admissible at '
                    + late.admitBlock + ' on ' + late.chain + '; the height watermark already claims '
                    + late.watermark + ' there (' + late.reason + '), so the mirror has been told that round '
                    + 'terminated. Broadcasting it would bind a row below a certified height.');
                return;
            }
        }
        let message;
        try {
            // schema_version lets the indexer reject a row whose mirrored table has a
            // DDL change it has not migrated yet, rather than silently dropping columns.
            message = JSON.stringify({ type: 'row:inserted', table: event.table, row: event.row, schema_version: HUB_SCHEMA_VERSION }, bigIntReplacer);
        } catch (e) {
            logger.error(nodeUtil.format('HubDbBroadcaster: serialization error:', e));
            return;
        }
        for (let ws of this.subscribers) {
            this.send(ws, message);
        }
    }

    // Broadcast a reorg retraction to all subscribers so they prune their local
    // price-table copies. event: { table, source_chain, from_action_index, to_action_index?, retraction_generation? }
    // to_action_index is included only for a CLOSED-range (deferred) retraction so subscribers
    // bound their mirrored delete identically to the hub; absent => open-ended.
    // retraction_generation is the source chain's rollback generation; subscribers
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
            // Signed retraction: the RetractionConsensus round stamps the
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
            logger.error(nodeUtil.format('HubDbBroadcaster: serialization error:', e));
            return;
        }
        for (let ws of this.subscribers) {
            this.send(ws, message);
        }
    }

    // Returns true only when the message was handed to an open socket, so the
    // watermark heartbeat can report how many subscribers it actually reached
    // rather than how many are merely registered.
    send(ws, message) {
        if (ws.readyState !== WebSocket.OPEN) return false;
        if (ws.bufferedAmount > 0) {
            ws._hubBuffered = (ws._hubBuffered || 0) + 1;
        } else {
            ws._hubBuffered = 0;
        }
        if (ws._hubBuffered > this.maxBufferedMessages) {
            logger.info('HubDbBroadcaster: subscriber backpressure exceeded, closing');
            try { ws.close(1008, 'Backpressure'); } catch (e) { /* ignore */ }
            this.removeSubscriber(ws);
            return false;
        }
        try {
            ws.send(message);
        } catch (e) {
            logger.warn(nodeUtil.format('HubDbBroadcaster: send error:', e));
            this.removeSubscriber(ws);
            return false;
        }
        return true;
    }
}

// Installed from the part files rather than written in the class body above:
// each part holds one behaviour of this class, and its members land here with
// the descriptors a class body would give them.
for (const Part of [HubDbAdmissionSampling, HubDbSubscribers]) {
    for (const [from, to] of [[Part.prototype, HubDbBroadcaster.prototype], [Part, HubDbBroadcaster]]) {
        for (const key of Object.getOwnPropertyNames(from)) {
            if (key === 'constructor' || key === 'length' || key === 'name' || key === 'prototype') continue;
            Object.defineProperty(to, key, Object.getOwnPropertyDescriptor(from, key));
        }
    }
}

module.exports = Object.assign(HubDbBroadcaster, {
    // Re-exported for callers that already hold this class; the definition itself lives in
    // lib/bigint_replacer.js, which has no requires and so cannot be half-loaded by a cycle.
    bigIntReplacer,
    // The height watermark's producer and its table map, exported so the advance rule, the
    // round-abandon timeout and the relay republish rule are drivable without a hub.
    AdmissionHeightWatermark,
    ADMISSION_WATERMARK_TABLES
});
