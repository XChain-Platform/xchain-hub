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
const { positiveIntConfig } = require('./lib/config_int.js');
const { ADMIT_COLUMN_CHAINS, normalizeChain, rowAdmitBlocks } = require('./lib/admission_height.js');
const { admitMarginBlocks } = require('./mirror_admission_activation.js');

// JSON replacer that converts BigInt to string (mariadb returns BigInt for BIGINT columns)
const { bigIntReplacer } = require('./lib/bigint_replacer.js');

// ---------------------------------------------------------------------------
// The per-table per-chain admission height watermark
// ---------------------------------------------------------------------------

/*
 * The stream watermark this file already broadcasts is the hub's WALL CLOCK in unix
 * seconds, on a frame typed 'watermark' whose numeric field is `ts`. The height
 * watermark is a block height on a NAMED chain, and it rides that same frame as a
 * separate `heights` field. Two different units on one carrier: `ts` is untouched
 * below, because the stream-stall detector and the liveness stamp read it.
 *
 * W[table][c] is the greatest height h on chain c such that every consensus round
 * for `table` that OPENED while this hub observed an admission tip for c at or
 * below h has TERMINATED: finalized and broadcast, or abandoned. That sentence is
 * exactly the completeness a height-keyed barrier certifies, and the barrier
 * comparison (heights[table][C] >= B - ADMIT_MARGIN_BLOCKS[table]) is it
 * rearranged.
 *
 * THE RULE THAT ADVANCES IT, and why it needs no per-round registry. Tip
 * observations are monotonic, so if this hub first observed tip v at instant t_v,
 * every round it opened while the observed tip was at or below v - 1 opened BEFORE
 * t_v. A round that has not terminated within its rail's round timeout is
 * ABANDONED for admission purposes and stops holding the watermark. So once wall
 * clock passes t_v + roundTerminalMs(table), every round that opened at an observed
 * tip <= v - 1 has terminated or been abandoned, and v - 1 is sound for W.
 *
 * Hence: W[table][c] is ONE BELOW the newest tip this hub observed for c at or
 * before (now - roundTerminalMs(table)). W trails the observed tip by the blocks
 * that chain mines in one round window plus one, which is the stated per-rail
 * per-chain bound rather than the open-ended wait the draft had. Without the
 * timeout a single hung round would freeze W and every indexer on that table
 * forever, and the named remedy cannot clear it: the indexer's 900 s hold ceiling
 * drives requestResync, which is delivery-side and cannot reach a producer-side
 * stall.
 *
 * FAIL-CLOSED EVERYWHERE. A missing table key, a missing chain key inside a table,
 * a non-finite value and a hub that has never served one all read as NOT satisfied
 * on the consumer side, so every absence defers the barrier exactly as today. That
 * is why nothing here ever guesses: an unusable reading publishes no entry.
 */

// Per mirrored table: which chains can carry an entry, and which rail's round
// window bounds its trail. `chains: null` means every chain the federation serves.
// The BTC-only rails are BTC-only by their consumers' own call-site guard
// (XChainIndexer.js:1495, :1517), so a second chain's entry there would be a claim
// no consumer ever reads.
const ADMISSION_WATERMARK_TABLES = Object.freeze({
    cross_chain_matches:        Object.freeze({ chains: null,                      round: 'xdex'   }),
    cross_chain_calls:          Object.freeze({ chains: null,                      round: 'xdex'   }),
    bridge_transfers:           Object.freeze({ chains: null,                      round: 'xdex'   }),
    policy_snapshots:           Object.freeze({ chains: null,                      round: 'xdex'   }),
    price_snapshots:            Object.freeze({ chains: null,                      round: 'price'  }),
    // The unsigned rail: its admission height is a SCALAR on the publishing chain, so its
    // entries are keyed by publishing chain rather than by reading chain. Same frame shape,
    // different meaning, and the consumer reads it against the row's own source_chain.
    oracle_prices:              Object.freeze({ chains: null,                      round: 'oracle' }),
    attestation_responses:      Object.freeze({ chains: Object.freeze(['BTC']),     round: 'attest' }),
    anchor_reward_attestations: Object.freeze({ chains: Object.freeze(['BTC']),     round: 'anchor' }),
});

class AdmissionHeightWatermark {

    constructor(config){
        this.config = config || {};
        // Every chain that HAS an admission column, which is every chain an admission
        // height can exist for. A chain with no column can carry no height, so an entry
        // for it would be a claim about rows that cannot exist.
        this.federationChains = ADMIT_COLUMN_CHAINS.slice();

        // The round-abandon timeout per rail, in ms. Each one is its rail's own terminal
        // bound read from its rail's own knob, so an operator who widened a rail's rounds
        // widens its watermark trail by the same amount instead of the watermark claiming
        // past rounds that are still open.
        //
        // xdex covers matches, calls, bridge transfers and policy snapshots: all four run
        // on CrossChainDexConsensus (CrossChainCallEngine.js:193, CrossChainBridgeEngine.js
        // :211, :231), whose terminal bound is the round MAX LIFETIME and not the single
        // round timeout, because a view change re-arms the timeout on a round that is still
        // open (CrossChainDexConsensus.js:134, :140).
        let xdexTimeout = positiveIntConfig(
            process.env.XDEX_ROUND_TIMEOUT_MS || this.config.XDEX_ROUND_TIMEOUT_MS, 120000, 'XDEX_ROUND_TIMEOUT_MS');
        this.roundWindows = {
            xdex: positiveIntConfig(
                process.env.XDEX_ROUND_MAX_LIFETIME_MS || this.config.XDEX_ROUND_MAX_LIFETIME_MS,
                xdexTimeout * 4, 'XDEX_ROUND_MAX_LIFETIME_MS'),
            attest: positiveIntConfig(
                process.env.ATTESTATION_ROUND_TIMEOUT_MS || this.config.ATTESTATION_ROUND_TIMEOUT_MS,
                120000, 'ATTESTATION_ROUND_TIMEOUT_MS'),
            anchor: positiveIntConfig(
                process.env.ANCHOR_ROUND_TIMEOUT_MS || this.config.ANCHOR_ROUND_TIMEOUT_MS,
                120000, 'ANCHOR_ROUND_TIMEOUT_MS'),
            // A price round's terminal bound is its own cadence: the next round opens only
            // once this one is finalized or skipped, so the interval is what bounds how long
            // a round can hold the watermark.
            price: positiveIntConfig(
                process.env.ORACLE_ROUND_INTERVAL || this.config.ORACLE_ROUND_INTERVAL,
                600000, 'ORACLE_ROUND_INTERVAL'),
            // oracle_prices has no consensus round at all: the rows are the hub's own ingest
            // of an on-chain PRICE v1 transaction, so the bound is how long an ingest may
            // trail the chain it reads. Its own knob, because nothing else sizes it.
            oracle: positiveIntConfig(
                process.env.ADMISSION_ORACLE_INGEST_WINDOW_MS || this.config.ADMISSION_ORACLE_INGEST_WINDOW_MS,
                600000, 'ADMISSION_ORACLE_INGEST_WINDOW_MS'),
        };

        // A hub that is NOT a consensus member for a rail, a relay serving a mirrored copy
        // of another hub's database, observes no rounds and may therefore CLAIM nothing. It
        // republishes its upstream's entry verbatim or publishes none, and its indexers
        // defer fail-closed, attributable and bounded by the hold ceiling.
        this.relay = String(process.env.HUB_ADMISSION_RELAY || this.config.HUB_ADMISSION_RELAY || '') === '1'
                  || String(process.env.HUB_ADMISSION_RELAY || this.config.HUB_ADMISSION_RELAY || '').toLowerCase() === 'true';

        this._obs   = new Map();   // chain -> [{atMs, height}], heights strictly increasing
        this._caps  = new Map();   // 'table|chain' -> height ceiling, or absent
        this._floor = {};          // the durable floor read back after a restart
        this._upstream = null;     // relay mode only: the validated upstream map
    }

    /** The round-abandon timeout, in ms, that bounds `table`'s watermark trail. */
    roundTerminalMs(table){
        let spec = Object.prototype.hasOwnProperty.call(ADMISSION_WATERMARK_TABLES, String(table))
            ? ADMISSION_WATERMARK_TABLES[String(table)] : null;
        if(!spec) return null;
        return this.roundWindows[spec.round];
    }

    /**
     * Record an admission tip observation for `chain`.
     *
     * Only an ADVANCE is recorded, and a repeat of the same height deliberately does NOT
     * refresh the existing observation's timestamp. The observation's age is what dates
     * the claim, so refreshing it on a frozen chain would let the watermark keep claiming
     * against a tip that has not moved.
     *
     * An unusable reading is ignored rather than coerced: XChainHub._resolveAdmissionTip
     * returns null for every failure it knows about (no indexer URL, an RPC error, an
     * absent decoder_block, a tip its freshness gate dated as frozen), and Number(null) is
     * 0, a finite non-negative integer that would register as height zero.
     */
    observeTip(chain, height, atMs){
        let c = normalizeChain(chain);
        if(c === null) return false;
        if(typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) return false;
        let at = (typeof atMs === 'number' && Number.isFinite(atMs)) ? atMs : Date.now();
        if(!this._obs.has(c)) this._obs.set(c, []);
        let obs = this._obs.get(c);
        if(obs.length > 0 && height <= obs[obs.length - 1].height) return false;
        obs.push({ atMs: at, height: height });
        // Bounded: once the SECOND entry is itself settled for every rail, the first can
        // never be the newest settled observation again, so it is dropped.
        let longest = Math.max(...Object.values(this.roundWindows));
        while(obs.length >= 2 && obs[1].atMs <= at - longest) obs.shift();
        return true;
    }

    /** The newest tip observed for `chain` at or before `cutoffMs`, or null. */
    _settledHeight(chain, cutoffMs){
        let obs = this._obs.get(normalizeChain(chain) || '');
        if(!obs) return null;
        for(let i = obs.length - 1; i >= 0; i--)
            if(obs[i].atMs <= cutoffMs) return obs[i].height;
        return null;
    }

    /**
     * A per-rail CEILING on one entry, for a rail whose rows can be held past its round
     * window by something other than a round. The anchor-attest rail is the case: its
     * entry may not pass a snapshot whose deferred reward attestation is still queued
     * still queued, and that queue's TTL is hours rather than minutes.
     *
     * Pass null to clear. A cap may pull an already published entry DOWN, and that is
     * deliberate: a queued entry is positive evidence that the rail is not complete
     * through that height, and deferring is the fail-closed direction.
     */
    setTableCap(table, chain, height){
        let c = normalizeChain(chain);
        if(c === null) return false;
        let key = String(table) + '|' + c;
        if(height === null || height === undefined){ this._caps.delete(key); return true; }
        if(typeof height !== 'number' || !Number.isSafeInteger(height)) return false;
        this._caps.set(key, height);
        return true;
    }

    /**
     * Install the durable floor read back from storage.
     *
     * A claim that was sound when it was published stays sound: a round that had
     * terminated before this hub restarted has not un-terminated. Without the floor every
     * restart publishes nothing for one full round window while every indexer on every
     * re-keyed barrier defers, which is a mirror outage per restart rather than a design
     * property. The floor is never a CEILING and never a source of claims on its own: it
     * raises what this hub can justify from its own observations, and a cap still pulls
     * the result down.
     */
    setFloor(floor){
        this._floor = {};
        for(let table of Object.keys(floor || {})){
            if(!Object.prototype.hasOwnProperty.call(ADMISSION_WATERMARK_TABLES, table)) continue;
            let inner = floor[table];
            if(!inner || typeof inner !== 'object') continue;
            for(let rawChain of Object.keys(inner)){
                let c = normalizeChain(rawChain);
                let h = Number(inner[rawChain]);
                if(c === null || !Number.isSafeInteger(h) || h < 0) continue;
                if(!this._floor[table]) this._floor[table] = {};
                this._floor[table][c] = h;
            }
        }
        return this._floor;
    }

    /**
     * Relay mode: take an upstream hub's `heights` object and republish it verbatim.
     *
     * Verbatim means the VALUES are unchanged, not that the shape is unchecked: a table
     * this hub does not mirror, a chain code outside the closed vocabulary and a
     * non-integer height are dropped, because republishing a value no consumer can read
     * is the same as publishing none while looking like a claim.
     */
    republishFrom(upstream){
        if(!this.relay) return false;
        if(upstream === null || upstream === undefined){ this._upstream = null; return true; }
        if(typeof upstream !== 'object') return false;
        let out = {};
        for(let table of Object.keys(upstream)){
            if(!Object.prototype.hasOwnProperty.call(ADMISSION_WATERMARK_TABLES, table)) continue;
            let inner = upstream[table];
            if(!inner || typeof inner !== 'object') continue;
            let entry = {};
            for(let rawChain of Object.keys(inner)){
                let c = normalizeChain(rawChain);
                if(c === null) continue;
                let v = inner[rawChain];
                let h = (typeof v === 'number' || (typeof v === 'string' && /^(?:0|[1-9][0-9]*)$/.test(v)))
                    ? Number(v) : NaN;
                if(!Number.isSafeInteger(h) || h < 0) continue;
                entry[c] = h;
            }
            if(Object.keys(entry).length > 0) out[table] = entry;
        }
        this._upstream = out;
        return true;
    }

    /**
     * The `heights` object for the wire: table, then chain, then a block height.
     *
     * Always an object, never omitted, and an EMPTY object is the honest reading of a hub
     * that cannot justify a single entry yet. Empty and absent are identical to the
     * consumer (both read as not satisfied), so nothing is lost by saying so.
     */
    heights(nowMs){
        let now = (typeof nowMs === 'number') ? nowMs : Date.now();
        // A relay mints nothing, at any height, for any rail.
        if(this.relay) return this._upstream ? JSON.parse(JSON.stringify(this._upstream)) : {};

        let out = {};
        for(let table of Object.keys(ADMISSION_WATERMARK_TABLES)){
            let spec   = ADMISSION_WATERMARK_TABLES[table];
            let window = this.roundWindows[spec.round];
            let chains = spec.chains || this.federationChains;
            let entry  = {};
            for(let c of chains){
                let settled = this._settledHeight(c, now - window);
                // One BELOW the settled tip: the observation proves the tip was at or below
                // settled - 1 before it was recorded, which is what the claim needs.
                let base  = (settled === null) ? null : settled - 1;
                let floor = (this._floor[table] && Object.prototype.hasOwnProperty.call(this._floor[table], c))
                    ? this._floor[table][c] : null;
                let h = (base === null) ? floor : (floor === null ? base : Math.max(base, floor));
                if(h === null) continue;
                let cap = this._caps.has(table + '|' + c) ? this._caps.get(table + '|' + c) : null;
                if(cap !== null) h = Math.min(h, cap);
                if(!Number.isSafeInteger(h) || h < 0) continue;
                entry[c] = h;
            }
            if(Object.keys(entry).length > 0) out[table] = entry;
        }
        return out;
    }

    /**
     * Is this row a LATE finalization of a round the watermark already abandoned?
     *
     * The timeout that bounds the watermark is only half the rule; the other half is that
     * a late finalization of an abandoned round is REFUSED rather than broadcast. Without
     * it the watermark would certify completeness through a height and then the mirror
     * would be handed a row binding at or below it, which is the fork the claim exists to
     * rule out.
     *
     * A row's admission height is its opening tip plus the rail's margin, so the round
     * that produced it opened at an observed tip of admit_blocks[c] - margin. The round is
     * one the watermark already claimed terminated exactly when that opening tip is at or
     * below W[table][c].
     *
     * Returns null for a row this rule cannot touch: a LEGACY row carries no admission
     * height at all and is never refused, which is what keeps a hub below the activation
     * byte-identical to today.
     */
    isLateFinalization(table, row, nowMs){
        let t = String(table);
        if(!Object.prototype.hasOwnProperty.call(ADMISSION_WATERMARK_TABLES, t)) return null;
        let map;
        if(t === 'oracle_prices'){
            // The unsigned rail stores one unqualified column, and the chain it is a height
            // on is the row's own source_chain, so the map is rebuilt here rather than read
            // from per-chain columns that this table does not carry.
            let raw = (row || {}).admit_block;
            let c   = normalizeChain((row || {}).source_chain);
            if(raw === null || raw === undefined || c === null) return null;
            let h = Number(raw);
            if(!Number.isSafeInteger(h)) return null;
            map = {}; map[c] = h;
        } else {
            try { map = rowAdmitBlocks(row); }
            catch (err) { return { chain: null, reason: err.message, watermark: null, admitBlock: null }; }
            if(map === null) return null;
        }
        let claimed = this.heights(nowMs)[t] || {};
        let margin  = admitMarginBlocks(t);
        for(let c of Object.keys(map)){
            let w = claimed[c];
            if(typeof w !== 'number') continue;   // no claim for this chain: nothing to be late against
            let admitBlock = Number(map[c]);
            if(!Number.isSafeInteger(admitBlock)) continue;
            if(admitBlock - margin <= w)
                return { chain: c, reason: 'round abandoned', watermark: w, admitBlock: admitBlock };
        }
        return null;
    }
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
            process.env.WS_MAX_PER_IP || this.config.WS_MAX_PER_IP, 100, 'WS_MAX_PER_IP');
        this.maxSubscribers = positiveIntConfig(
            process.env.WS_MAX_SUBSCRIBERS || this.config.WS_MAX_SUBSCRIBERS, 1000, 'WS_MAX_SUBSCRIBERS');
        this.maxBufferedMessages = positiveIntConfig(
            process.env.WS_BACKPRESSURE_LIMIT || this.config.WS_BACKPRESSURE_LIMIT, 50, 'WS_BACKPRESSURE_LIMIT');

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
            process.env.WS_WATERMARK_INTERVAL_MS || this.config.WS_WATERMARK_INTERVAL_MS, 10000, 'WS_WATERMARK_INTERVAL_MS');

        // Heartbeat-cadence instrumentation. Whether a consumer's price
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

        // The height watermark rides the frames this class already sends. Constructed
        // here and sampled only once a source is attached, so a broadcaster built with no
        // hub (every existing caller, and every existing test) publishes an empty heights
        // object and starts no timer: additive on the wire, inert in behaviour.
        this.admissionWatermark = new AdmissionHeightWatermark(this.config);
        this.admissionSampleMs  = positiveIntConfig(
            process.env.ADMISSION_WATERMARK_SAMPLE_MS || this.config.ADMISSION_WATERMARK_SAMPLE_MS,
            30000, 'ADMISSION_WATERMARK_SAMPLE_MS');
        this._admissionHub   = null;
        this._admissionTimer = null;
        this._admissionFloorLoaded = false;
    }

    // The `heights` object every carrier stamps. One accessor so the heartbeat, the ready
    // frame and the ten REST snapshot pages cannot drift into publishing three different
    // shapes, which a consumer on any one of the three could not tell from a real claim.
    admissionHeights(nowMs) {
        return this.admissionWatermark ? this.admissionWatermark.heights(nowMs) : {};
    }

    // Attach the hub the watermark is sampled from, and start sampling.
    //
    // The broadcaster is constructed with (p2pConfig, db) and has no hub handle, so the
    // two things the watermark needs live behind this call: the per-chain admission tip
    // (XChainHub._resolveAdmissionTips, the DECODER tip rather than the committed tip that
    // a barriered indexer freezes) and the anchor rail's deferred reward-attest queue.
    attachAdmissionSource(hub) {
        if (!hub) return false;
        this._admissionHub = hub;
        if (this._admissionTimer) return true;
        let tick = () => {
            this._sampleAdmission().catch((e) =>
                console.error('HubDbBroadcaster: admission watermark sample failed:', e && e.message ? e.message : e));
        };
        this._admissionTimer = setInterval(tick, this.admissionSampleMs);
        if (this._admissionTimer.unref) this._admissionTimer.unref();
        tick();
        return true;
    }

    // One sampling pass: the durable floor once, then this hub's own tip observations, the
    // anchor queue-drain cap, and the floor written back.
    //
    // Every step degrades to "no entry" rather than to a guess, because a watermark entry
    // this hub cannot justify is a completeness claim over rows it may not hold.
    async _sampleAdmission() {
        let hub = this._admissionHub;
        let w   = this.admissionWatermark;
        if (!hub || !w) return;

        if (!this._admissionFloorLoaded) {
            this._admissionFloorLoaded = true;
            if (this.db && typeof this.db.getAdmissionWatermarkFloor === 'function') {
                try { w.setFloor(await this.db.getAdmissionWatermarkFloor(hub.network)); }
                catch (e) {
                    console.warn('HubDbBroadcaster: could not read the admission watermark floor; this hub '
                        + 'publishes no heights until its own tip observations age past one round window:',
                        e && e.message ? e.message : e);
                }
            }
        }

        if (typeof hub._resolveAdmissionTips === 'function') {
            let tips = await hub._resolveAdmissionTips(w.federationChains);
            let at   = Date.now();
            for (let c of Object.keys(tips || {})) w.observeTip(c, tips[c], at);
        }

        // The anchor-attest queue-drain rule. A queued entry at snapshot S means
        // the row for S is not written yet, so the entry may not pass S - 1. An empty queue
        // clears the cap and the generic bounded advance applies.
        let pub   = hub.stateAnchorPublisher;
        let floor = (pub && typeof pub.deferredRewardAttestFloor === 'function')
            ? pub.deferredRewardAttestFloor() : null;
        w.setTableCap('anchor_reward_attestations', 'BTC', (floor === null) ? null : floor - 1);

        if (this.db && typeof this.db.saveAdmissionWatermarkFloor === 'function') {
            try { await this.db.saveAdmissionWatermarkFloor(hub.network, w.heights()); }
            catch (e) {
                console.warn('HubDbBroadcaster: could not persist the admission watermark floor; a restart '
                    + 'will republish nothing for one round window:', e && e.message ? e.message : e);
            }
        }
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
        // `ts` is the stream watermark, a wall clock; `heights` is the height watermark, a
        // block height per chain per table. Separate fields on one carrier, because the
        // stream-stall detector and the liveness stamp both read `ts` and neither changes.
        let message = JSON.stringify({ type: 'watermark', ts: ts, heights: this.admissionHeights(nowMs) });
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
        if (this._admissionTimer) clearInterval(this._admissionTimer);
        this._admissionTimer = null;
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
                // Second member of the indexer's hub-state mirror set (HubDbSync's
                // HUB_STATE_TABLES pairs it with state_checkpoints above; this list must move
                // in lockstep with that one). It is NOT in the consumer's FULL_REPAGE_TABLES,
                // so the since_id cursor plus this advertised ceiling is the only thing that
                // repairs the subscribe-to-bootstrap window for it; with no entry the
                // consumer's catch-up branch is gated off entirely. No status filter: the
                // table is append-only, never retracted, and the snapshot endpoint serves it
                // unfiltered, so an unfiltered MAX(id) is exactly the ceiling that feed reaches.
                let ra = await this.db.doQuery('SELECT MAX(id) AS max_id FROM anchor_reward_attestations');
                maxIds.anchor_reward_attestations = (ra.length > 0 && ra[0].max_id != null) ? Number(ra[0].max_id) : 0;
            } catch (e) { /* table may not exist yet */ }
            try {
                let cc = await this.db.doQuery("SELECT MAX(id) AS max_id FROM cross_chain_calls WHERE status <> 'retracted'");
                maxIds.cross_chain_calls = (cc.length > 0 && cc[0].max_id != null) ? Number(cc[0].max_id) : 0;
            } catch (e) { /* table may not exist yet */ }
            try {
                // Third member of the hub-state mirror set (see anchor_reward_attestations
                // above; this list must move in lockstep with HUB_STATE_TABLES). The catch
                // below is empty by design and therefore silent, so a table name that does
                // not exist leaves the key absent with no log line, and an absent key gates
                // the consumer's gap catch-up for the table OFF entirely.
                // Unfiltered MAX(id), like anchor_reward_attestations and unlike the two
                // cross_chain_* entries: attestation_responses is insert-only and never
                // retracted, so a status filter would advertise a ceiling BELOW what the
                // snapshot feed serves and strand the catch-up.
                let ar = await this.db.doQuery('SELECT MAX(id) AS max_id FROM attestation_responses');
                maxIds.attestation_responses = (ar.length > 0 && ar[0].max_id != null) ? Number(ar[0].max_id) : 0;
            } catch (e) { /* table may not exist yet */ }
        }

        try {
            // watermark_interval_ms lets the consumer size its heartbeat watchdog from
            // the hub's ACTUAL cadence instead of a locally-guessed env default, so an
            // operator raising WS_WATERMARK_INTERVAL_MS on the hub can never make a
            // consumer terminate a healthy socket: the two knobs are linked on the wire,
            // not by a prose comment. Additive: older consumers ignore the field.
            // `heights` rides the ready frame as well as the heartbeat: without it
            // every reconnect stalls every height-keyed barrier for one watermarkIntervalMs
            // before the first heartbeat arrives, on a path that runs after every dropped
            // socket and every resync.
            ws.send(JSON.stringify({ type: 'ready', max_ids: maxIds, watermark: Math.floor(Date.now() / 1000), watermark_interval_ms: this.watermarkIntervalMs, heights: this.admissionHeights() }));
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
    // committed row forever. Closing the socket is the sanctioned repair:
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
        // The round-abandon timeout's other half: a late finalization of a round this hub's
        // height watermark already abandoned is REFUSED rather than broadcast. The watermark
        // has already certified completeness through that height, so handing the mirror a
        // row that binds at or below it is a fork, not a late delivery. A legacy row carries
        // no admission height and is never refused, so a hub below the activation is
        // byte-identical to today.
        if (this.admissionWatermark && event) {
            let late = this.admissionWatermark.isLateFinalization(event.table, event.row);
            if (late) {
                console.error('HubDbBroadcaster: REFUSING to broadcast a ' + event.table + ' row admissible at '
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
// Re-exported for callers that already hold this class; the definition itself lives in
// lib/bigint_replacer.js, which has no requires and so cannot be half-loaded by a cycle.
module.exports.bigIntReplacer = bigIntReplacer;
// The height watermark's producer and its table map, exported so the advance rule, the
// round-abandon timeout and the relay republish rule are drivable without a hub.
module.exports.AdmissionHeightWatermark    = AdmissionHeightWatermark;
module.exports.ADMISSION_WATERMARK_TABLES  = ADMISSION_WATERMARK_TABLES;
