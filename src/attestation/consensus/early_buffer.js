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
 * XChain Hub - Attestation Early Buffers
 *
 * Envelopes that arrive before the round they belong to can handle them: a
 * PROPOSE that beats this hub's own poll, a COMMIT that beats the winner. Both
 * are held, bounded and replayed; a round torn down without finalizing drops
 * its buffer rather than leaking prior-attempt votes into the retry.
 *
 ********************************************************************/

'use strict';
const { noteDrop } = require('../../consensus/diagnostics');

module.exports = {

    pruneEarlyMessages(now){
        for(let [rid, expiresAt] of this.earlyMessageTtl){
            if(expiresAt <= now){
                // A round that drains clears its buffer, so anything parked here
                // at expiry belongs to a round that never assembled.
                let lost = this.earlyMessages.get(rid);
                noteDrop({ reason: 'early_ttl', phase: 'attest_buffer', round: rid, count: lost ? lost.length : 0 });
                this.earlyMessages.delete(rid);
                this.earlyMessageTtl.delete(rid);
            }
        }
    },

    bufferEarlyMessage(rid, envelope){
        // Drop envelopes for a round torn down without finalization rather than
        // parking them for a later retry-round drain (item 2640). Parking them
        // would replay prior-attempt PBFT votes into the fresh round.
        if(this.tornDown.has(rid)) return;
        let now = Date.now();
        this.pruneEarlyMessages(now);
        // Size gate (A-F5): drop an oversized pre-round envelope rather than buffer
        // it. The default ceiling clears the largest legitimate PROPOSE (64 KB
        // max_response_bytes fallback x1.4 base64) with headroom; only abuse is cut.
        let sz;
        try { sz = JSON.stringify(envelope.data || '').length; }
        catch(e){
            noteDrop({ reason: 'oversized', phase: 'attest_buffer', round: rid, why: 'unserializable' });
            return;   // unserializable (cycle) -> never a real gossip message
        }
        if(sz > this.earlyMessageMaxBytes){
            noteDrop({ reason: 'oversized', phase: 'attest_buffer', round: rid, bytes: sz, sender: envelope && envelope.sender, envelope });
            return;
        }
        let arr = this.earlyMessages.get(rid);
        if(!arr){
            // Distinct-rid ceiling (A-F5): evict the OLDEST buffered rid (Map is
            // insertion-ordered) before adding a new one, so an attacker flooding
            // fresh requestIds cannot grow the buffer without bound within the TTL.
            if(this.earlyMessages.size >= this.earlyMessageMaxDistinctIds){
                let oldest = this.earlyMessages.keys().next().value;
                if(oldest !== undefined){
                    let lost = this.earlyMessages.get(oldest);
                    noteDrop({ reason: 'early_capacity', phase: 'attest_buffer', round: oldest, count: lost ? lost.length : 0, evicted_for: rid });
                    this.earlyMessages.delete(oldest); this.earlyMessageTtl.delete(oldest);
                }
            }
            arr = [];
            this.earlyMessages.set(rid, arr);
        }
        if(arr.length >= this.earlyMessageMaxPerRid){
            noteDrop({ reason: 'early_capacity', phase: 'attest_buffer', round: rid, sender: envelope && envelope.sender, envelope });
            return;
        }
        arr.push(envelope);
        this.earlyMessageTtl.set(rid, now + this.earlyMessageTtlMs);
    },

    drainEarlyMessages(rid){
        let arr = this.earlyMessages.get(rid);
        if(!arr) return;
        let expiresAt = this.earlyMessageTtl.get(rid);
        this.earlyMessages.delete(rid);
        this.earlyMessageTtl.delete(rid);
        // Enforce the buffer TTL on REPLAY, not only on write (bufferEarlyMessage). A
        // round that times out and is later re-proposed under the same rid would otherwise
        // replay stale PBFT envelopes buffered during the prior attempt; the attestation
        // canonical carries no attempt discriminator, so those sigs still verify and leak
        // prior-attempt votes into the fresh round. Drop an expired buffer, don't replay it.
        if(expiresAt !== undefined && Date.now() > expiresAt) return;
        for(let env of arr){
            this._handleMessage(env);
        }
    },

    // Hold a COMMIT that arrived before this round established a winner. See
    // the earlyCommits note in initEarlyBuffers for why these can't be dropped.
    bufferEarlyCommit(rid, envelope){
        // Size gate (A-F5 parity with bufferEarlyMessage): drop an oversized
        // pre-winner COMMIT rather than buffer it. Without this a peer could park
        // up to earlyCommitMaxPerRid envelopes each bounded only by the ~1 MB
        // WebSocket frame limit, a memory-amplification vector for the whole hub
        // process. The default ceiling clears any legitimate COMMIT with headroom.
        let sz;
        try { sz = JSON.stringify(envelope.data || '').length; }
        catch(e){ return; }   // unserializable (cycle) -> never a real gossip message
        if(sz > this.earlyMessageMaxBytes) return;
        let arr = this.earlyCommits.get(rid);
        if(!arr){
            arr = [];
            this.earlyCommits.set(rid, arr);
        }
        if(arr.length >= this.earlyCommitMaxPerRid) return;
        arr.push(envelope);
    },

    // Replay COMMITs buffered before the winner was known. Called from the two
    // sites that set pending.winner. Deletes the queue up-front so re-entrant
    // _handleCommit calls (now with a winner) process normally rather than
    // re-buffering.
    drainEarlyCommits(rid){
        let arr = this.earlyCommits.get(rid);
        if(!arr) return;
        this.earlyCommits.delete(rid);
        for(let env of arr){
            this._handleCommit(env);
        }
    }

};
