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
 * XChain Hub - Cross-Chain PBFT Early Buffer and Control Payloads
 *
 * The bounded buffer for messages that reach a peer before its own round exists, and the
 * signed payloads a control message (view change, new view) and a commit vote are bound to,
 * so neither can be replayed into another round, another phase or another engine.
 *
 ********************************************************************/

const ValidatorIdentity = require('../../validators/identity.js');
const { positiveIntConfig } = require('../../lib/config_int.js');

module.exports = {
    initEarlyBuffer(){
        // Early-arrival buffer: a PROPOSE/PREPARE/COMMIT/VIEW_CHANGE can reach a
        // peer before that peer's own _discoverAndMatch created the round. Buffer
        // by match_id and drain in propose(). Bounded TTL prevents leaks if the
        // round never starts locally. Map<match_id, Array<envelope>>.
        this.earlyMessages    = new Map();
        this.earlyMessageTtl  = new Map();
        this.earlyMessageTtlMs    = 60 * 1000;
        this.earlyMessageMaxPerId = 32;
        // A-F5: early buffering happens BEFORE the round (and thus membership)
        // exists, so an attacker could (a) flood arbitrary match_ids to grow the
        // map without bound (only per-id was capped) and (b) buffer a PROPOSE
        // carrying an unbounded `row` (this engine had no size gate at all). Cap
        // both: a distinct-id ceiling with FIFO eviction, and a serialized-size
        // gate on each buffered envelope.
        // positiveIntConfig for the same reason the attestation half uses it: a negative
        // is truthy, and a negative MAX_BYTES inverts the size gate so every pre-membership
        // envelope is dropped rather than buffered, while a negative MAX_IDS evicts on
        // every insert.
        this.earlyMessageMaxDistinctIds = positiveIntConfig(this.config.XDEX_EARLY_MSG_MAX_IDS, 512,
            'XDEX_EARLY_MSG_MAX_IDS');
        this.earlyMessageMaxBytes       = positiveIntConfig(this.config.XDEX_EARLY_MSG_MAX_BYTES, 131072,
            'XDEX_EARLY_MSG_MAX_BYTES');
    },

    pruneEarlyMessages(now){
        for(let [id, expiresAt] of this.earlyMessageTtl){
            if(expiresAt <= now){ this.earlyMessages.delete(id); this.earlyMessageTtl.delete(id); }
        }
    },

    bufferEarlyMessage(id, envelope){
        let now = Date.now();
        this.pruneEarlyMessages(now);
        // Size gate (A-F5): drop an oversized pre-membership envelope rather than
        // buffer it. A PROPOSE's `row` is the only large field and a legitimate
        // one is far under this ceiling; this only rejects abuse.
        let sz;
        try { sz = JSON.stringify(envelope.data || '').length; }
        catch(e){ return; }   // unserializable (cycle) -> never a real message
        if(sz > this.earlyMessageMaxBytes) return;
        let arr = this.earlyMessages.get(id);
        if(!arr){
            // Distinct-id ceiling (A-F5): evict the OLDEST buffered id (Map is
            // insertion-ordered) before adding a new one so an attacker flooding
            // fresh match_ids cannot grow the buffer without bound within the TTL.
            if(this.earlyMessages.size >= this.earlyMessageMaxDistinctIds){
                let oldest = this.earlyMessages.keys().next().value;
                if(oldest !== undefined){ this.earlyMessages.delete(oldest); this.earlyMessageTtl.delete(oldest); }
            }
            arr = []; this.earlyMessages.set(id, arr);
        }
        if(arr.length >= this.earlyMessageMaxPerId) return;
        arr.push(envelope);
        this.earlyMessageTtl.set(id, now + this.earlyMessageTtlMs);
    },

    drainEarlyMessages(id){
        let arr = this.earlyMessages.get(id);
        if(!arr) return;
        this.earlyMessages.delete(id);
        this.earlyMessageTtl.delete(id);
        for(let env of arr) this._handleMessage(env);
    },

    // Signed control message (VIEW_CHANGE / NEW_VIEW). Authenticated by pubkey +
    // signature like the PROPOSE/PREPARE/COMMIT phases (NOT by envelope.sender,
    // which the transport sets to a validator address while our snapshot set is
    // pubkey-keyed). Binds tag+matchId+view so a vote can't be replayed elsewhere.
    controlPayload(tag, rid, view){ return tag + '|' + rid + '|' + view; },

    signControl(tag, rid, view){ return this.identity.sign(this.controlPayload(tag, rid, view)); },

    verifyControl(tag, rid, view, pubkey, sig){
        return ValidatorIdentity.verify(this.controlPayload(tag, rid, view), String(sig || ''), String(pubkey || '').toLowerCase());
    },

    // Phase-bound COMMIT vote payload (A-F6). The artifact signature
    // (d.sig, over the plain canonical) is what indexers persist and verify, so
    // it must stay phase-free; but on its own it made PREPARE and COMMIT votes
    // interchangeable (a COMMIT literally re-sent the prepare sig), letting one
    // Byzantine member replay everyone's PREPAREs as COMMITs and finalize a
    // round no honest peer had committed. COMMIT now additionally carries
    // commit_sig over this payload; a vote without it does not count. Prefixed
    // with the engine's COMMIT type so an XCALL relay commit can never be
    // replayed into an XDEX round (and vice versa).
    commitPayload(canonical){ return this.types.COMMIT + '|PHASEV1|' + canonical; },
};
