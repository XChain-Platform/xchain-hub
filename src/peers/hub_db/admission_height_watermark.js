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
 * XChain Hub - Admission Height Watermark
 *
 * The per-table per-chain admission height watermark the hub DB broadcaster
 * publishes on its frames: what it means, the rule that advances it, and the
 * late-finalization refusal that pairs with it.
 *
 ********************************************************************/

const { positiveIntConfig } = require('../../lib/config_int.js');
const { ADMIT_COLUMN_CHAINS, normalizeChain, rowAdmitBlocks } = require('../../lib/admission_height.js');
const { admitMarginBlocks } = require('../../consensus/gates/mirror_admission_gate.js');
const hubConfig = require('../../config');

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
            hubConfig.XDEX_ROUND_TIMEOUT_MS || this.config.XDEX_ROUND_TIMEOUT_MS, 120000, 'XDEX_ROUND_TIMEOUT_MS');
        this.roundWindows = {
            xdex: positiveIntConfig(
                hubConfig.XDEX_ROUND_MAX_LIFETIME_MS || this.config.XDEX_ROUND_MAX_LIFETIME_MS,
                xdexTimeout * 4, 'XDEX_ROUND_MAX_LIFETIME_MS'),
            attest: positiveIntConfig(
                hubConfig.ATTESTATION_ROUND_TIMEOUT_MS || this.config.ATTESTATION_ROUND_TIMEOUT_MS,
                120000, 'ATTESTATION_ROUND_TIMEOUT_MS'),
            anchor: positiveIntConfig(
                hubConfig.ANCHOR_ROUND_TIMEOUT_MS || this.config.ANCHOR_ROUND_TIMEOUT_MS,
                120000, 'ANCHOR_ROUND_TIMEOUT_MS'),
            // A price round's terminal bound is its own cadence: the next round opens only
            // once this one is finalized or skipped, so the interval is what bounds how long
            // a round can hold the watermark.
            price: positiveIntConfig(
                hubConfig.ORACLE_ROUND_INTERVAL || this.config.ORACLE_ROUND_INTERVAL,
                600000, 'ORACLE_ROUND_INTERVAL'),
            // oracle_prices has no consensus round at all: the rows are the hub's own ingest
            // of an on-chain PRICE v1 transaction, so the bound is how long an ingest may
            // trail the chain it reads. Its own knob, because nothing else sizes it.
            oracle: positiveIntConfig(
                hubConfig.ADMISSION_ORACLE_INGEST_WINDOW_MS || this.config.ADMISSION_ORACLE_INGEST_WINDOW_MS,
                600000, 'ADMISSION_ORACLE_INGEST_WINDOW_MS'),
        };

        // A hub that is NOT a consensus member for a rail, a relay serving a mirrored copy
        // of another hub's database, observes no rounds and may therefore CLAIM nothing. It
        // republishes its upstream's entry verbatim or publishes none, and its indexers
        // defer fail-closed, attributable and bounded by the hold ceiling.
        this.relay = String(hubConfig.HUB_ADMISSION_RELAY || this.config.HUB_ADMISSION_RELAY || '') === '1'
                  || String(hubConfig.HUB_ADMISSION_RELAY || this.config.HUB_ADMISSION_RELAY || '').toLowerCase() === 'true';

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
     * An unusable reading is ignored rather than coerced: XChainHub.resolveAdmissionTip
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
    settledHeight(chain, cutoffMs){
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
                let settled = this.settledHeight(c, now - window);
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

module.exports = { AdmissionHeightWatermark, ADMISSION_WATERMARK_TABLES };
