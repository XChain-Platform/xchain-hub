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
 * XChain Hub - Attestation Consensus Options
 *
 * The state one engine starts life with. Every map here is ring-bounded or
 * TTL-evicting and every cap is a sizing decision against a real horizon, so
 * the arguments are kept with the fields they size.
 *
 ********************************************************************/

'use strict';
const { positiveIntConfig } = require('../../lib/config_int.js');
// 2 minutes per request lifecycle. Lives in constants.js because
// AttestationRound floors its `seen` window on the same default; see there.
const { DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS } = require('../../constants.js');
const { DEFAULT_NONOK_PUBLISHED_MAX } = require('./constants.js');

module.exports = {

    // Per-request state and the two ok-suppression rings.
    initRoundRings(){
        // Per-request state: Map<requestId, pending>
        this.pending = new Map();

        // Already-finalized requests (prevents double-publish on re-receipt).
        // Ring-buffer bounded to the most-recent `finalizedMax` request IDs:
        // a finalized request only needs duplicate suppression within its
        // active round window, so aged-out IDs are safe to forget. Bounds
        // memory (a plain unbounded Set grew with lifetime request volume).
        // `_finalizedOrder` tracks insertion order for FIFO eviction while
        // `finalized` keeps O(1) Set semantics for the `.has(rid)` guards.
        //
        // SIZING INVARIANT: eviction is by COUNT, not age, so `finalizedMax`
        // must stay larger than the number of requests this hub finalizes
        // within the window a finalized rid still needs suppression, i.e. from
        // an `ok` finalization until the indexer flips that request out of
        // `getpendingattestation_requests` (roughly the BTC confirmation
        // horizon that gates `pollPending` -> `propose()`). If it is set too
        // low on a busy hub a rid can be evicted while its request is still
        // pending; the only remaining suppressor is `finalized.has(rid)` in
        // `propose()`, so premature eviction turns double-publish suppression
        // into a re-proposed, re-published round and a burned BTC fee per
        // re-poll (the indexer still rejects it as already-fulfilled, so this
        // is wasted fee, not a fork). The 10000 default clears this horizon by
        // a wide margin at expected request volumes; do not lower it without
        // re-deriving the floor from the confirmation horizon and poll cadence.
        this.finalized       = new Set();
        this._finalizedOrder = [];
        this.finalizedMax    = positiveIntConfig(this.config.ATTESTATION_FINALIZED_MAX, 10000, 'ATTESTATION_FINALIZED_MAX');

        // Violation detector for the sizing invariant above, which was otherwise
        // unobservable: eviction is by count, nothing asked whether the evicted
        // rid still needed suppression, and the first symptom was a re-proposed
        // round and a burned BTC fee with no counter to attribute it to the cap.
        // The sibling nonOk ring classifies its evictions against `finalized`; the
        // ok ring has no such in-hub oracle (the answer lives in the indexer's
        // pending list) and no BTC-confirmation horizon it could age an entry
        // against, so this detects by PROOF instead of by proxy: evicted rids are
        // kept as tombstones, and a later propose() for one is the indexer itself
        // demonstrating the request was still pending when the ring dropped it.
        // Sized to `finalizedMax`, which doubles the reach in rids at the same
        // order of memory. Deliberately no start-time sizing-floor check, unlike
        // checkNonOkSizingFloor(): that floor derives from a real provider
        // deadline_window_blocks, and inventing a static ok horizon here would
        // assert a number nothing in the hub can source.
        this._finalizedEvicted      = new Set();
        this._finalizedEvictedOrder = [];
        this.finalizedEvictedWhilePendingCount = 0;
    },

    // The non-ok publication throttle, sized from the provider deadline window
    // rather than from the ok ring's confirmation horizon.
    initNonOkThrottle(){
        // Non-ok publication throttle (Phase 4). A non-ok finalization leaves
        // the request PENDING on the indexer (retryable), so without a throttle
        // every subsequent failed retry round would quorum-sign and broadcast
        // the same provider_error/no_quorum response again, burning a BTC tx
        // per poll cycle for no new information. One publication per
        // (request_id, status) is the audit trail; the deadline-expiry path
        // remains the terminal backstop. Ring-bounded like `finalized`, but
        // with its OWN cap: a finalized-ok rid only needs suppression
        // until the indexer flips it out of the pending poll (the short BTC
        // confirmation horizon), while a non-ok rid stays RETRYABLE until its
        // provider deadline expires, a much longer window (the widest
        // deadline_window_blocks across provider defs; 100 BTC blocks for
        // http_get, ~17h). Capping this ring with `finalizedMax` sized it from
        // the wrong horizon: under load a still-pending non-ok entry could be
        // evicted while retry rounds keep running, and every later retry would
        // re-quorum-sign and re-broadcast the same failure status, burning a
        // BTC tx per poll cycle.
        //
        // SIZING FLOOR: ATTESTATION_NONOK_PUBLISHED_MAX must exceed the number
        // of requests this hub finalizes non-ok within the LONGEST provider
        // deadline window (max deadline_window_blocks x expected non-ok
        // request throughput per block). The default clears the current 100-
        // block http_get ceiling by a wide margin; re-derive before lowering.
        // Eviction of a rid that never reached a terminal ok finalization is
        // counted (`nonOkEvictedWhilePendingCount`) and warned on, since it
        // re-opens the duplicate-publication path this throttle exists to
        // close.
        // Map<rid, Set<status>>
        this.nonOkPublished       = new Map();
        this._nonOkPublishedOrder = [];
        this.nonOkPublishedMax    = positiveIntConfig(this.config.ATTESTATION_NONOK_PUBLISHED_MAX,
            DEFAULT_NONOK_PUBLISHED_MAX, 'ATTESTATION_NONOK_PUBLISHED_MAX');
        this.nonOkEvictedWhilePendingCount = 0;
    },

    // Process-lifetime counters. Consumers alert on a RISE, never on a raw
    // nonzero snapshot.
    initRoundCounters(){
        // Process-lifetime count of rounds torn down by the PBFT round timeout
        // (item 8c1148c0). Quorum loss is terminal for that round but touches
        // NO counter otherwise: the timeout handler warns and deletes, and
        // AttestationRound.getStats' failed_count only sees rounds this hub
        // failed to FETCH locally, so a hub losing every round to quorum
        // timeout reported a perfectly healthy attestation rail. Monotonic and
        // process-scoped (resets to 0 on hub restart), so consumers alert on a
        // RISE between reads, never on a raw nonzero snapshot. Deliberately a
        // counter of its own rather than folded into failed_count: failed_count
        // is a live gauge over the TTL-evicting `rounds` map, so a timeout
        // landing in the same tick as an eviction would net out flat and be
        // swallowed by the consumer's rising-count comparison.
        this.roundTimeoutCount = 0;

        // Process-lifetime count of bodies refused for exceeding
        // ATTEST_RESPONSE_BODY_MAX_BYTES, across all three surfaces the cap
        // is enforced at: this hub declining to propose its own oversize
        // body, a peer's oversize PROPOSE, and a peer's oversize PREPARE.
        // Monotonic and process-scoped, same reading convention as
        // roundTimeoutCount: alert on a rise, not on a raw nonzero snapshot.
        this.bodyOverCapRejectCount = 0;
    },

    // The pre-round buffers: envelopes that arrived before this hub opened the
    // round, and COMMITs that arrived before it knew the winner.
    initEarlyBuffers(){
        // Early-arrival buffer. With staggered hub polls, the first proposer's
        // PROPOSE often reaches peers before they start their own round.
        // handlePropose silently returns at `if(!pending)`, losing the vote.
        // Buffer envelopes here keyed by rid and drain in propose() once
        // pending exists. Bounded TTL prevents leaks if pending never starts.
        // Map<rid, Array<envelope>>
        this.earlyMessages = new Map();
        // Map<rid, expiresAtMs>
        this.earlyMessageTtl = new Map();
        this.earlyMessageTtlMs = 60 * 1000;
        this.earlyMessageMaxPerRid = 32;
        // A-F5: early buffering happens BEFORE the round (and thus the responsible-set
        // membership check) exists, so an attacker could (a) flood arbitrary requestIds
        // to grow the map without bound (only per-rid was capped) and (b) buffer an
        // envelope carrying an oversized body_b64 (the maxBodyB64Length gate only runs
        // once `pending` exists). Cap both: a distinct-rid ceiling with FIFO eviction,
        // and a serialized-size gate on each buffered envelope. Mirrors the DEX half
        // (CrossChainDexConsensus, A-F5).
        // positiveIntConfig, not `parseInt(cfg) || DEFAULT`: a negative is truthy, and a
        // non-positive value here does not merely loosen a cap, it inverts the gate. A
        // negative MAX_BYTES makes `sz > max` true for EVERY envelope, so early buffering
        // is off entirely: the first proposer's PROPOSE is dropped on any peer whose round
        // has not started yet (the case the buffer exists for) and the round stalls to the
        // PBFT timeout. A negative MAX_IDS fires the distinct-rid eviction on every insert,
        // holding one rid at a time.
        this.earlyMessageMaxDistinctIds = positiveIntConfig(this.config.ATTESTATION_EARLY_MSG_MAX_IDS, 512,
            'ATTESTATION_EARLY_MSG_MAX_IDS');
        this.earlyMessageMaxBytes       = positiveIntConfig(this.config.ATTESTATION_EARLY_MSG_MAX_BYTES, 131072,
            'ATTESTATION_EARLY_MSG_MAX_BYTES');

        // Early-COMMIT buffer. A COMMIT can arrive after `pending` exists but
        // before a winner is established: the PROPOSE->agree() transition is
        // async, and drainEarlyMessages replays buffered envelopes in arrival
        // order, so a COMMIT can be replayed ahead of its own PROPOSE. Without
        // buffering, such a COMMIT hits the `!winner` guard in handleCommit and
        // is permanently dropped, costing the round that peer's vote and
        // stalling finalization in quorum>1 federations until a re-broadcast or
        // round timeout. Hold these per-request and drain them the instant a
        // winner is set (in maybeAdvanceFromProposals / handlePrepare).
        // Map<rid, Array<envelope>>
        this.earlyCommits = new Map();
        this.earlyCommitMaxPerRid = 32;
    },

    // What a torn-down or retried round leaves behind, plus the round timer
    // that tears one down.
    initTeardownRecords(){
        // Torn-down round guard (item 2640). A round destroyed WITHOUT entering
        // `this.finalized` (the timeout handler and the non-ok finalization path,
        // which keeps the rid RETRYABLE) leaves the top-of-handler
        // `if(this.finalized.has(rid)) return` guards inert, so a PROPOSE/PREPARE/
        // COMMIT that arrives for that rid after teardown falls into
        // bufferEarlyMessage and is parked for the full earlyMessageTtlMs. When a
        // retry round for the same rid opens within that window, drainEarlyMessages
        // replays those prior-attempt envelopes; the attestation canonical carries
        // no attempt discriminator, so their sigs still verify and a stale body can
        // win the first-wins proposal slot ahead of a peer's fresh vote. The
        // write-time TTL check bounds buffer AGE, not attempt boundaries, so it does
        // not close this. Track torn-down rids and drop (not park) their envelopes
        // in bufferEarlyMessage; propose() clears the mark when it installs a fresh
        // round so a legitimate retry can buffer again. Ring-bounded FIFO like
        // `finalized` so it cannot leak under requestId flooding.
        this.tornDown       = new Set();
        this._tornDownOrder = [];
        this.tornDownMax    = positiveIntConfig(this.config.ATTESTATION_TORNDOWN_MAX, 10000,
            'ATTESTATION_TORNDOWN_MAX');

        // Which responsible members have been OBSERVED proposing, per request
        // (ledger P60). `pending.proposals` already holds this for a LIVE round,
        // but a round timeout deletes `pending` outright while the request lives on
        // across retries, so the one question AttestationRound's leader rotation
        // has to answer - "has this member ever spoken for this request?" - had no
        // record that outlived a single attempt. Membership only; the proposals
        // themselves stay on `pending`, since a torn-down round must not be able to
        // hand a stale body to its successor (item 2640).
        // Map<rid, Set<pubkey>>, ring-bounded FIFO on the same rule as `tornDown`
        // so requestId flooding cannot grow it without bound.
        this.proposerSeen       = new Map();
        this._proposerSeenOrder = [];
        this.proposerSeenMax    = positiveIntConfig(this.config.ATTESTATION_PROPOSER_SEEN_MAX, 10000,
            'ATTESTATION_PROPOSER_SEEN_MAX');

        this._messageHandler = null;
        // Same rule as the ring caps above, and its sharpest instance: setTimeout with a
        // NEGATIVE delay fires on the next tick, so a negative here tears every round
        // down before any peer PROPOSE/PREPARE/COMMIT can arrive and the attestation
        // rail goes silent while roundTimeoutCount climbs.
        this.roundTimeoutMs  = positiveIntConfig(this.config.ATTESTATION_ROUND_TIMEOUT_MS,
            DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS, 'ATTESTATION_ROUND_TIMEOUT_MS');
    }

};
