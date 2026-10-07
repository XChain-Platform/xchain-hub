'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Hub - Landing Watermark
 *
 * `landed[chain] = { block, protocol_time }`: the highest block of a landing
 * chain such that every hub push the chain's indexer enqueued at or below it
 * has been acknowledged by this hub, with that block's protocol time.
 *
 * A reading is published only when this hub's own batch ingest, stamp emit
 * included, was idle for that chain across the whole read, so an entry never
 * claims a push whose stamp is still unemitted. Frames are built at send time,
 * after the rows they cover were written to the same stream. An unknown,
 * malformed or regressing reading publishes nothing, and a published entry
 * never goes backwards.
 *
 ********************************************************************/

const { normalizeChain } = require('../../lib/admission_height.js');
const hubConfig = require('../../config');
const gateRegistry = require('../../consensus/gate_registry.js');

const CLEAR_FRONTIER_KEY = 'peers/hub_db/landing_watermark.LANDING_CLEAR_FRONTIER_ACTIVATION';

function clearFrontierActive(network, chain, block) {
    return gateRegistry.activeAt(CLEAR_FRONTIER_KEY, String(network || ''), chain, block, null);
}

// The reading a chain publishes: the indexer's price_landing_clear when the gate is
// active at its block and it is ahead of hub_push_delivered (or that is unknown),
// otherwise hub_push_delivered unchanged.
function selectReading(chain, delivered, clear, network) {
    const d = readingOf(delivered);
    const c = readingOf(clear);
    if (c === null || !clearFrontierActive(network, chain, c.block)) return d;
    if (d !== null && c.block <= d.block) return d;
    return c;
}

function relayFlag(config) {
    const raw = String(hubConfig.HUB_ADMISSION_RELAY || (config && config.HUB_ADMISSION_RELAY) || '');
    return raw === '1' || raw.toLowerCase() === 'true';
}

function readingOf(value) {
    if (!value || typeof value !== 'object') return null;
    const block = Number(value.block);
    const time = Number(value.protocol_time);
    if (!Number.isSafeInteger(block) || block < 0) return null;
    if (!Number.isSafeInteger(time) || time <= 0) return null;
    return { block, protocol_time: time };
}

class LandingWatermark {

    constructor(config) {
        this.relay = relayFlag(config);
        this._landed = new Map();
        this._upstream = null;
        this._inFlight = new Map();
        this._started = new Map();
        this._tracked = new WeakSet();
    }

    // Wrap the aggregator's batch ingest so a read can tell whether one was running.
    // The ingest returns after its rows and stamps were emitted, so a finished ingest
    // is a covered one.
    trackIngest(aggregator) {
        if (!aggregator || typeof aggregator.receiveValidatedBatch !== 'function') return false;
        if (this._tracked.has(aggregator)) return true;
        this._tracked.add(aggregator);
        const inner = aggregator.receiveValidatedBatch.bind(aggregator);
        aggregator.receiveValidatedBatch = async (sourceChain, batchData) => {
            const c = normalizeChain(sourceChain) || '';
            this._inFlight.set(c, (this._inFlight.get(c) || 0) + 1);
            this._started.set(c, (this._started.get(c) || 0) + 1);
            try { return await inner(sourceChain, batchData); }
            finally { this._inFlight.set(c, this._inFlight.get(c) - 1); }
        };
        return true;
    }

    ingestMark(chain) {
        const c = normalizeChain(chain) || '';
        return { inFlight: this._inFlight.get(c) || 0, started: this._started.get(c) || 0 };
    }

    // `before` and `after` are ingestMark readings taken around the indexer read. Any
    // ingest running at either edge, or begun in between, leaves the reading unconfirmed.
    observe(chain, value, before, after) {
        if (this.relay) return false;
        const c = normalizeChain(chain);
        const reading = readingOf(value);
        if (c === null || reading === null) return false;
        if (!before || !after) return false;
        if (before.inFlight !== 0 || after.inFlight !== 0 || before.started !== after.started) return false;
        const prev = this._landed.get(c);
        if (prev && (reading.block <= prev.block || reading.protocol_time < prev.protocol_time)) return false;
        this._landed.set(c, reading);
        return true;
    }

    // Relay mode: republish an upstream hub's `landed` object, values unchanged, shape
    // checked, and never moving an entry backwards.
    republishFrom(upstream) {
        if (!this.relay) return false;
        if (upstream === null || upstream === undefined) { this._upstream = null; return true; }
        if (typeof upstream !== 'object') return false;
        const out = {};
        for (const rawChain of Object.keys(upstream)) {
            const c = normalizeChain(rawChain);
            const reading = readingOf(upstream[rawChain]);
            if (c === null || reading === null) continue;
            out[c] = reading;
        }
        const prev = this._upstream || {};
        for (const c of Object.keys(out)) {
            const old = prev[c];
            if (old && (out[c].block < old.block || out[c].protocol_time < old.protocol_time)) out[c] = old;
        }
        for (const c of Object.keys(prev)) if (!out[c]) out[c] = prev[c];
        this._upstream = out;
        return true;
    }

    landed() {
        const out = {};
        const source = this.relay ? (this._upstream || {}) : Object.fromEntries(this._landed);
        for (const c of Object.keys(source)) out[c] = { block: source[c].block, protocol_time: source[c].protocol_time };
        return out;
    }
}

module.exports = { LandingWatermark, readingOf, selectReading, clearFrontierActive };
