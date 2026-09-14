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
 * XChain Hub - Attestation Round Records
 *
 * What this hub remembers about a request beyond the life of one round: who has
 * proposed for it, which rounds finalized, which were torn down without
 * finalizing, and which non-ok statuses have already been published. Every one
 * is a ring-bounded FIFO, and every cap has a horizon behind it.
 *
 ********************************************************************/

'use strict';
const { getLogger } = require('../../observability');
const logger = getLogger();

module.exports = {

    // Mark a round id as torn down without finalization (timeout / non-ok
    // finalization) so bufferEarlyMessage drops rather than parks its late
    // envelopes. Ring-bounded FIFO, mirroring markFinalized (item 2640).
    markTornDown(rid){
        // Already marked; return without a drop event (noteDrop counts dropped
        // MESSAGES and this path drops none, and it read an `envelope` this
        // method never takes, throwing from the round-timeout timer).
        if(this.tornDown.has(rid)) return;
        this.tornDown.add(rid);
        this._tornDownOrder.push(rid);
        if(this._tornDownOrder.length > this.tornDownMax){
            let oldest = this._tornDownOrder.shift();
            this.tornDown.delete(oldest);
        }
    },

    // Record that `pubkey` proposed for `rid`. Called for every PROPOSE this hub
    // ACCEPTS (sig verified, sender responsible, payload within cap) and for this
    // hub's own proposal at the moment it enters the round. A proposal this hub
    // refuses to make or to accept is deliberately not recorded: the peers judging
    // that slot see silence either way, and the whole point of the record is that
    // every hub reaches the same verdict from what crossed the wire.
    recordProposer(rid, pubkey){
        let key = String(rid || '').toLowerCase();
        let pk  = String(pubkey || '').toLowerCase();
        if(!key || !pk) return;
        let set = this.proposerSeen.get(key);
        if(!set){
            set = new Set();
            this.proposerSeen.set(key, set);
            this._proposerSeenOrder.push(key);
            if(this._proposerSeenOrder.length > this.proposerSeenMax){
                let oldest = this._proposerSeenOrder.shift();
                this.proposerSeen.delete(oldest);
            }
        }
        set.add(pk);
    },

    // Has `pubkey` proposed for `rid` at any point in the request's life, across
    // every retry round? Read by AttestationRound.resolveLeader to tell a leader
    // slot that is silent from one that is merely slow. An evicted (or never
    // recorded) rid reads false, which costs the round one more rotation window of
    // patience before it skips - the safe direction, since a wrongly skipped LIVE
    // leader loses a slot that could have finalized.
    hasProposedFor(rid, pubkey){
        let set = this.proposerSeen.get(String(rid || '').toLowerCase());
        return !!(set && set.has(String(pubkey || '').toLowerCase()));
    },

    // True while a consensus round for `rid` is live (pending, not yet
    // finalized/expired). AttestationRound consults this before issuing a paid
    // provider fetch so a re-poll of a still-running round short-circuits ahead
    // of the vendor call instead of after it (item 2358).
    isRoundActive(rid){
        return this.pending.has(String(rid).toLowerCase());
    },

    // Whether this hub already finalized a round for the request. Consulted by
    // AttestationRound BEFORE the provider is paid, and again in propose(): the
    // request stays in the indexer's pending list until its callback binds,
    // which outlives the `seen` and fetch-cache windows, so a re-poll must be
    // refused ahead of the fetch. An evicted rid reads false, as in propose(),
    // so the tombstone re-propose path is unchanged.
    isFinalized(rid){
        return this.finalized.has(String(rid).toLowerCase());
    },

    // Record a finalized request ID, evicting the oldest once the ring-buffer
    // cap (`finalizedMax`) is reached. Keeps `finalized` bounded while
    // preserving Set semantics for the duplicate-finalization guards.
    markFinalized(rid){
        if(this.finalized.has(rid)) return;
        this.finalized.add(rid);
        this._finalizedOrder.push(rid);
        if(this._finalizedOrder.length > this.finalizedMax){
            let oldest = this._finalizedOrder.shift();
            this.finalized.delete(oldest);
            this.rememberEvictedFinalized(oldest);
        }
    },

    // Tombstone an evicted ok rid so propose() can later prove the eviction was
    // premature. Ring-bounded FIFO like every other set here, so the detector
    // cannot itself become the unbounded growth `finalized` was capped to avoid.
    rememberEvictedFinalized(rid){
        if(this._finalizedEvicted.has(rid)) return;
        this._finalizedEvicted.add(rid);
        this._finalizedEvictedOrder.push(rid);
        if(this._finalizedEvictedOrder.length > this.finalizedMax)
            this._finalizedEvicted.delete(this._finalizedEvictedOrder.shift());
    },

    // Record that a non-ok status has been published for a request, bounding
    // the map with the same FIFO ring discipline as `finalized` but under the
    // deadline-window-derived `nonOkPublishedMax` cap, NOT
    // `finalizedMax`: non-ok entries stay retry-suppression-relevant until
    // their provider deadline, a far longer horizon than an ok finalization.
    recordNonOkPublished(rid, status){
        let set = this.nonOkPublished.get(rid);
        if(!set){
            set = new Set();
            this.nonOkPublished.set(rid, set);
            this._nonOkPublishedOrder.push(rid);
            if(this._nonOkPublishedOrder.length > this.nonOkPublishedMax){
                let oldest = this._nonOkPublishedOrder.shift();
                this.nonOkPublished.delete(oldest);
                // Evict-while-pending detection: a rid that never reached a
                // terminal ok finalization is (as far as this hub can tell)
                // still pending and retryable on the indexer, so evicting its
                // throttle record re-opens duplicate non-ok publications
                // (re-quorum-sign + re-broadcast, one burned BTC tx per retry
                // poll). Warn + count so operators can raise the cap.
                if(!this.finalized.has(oldest)){
                    this.nonOkEvictedWhilePendingCount++;
                    logger.warn('AttestationConsensus: evicted non-ok throttle entry for still-pending request ' +
                                oldest.substring(0,16) + '... (ring full at ' + this.nonOkPublishedMax +
                                '; raise ATTESTATION_NONOK_PUBLISHED_MAX; evictions_while_pending=' +
                                this.nonOkEvictedWhilePendingCount + ')');
                }
            }
        }
        set.add(status);
    }

};
