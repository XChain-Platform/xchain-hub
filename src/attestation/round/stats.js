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
 * XChain Hub - Attestation Round Stats
 *
 * What an operator or a drill can read off a running round manager: the local
 * round tallies and provider spend, the poll health that says whether the
 * request feed is admitting anything at all, and the consensus ring occupancy
 * whose caps are otherwise invisible until they cost a BTC fee.
 *
 ********************************************************************/

'use strict';

module.exports = {

    // Look up the round state for a given requestId. Accessor over this.rounds;
    // AttestationConsensus copies responsible/leaderPubkey into `pending` at
    // propose() time and never re-consults this map, so no consensus path calls
    // this. Currently exercised only by AttestationRound's unit tests.
    getRoundState(requestId){
        return this.rounds.get(String(requestId).toLowerCase()) || null;
    },

    getStats(){
        let proposed = 0, failed = 0;
        for(let [, entry] of this.rounds){
            if(entry.error) failed++;
            else proposed++;
        }
        // In-flight = seen but _startRound not yet resolved. Counted directly
        // (seen keys with no rounds entry) rather than `seen.size - rounds.size`:
        // the two maps evict on different windows (seen ~retryAfterMs, rounds
        // roundsTtlMs), so the raw size difference can go negative.
        let inFlight = 0;
        for(let rid of this.seen.keys()){
            if(!this.rounds.has(rid)) inFlight++;
        }
        let stats = {
            seen_count:      this.seen.size,
            in_flight_count: inFlight,
            proposed_count:  proposed,
            failed_count:    failed,
            // Provider spend, monotonic for the process life (never evicted with
            // `rounds` or `seen`, which is the point: the question they answer is
            // whether a restart re-paid for a request, and a restart is exactly
            // when those maps are empty). ZC2 reads fetch_count on every
            // responsible hub after a re-mine and expects 1.
            fetch_count:           this.fetchCount,
            fetch_cache_hit_count: this.fetchCacheHitCount,
            finalized_skip_count:  this.finalizedSkipCount,
            // Poll health (item 7650). Every counter above is frozen by a feed that
            // admits nothing, so a consumer watching only those reads a stalled hub as a
            // quiet one. These two say the opposite thing: the count rises while the
            // indexer rejects, and the age grows while nothing succeeds. Age is null,
            // never a large number, when no poll has ever succeeded, so a consumer
            // cannot mistake a hub that just booted for one that has been stalled.
            poll_rpc_error_count:        this.pollRpcErrorCount,
            last_successful_poll_age_ms: this.lastPollOkAt === null ? null : (Date.now() - this.lastPollOkAt)
        };
        // Expose the non-ok publication-throttle ring health so an
        // undersized ATTESTATION_NONOK_PUBLISHED_MAX (evictions of entries
        // whose requests are still pending) is operator-visible.
        if(this.consensus){
            this.consensusRingStats(stats);
        }
        return stats;
    },

    // The consensus-side ring occupancy, reported through the round manager
    // because it is the object an operator already reads.
    consensusRingStats(stats){
            stats.nonok_published_count               = this.consensus.nonOkPublished.size;
            stats.nonok_published_max                 = this.consensus.nonOkPublishedMax;
            stats.nonok_evicted_while_pending_count   = this.consensus.nonOkEvictedWhilePendingCount;
            // Same three for the ok/`finalized` suppression ring, which had no
            // stats at all: an undersized ATTESTATION_FINALIZED_MAX surfaced only
            // as unexplained duplicate rounds and re-burned BTC fees. Occupancy
            // against the cap says how close the ring is to evicting; the count is
            // monotonic for the process life, so consumers alert on a rise.
            stats.finalized_count                    = this.consensus.finalized.size;
            stats.finalized_max                      = this.consensus.finalizedMax;
            stats.finalized_evicted_while_pending_count = this.consensus.finalizedEvictedWhilePendingCount;
            // Consensus round timeouts (item 8c1148c0). failed_count above
            // counts only THIS hub's local provider-fetch failures (entry.error)
            // over the TTL-evicting `rounds` map; a round torn down by the PBFT
            // timeout never reaches that map with an error and so was invisible
            // to every consumer of these stats. Monotonic for the process life,
            // so consumers alert on a rise, not on a nonzero snapshot.
            stats.consensus_timeout_count            = this.consensus.roundTimeoutCount;
    }

};
