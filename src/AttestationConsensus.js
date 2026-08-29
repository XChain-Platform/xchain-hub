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
 * XChain Hub - Attestation Consensus
 *
 * PBFT consensus for attestation rounds. Each round is keyed by request_id
 * (not a round number). The flow:
 *
 *   AttestationRound.propose(requestId, roundState)
 *     -> if I'm responsible, broadcast ATTEST_PROPOSE with my fetched body
 *   ATTEST_PROPOSE handler
 *     -> collect proposals; once REDUNDANCY are in (or timeout), run
 *        provider.agree(proposals) -> winner. Sign canonical bytes for the
 *        winner. Broadcast ATTEST_PREPARE.
 *   ATTEST_PREPARE handler
 *     -> collect prepares; finalize on max(quorum, REDUNDANCY). The PBFT quorum
 *        (max(2f+1, ceil((N+1)/2)) over the responsible set, size=REDUNDANCY) is
 *        provably <= REDUNDANCY by construction, so REDUNDANCY is the binding
 *        threshold in every reachable case; the 2f+1/majority form is retained as
 *        scaffolding but is currently dominated (see the invariant in propose()).
 *        Broadcast ATTEST_COMMIT.
 *   ATTEST_COMMIT handler
 *     -> collect commits; on quorum, emit 'request:finalized' for the
 *        publisher to ship the on-chain ATTEST v1 (response).
 *
 * Validator-set snapshot is locked at the request's block_index via
 * CapabilitySnapshot: every hub derives the same responsible set (and thus
 * the same PBFT quorum over it) for the round.
 *
 ********************************************************************/

const crypto            = require('crypto');
const EventEmitter      = require('events');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const eq                = require('./equivocation_header.js');
const { bftQuorumOrSingle } = require('./lib/bft_quorum.js');
const { positiveIntConfig } = require('./lib/config_int.js');
// 2 minutes per request lifecycle. Lives in constants.js because
// AttestationRound floors its `seen` window on the same default; see there.
const { DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS } = require('./constants.js');

const ATTEST_PROPOSE = 'ATTEST_PROPOSE';
const ATTEST_PREPARE = 'ATTEST_PREPARE';
const ATTEST_COMMIT  = 'ATTEST_COMMIT';

// Default cap for the nonOkPublished throttle ring. Floor derives
// from the LONGEST provider deadline window (deadline_window_blocks, currently
// 100 BTC blocks for http_get), not the ok/BTC-confirmation horizon that sizes
// `finalizedMax`: non-ok entries must survive until deadline expiry. 40000
// clears 100 blocks even at ~400 non-ok finalizations per block.
const DEFAULT_NONOK_PUBLISHED_MAX = 40000;
// Non-ok finalizations per block the default is sized to absorb, read straight back
// out of the derivation above (40000 entries / 100 blocks). It is the one number the
// sizing floor needs that governance does NOT supply, so naming it lets the floor be
// re-derived against a CHANGED deadline_window_blocks instead of against the 100-block
// figure the comments were written around (item 3421).
const NONOK_THROUGHPUT_PER_BLOCK = DEFAULT_NONOK_PUBLISHED_MAX / 100;
// Cap for the inbound `meta` and `status` fields on PROPOSE/PREPARE envelopes,
// mirroring the body_b64 cap: both are short tags (meta a provider tag, HTTP
// status code or LLM model id; status one of 'ok', 'provider_error',
// 'no_quorum'), so anything longer is adversarial padding that would otherwise
// be stored, hashed into the canonical, and re-broadcast unbounded.
const ATTEST_META_MAX_LENGTH   = 256;
const PENDING_EVICT_MS         = 10000;   // hold finalized state ~10s for late-arriving duplicates, then evict

class AttestationConsensus extends EventEmitter {

    constructor(hub, providerRegistry){
        super();
        this.hub              = hub;
        this.peerManager      = hub.getPeerManager();
        this.db               = hub.db;
        this.identity         = hub.getIdentity ? hub.getIdentity() : null;
        this.providerRegistry = providerRegistry;
        this.config           = hub.p2pConfig || {};

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
        // horizon that gates `_pollPending` -> `propose()`). If it is set too
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

        // Early-arrival buffer. With staggered hub polls, the first proposer's
        // PROPOSE often reaches peers before they start their own round.
        // _handlePropose silently returns at `if(!pending)`, losing the vote.
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
        // envelope carrying an oversized body_b64 (the _maxBodyB64Length gate only runs
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
        // async, and _drainEarlyMessages replays buffered envelopes in arrival
        // order, so a COMMIT can be replayed ahead of its own PROPOSE. Without
        // buffering, such a COMMIT hits the `!winner` guard in _handleCommit and
        // is permanently dropped, costing the round that peer's vote and
        // stalling finalization in quorum>1 federations until a re-broadcast or
        // round timeout. Hold these per-request and drain them the instant a
        // winner is set (in _maybeAdvanceFromProposals / _handlePrepare).
        // Map<rid, Array<envelope>>
        this.earlyCommits = new Map();
        this.earlyCommitMaxPerRid = 32;

        // Torn-down round guard (item 2640). A round destroyed WITHOUT entering
        // `this.finalized` (the timeout handler and the non-ok finalization path,
        // which keeps the rid RETRYABLE) leaves the top-of-handler
        // `if(this.finalized.has(rid)) return` guards inert, so a PROPOSE/PREPARE/
        // COMMIT that arrives for that rid after teardown falls into
        // _bufferEarlyMessage and is parked for the full earlyMessageTtlMs. When a
        // retry round for the same rid opens within that window, _drainEarlyMessages
        // replays those prior-attempt envelopes; the attestation canonical carries
        // no attempt discriminator, so their sigs still verify and a stale body can
        // win the first-wins proposal slot ahead of a peer's fresh vote. The
        // write-time TTL check bounds buffer AGE, not attempt boundaries, so it does
        // not close this. Track torn-down rids and drop (not park) their envelopes
        // in _bufferEarlyMessage; propose() clears the mark when it installs a fresh
        // round so a legitimate retry can buffer again. Ring-bounded FIFO like
        // `finalized` so it cannot leak under requestId flooding.
        this.tornDown       = new Set();
        this._tornDownOrder = [];
        this.tornDownMax    = positiveIntConfig(this.config.ATTESTATION_TORNDOWN_MAX, 10000,
            'ATTESTATION_TORNDOWN_MAX');

        this._messageHandler = null;
        // Same rule as the ring caps above, and its sharpest instance: setTimeout with a
        // NEGATIVE delay fires on the next tick, so a negative here tears every round
        // down before any peer PROPOSE/PREPARE/COMMIT can arrive and the attestation
        // rail goes silent while roundTimeoutCount climbs.
        this.roundTimeoutMs  = positiveIntConfig(this.config.ATTESTATION_ROUND_TIMEOUT_MS,
            DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS, 'ATTESTATION_ROUND_TIMEOUT_MS');
    }

    async start(){
        if(!this.peerManager){
            console.log('AttestationConsensus: no peer manager; skipping start');
            return;
        }
        this._messageHandler = (env) => this._handleMessage(env);
        this.peerManager.on('message', this._messageHandler);
        this.checkNonOkSizingFloor();
        console.log('AttestationConsensus: started');
    }

    // item 3421 - observability for the nonOkPublished ring's SIZING FLOOR (see the
    // constructor). The cap is a fixed operator/env value read once at startup, but
    // the horizon it must clear is max(deadline_window_blocks), which is governance-
    // controlled JSON that ProviderRegistry loads verbatim and that nothing bounds.
    // A routine proposal raising http_get's window past 100, or registering a
    // provider with a longer one, silently invalidates the floor: nothing failed,
    // nothing warned, and the first symptom was nonOkEvictedWhilePendingCount rising
    // AFTER real BTC fees had already been re-burned on retry rounds. Deliberately
    // log-only and non-throwing: an undersized ring wastes fees, it does not fork, so
    // refusing to run would be the worse failure. Called at start() and again from
    // XChainHub after every provider hotReload, i.e. the moment governance lands.
    checkNonOkSizingFloor(){
        if(!this.providerRegistry || typeof this.providerRegistry.maxDeadlineWindowBlocks !== 'function') return null;
        let { blocks, providerId } = this.providerRegistry.maxDeadlineWindowBlocks();
        if(!(blocks > 0)) return null;
        let floor = blocks * NONOK_THROUGHPUT_PER_BLOCK;
        let ok    = this.nonOkPublishedMax >= floor;
        if(!ok){
            console.warn('AttestationConsensus: ATTESTATION_NONOK_PUBLISHED_MAX=' + this.nonOkPublishedMax +
                ' is BELOW the sizing floor of ' + floor + ' implied by provider "' + providerId +
                '" (deadline_window_blocks=' + blocks + ' x ' + NONOK_THROUGHPUT_PER_BLOCK +
                ' non-ok finalizations/block). A still-pending non-ok entry can be evicted while ' +
                'retry rounds keep running, and each later retry re-quorum-signs and re-broadcasts ' +
                'the same failure status, burning a BTC tx per poll cycle. Raise ' +
                'ATTESTATION_NONOK_PUBLISHED_MAX to at least ' + floor + ' or lower that window.');
        }
        return { ok, floor, cap: this.nonOkPublishedMax, blocks, providerId };
    }

    async stop(){
        if(this._messageHandler){
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        for(let [_, p] of this.pending){
            if(p.timer) clearTimeout(p.timer);
        }
        this.pending.clear();
        this.earlyMessages.clear();
        this.earlyMessageTtl.clear();
        this.earlyCommits.clear();
        this.nonOkPublished.clear();
        this._nonOkPublishedOrder = [];
        this.tornDown.clear();
        this._tornDownOrder = [];
    }

    // Mark a round id as torn down without finalization (timeout / non-ok
    // finalization) so _bufferEarlyMessage drops rather than parks its late
    // envelopes. Ring-bounded FIFO, mirroring _markFinalized (item 2640).
    _markTornDown(rid){
        if(this.tornDown.has(rid)) return;
        this.tornDown.add(rid);
        this._tornDownOrder.push(rid);
        if(this._tornDownOrder.length > this.tornDownMax){
            let oldest = this._tornDownOrder.shift();
            this.tornDown.delete(oldest);
        }
    }

    // True while a consensus round for `rid` is live (pending, not yet
    // finalized/expired). AttestationRound consults this before issuing a paid
    // provider fetch so a re-poll of a still-running round short-circuits ahead
    // of the vendor call instead of after it (item 2358).
    isRoundActive(rid){
        return this.pending.has(String(rid).toLowerCase());
    }

    _pruneEarlyMessages(now){
        for(let [rid, expiresAt] of this.earlyMessageTtl){
            if(expiresAt <= now){
                this.earlyMessages.delete(rid);
                this.earlyMessageTtl.delete(rid);
            }
        }
    }

    _bufferEarlyMessage(rid, envelope){
        // Drop envelopes for a round torn down without finalization rather than
        // parking them for a later retry-round drain (item 2640). Parking them
        // would replay prior-attempt PBFT votes into the fresh round.
        if(this.tornDown.has(rid)) return;
        let now = Date.now();
        this._pruneEarlyMessages(now);
        // Size gate (A-F5): drop an oversized pre-round envelope rather than buffer
        // it. The default ceiling clears the largest legitimate PROPOSE (64 KB
        // max_response_bytes fallback x1.4 base64) with headroom; only abuse is cut.
        let sz;
        try { sz = JSON.stringify(envelope.data || '').length; }
        catch(e){ return; }   // unserializable (cycle) -> never a real gossip message
        if(sz > this.earlyMessageMaxBytes) return;
        let arr = this.earlyMessages.get(rid);
        if(!arr){
            // Distinct-rid ceiling (A-F5): evict the OLDEST buffered rid (Map is
            // insertion-ordered) before adding a new one, so an attacker flooding
            // fresh requestIds cannot grow the buffer without bound within the TTL.
            if(this.earlyMessages.size >= this.earlyMessageMaxDistinctIds){
                let oldest = this.earlyMessages.keys().next().value;
                if(oldest !== undefined){ this.earlyMessages.delete(oldest); this.earlyMessageTtl.delete(oldest); }
            }
            arr = [];
            this.earlyMessages.set(rid, arr);
        }
        if(arr.length >= this.earlyMessageMaxPerRid) return;
        arr.push(envelope);
        this.earlyMessageTtl.set(rid, now + this.earlyMessageTtlMs);
    }

    _drainEarlyMessages(rid){
        let arr = this.earlyMessages.get(rid);
        if(!arr) return;
        let expiresAt = this.earlyMessageTtl.get(rid);
        this.earlyMessages.delete(rid);
        this.earlyMessageTtl.delete(rid);
        // Enforce the buffer TTL on REPLAY, not only on write (_bufferEarlyMessage). A
        // round that times out and is later re-proposed under the same rid would otherwise
        // replay stale PBFT envelopes buffered during the prior attempt; the attestation
        // canonical carries no attempt discriminator, so those sigs still verify and leak
        // prior-attempt votes into the fresh round. Drop an expired buffer, don't replay it.
        if(expiresAt !== undefined && Date.now() > expiresAt) return;
        for(let env of arr){
            this._handleMessage(env);
        }
    }

    // Hold a COMMIT that arrived before this round established a winner. See
    // the earlyCommits note in the constructor for why these can't be dropped.
    _bufferEarlyCommit(rid, envelope){
        // Size gate (A-F5 parity with _bufferEarlyMessage): drop an oversized
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
    }

    // Replay COMMITs buffered before the winner was known. Called from the two
    // sites that set pending.winner. Deletes the queue up-front so re-entrant
    // _handleCommit calls (now with a winner) process normally rather than
    // re-buffering.
    _drainEarlyCommits(rid){
        let arr = this.earlyCommits.get(rid);
        if(!arr) return;
        this.earlyCommits.delete(rid);
        for(let env of arr){
            this._handleCommit(env);
        }
    }

    // Called by AttestationRound after it fetches the body for a request.
    // Initializes the per-request state, captures the locked validator-set
    // snapshot + PBFT quorum, signs the canonical bytes for our own body,
    // and gossips ATTEST_PROPOSE.
    async propose(requestId, roundState){
        let rid = String(requestId).toLowerCase();
        if(this.finalized.has(rid)) return;
        if(this.pending.has(rid)) return;

        // Premature-eviction proof. Reaching here for a rid this hub already
        // ok-finalized and then evicted means the indexer still listed the request
        // as pending after the ring dropped it, i.e. ATTESTATION_FINALIZED_MAX sits
        // below the sizing invariant in the constructor. The round below will
        // re-publish an already-fulfilled response and burn a BTC tx, so count and
        // warn: the cap is the cause and nothing else names it. Observation only,
        // never a gate - a reorg that rolled the fulfillment back also arrives here
        // legitimately, and refusing the round would strand that request until its
        // deadline. The tombstone is left in place: if this round finalizes ok the
        // rid re-enters `finalized` and the guard above suppresses the next poll,
        // and if it does not, the next poll's fee is real and worth warning about
        // again.
        if(this._finalizedEvicted.has(rid)){
            this.finalizedEvictedWhilePendingCount++;
            console.warn('AttestationConsensus: re-proposing request ' + rid.substring(0,16) +
                '... whose finalized entry was already evicted (ring full at ' + this.finalizedMax +
                '; raise ATTESTATION_FINALIZED_MAX; evictions_while_pending=' +
                this.finalizedEvictedWhilePendingCount + ')');
        }

        let snapshot = roundState.snapshot;
        // PBFT messages (PROPOSE/PREPARE/COMMIT) only flow within the
        // REDUNDANCY-sized responsible set, so prepares/commits are bounded by
        // responsible.length (NOT the full attestation-validator count N).
        // Compute the quorum over the responsible set; computing it over N
        // would make the threshold unreachable whenever N > REDUNDANCY and
        // deadlock every round until timeout. The 2f+1 form is floored at a
        // simple majority (bare 2f+1 degenerates to quorum=1 at size 3).
        // INVARIANT: quorum <= redundancy by construction. AttestationRound builds
        // the responsible set as slice(0, max(1, redundancy)), so
        // responsible.length <= redundancy, and both 2f+1 and ceil((R+1)/2) are
        // <= responsible.length for all R >= 1. The finalization gates therefore
        // compute max(quorum, redundancy), which always resolves to redundancy:
        // redundancy is the binding finalization threshold, not this PBFT quorum.
        // `quorum` is retained as PBFT scaffolding (and to document intent) but
        // never sets the gate today. Do NOT wire it into a new path expecting it
        // to bind without first re-checking this invariant.
        let responsible = roundState.responsible || [];
        // Majority-floored BFT quorum over the responsible set (0 when
        // size <= 1). Same threshold as the full-count engines, computed over
        // responsible.length rather than N per the invariant documented above.
        let quorum      = bftQuorumOrSingle(responsible.length, 0);

        // Unfinalizable-round guard. The finalization gates require
        // max(quorum, redundancy) VALID signatures, and signatures can only ever
        // come from responsible-set members (_handleCommit rejects non-members).
        // When the block-anchored snapshot or weighted source-dedup shrinks the
        // responsible set below that threshold (AttestationRound._computeResponsibleSet
        // slices to max(1, redundancy) and can return fewer), signatures.size can
        // never reach `needed`: every PROPOSE/PREPARE/COMMIT cycle stalls to
        // timeout, including the non-ok outcome paths. Do NOT lower the gates to
        // responsible.length here: the indexer deterministically rejects any
        // payload carrying fewer than `redundancy` valid signatures, so a relaxed
        // gate would publish rows the indexer discards. Skip round admission
        // instead and let the request reach its normal deadline expiry + refund.
        let needed = Math.max(quorum, roundState.redundancy);
        if(responsible.length < needed){
            console.warn('AttestationConsensus: skipping unfinalizable round for ' + rid.substring(0,16) +
                '... (responsible=' + responsible.length + ' < needed=' + needed +
                '; quorum=' + quorum + ' redundancy=' + roundState.redundancy + ')');
            return;
        }

        let myPubkey  = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        let myBody    = roundState.myProposal.body;
        let myMeta    = roundState.myProposal.meta;
        // A failed fetch proposes status='provider_error' with an empty body
        // (see AttestationRound); the canonical binds the status, so the sig
        // is only ever valid for the outcome the proposer actually observed.
        let myStatus  = roundState.myProposal.status || 'ok';
        let mySig     = this._signCanonical(rid, roundState.providerId, myBody, myStatus, myMeta, Number(roundState.request.block_index));

        let pending = {
            requestId:    rid,
            request:      roundState.request,
            providerId:   roundState.providerId,
            redundancy:   roundState.redundancy,
            snapshot:     snapshot,
            quorum:       quorum,
            responsible:  roundState.responsible,
            leaderPubkey: roundState.leaderPubkey,
            role:         roundState.role,
            myPubkey:     myPubkey,
            // Map<pubkey, { body, meta, sig }>
            proposals:    new Map(),
            // Set<pubkey>: PREPARE/COMMIT votes (track by pubkey, not addr,
            // because attestation responsibility is pubkey-scoped)
            prepares:     new Set(),
            commits:      new Set(),
            // Map<pubkey, sig over canonical(winning body)>
            signatures:   new Map(),
            // Set once provider.agree() picks a winner from accumulated proposals
            winner:       null,
            status:       'ok',
            // Model identity snapshotted by AttestationRound at round start (Phase
            // 2: block-anchored at the request's block). Threaded into the leader's
            // provider.agree() call so the judge model cannot drift mid-round via a
            // governance hotReload of the module-mutable JUDGE_MODEL.
            pinnedJudgeModel: roundState.pinnedJudgeModel || null,
            // Block-anchored model->vendor map from the same config that pinned the
            // judge model, so the judge's vendor is not resolved from this hub's
            // live hotReloaded map while the id came from the block (item 3482).
            pinnedVendors: roundState.pinnedVendors || null,
            // Block-anchored approved_models from that same config, so the meta
            // allowlist gate judges against the set the fetch model was pinned
            // from rather than this hub's live one. Without it a
            // governance delisting of the pinned model froze the round at
            // no_quorum forever, since every retry re-pinned the same model.
            pinnedApprovedModels: roundState.pinnedApprovedModels || null,
            // Block-anchored PBFT strategy for this round. Every consensus_strategy
            // decision below reads THIS and never providerRegistry.getDef(): the registry
            // is re-parsed from the local configs table on every proposal:finalized
            // hotReload, so a live read could flip this hub's state machine between two
            // messages of one round, and two hubs whose reloads raced could run different
            // machines against the same request. AttestationRound resolves it once at the
            // request's own block and fails the round closed when it cannot.
            pinnedConsensusStrategy: roundState.pinnedConsensusStrategy || null,
            // Inbound body-size gate for this round's lifetime, derived from the
            // max_response_bytes AttestationRound already read to bound its own
            // fetch. Pinning it here is what keeps the gate consistent with the
            // bytes this hub itself proposed; see _bodyB64Limit. Null when the
            // round state carries no cap (legacy/synthetic round states), which
            // leaves the live per-message read in place.
            maxBodyB64Length: Number(roundState.pinnedMaxResponseBytes) > 0
                ? Math.ceil(Number(roundState.pinnedMaxResponseBytes) * 1.4)
                : null,
            finalized:    false,
            timer:        null
        };

        if(myPubkey && myBody && mySig){
            pending.proposals.set(myPubkey, { body: myBody, meta: myMeta, sig: mySig, status: myStatus });
        }

        pending.timer = setTimeout(() => {
            if(!pending.finalized){
                console.warn('AttestationConsensus: round timeout for ' + rid.substring(0,16) + '...');
                // Count before teardown so the metric rail carries the quorum
                // loss even when the warn above is never scraped (item 8c1148c0).
                this.roundTimeoutCount++;
                this.pending.delete(rid);
                this.earlyCommits.delete(rid);
                // Clear the early-message buffer and suppress post-teardown
                // buffering so a retry round cannot replay this attempt's stale
                // PBFT envelopes (item 2640).
                this.earlyMessages.delete(rid);
                this.earlyMessageTtl.delete(rid);
                this._markTornDown(rid);
            }
        }, this.roundTimeoutMs);

        // A fresh round for this rid is opening; allow its envelopes to buffer
        // again after any prior torn-down attempt (item 2640).
        this.tornDown.delete(rid);
        this.pending.set(rid, pending);

        if(this.peerManager){
            this.peerManager.broadcast(ATTEST_PROPOSE, {
                requestId:  rid,
                providerId: pending.providerId,
                body_b64:   myBody ? myBody.toString('base64') : '',
                meta:       String(myMeta || ''),
                status:     myStatus,
                sig_pubkey: myPubkey,
                sig:        mySig
            });
        }

        // Replay messages that arrived before our round was set up. With
        // staggered hub polls, the first proposer's PROPOSE typically lands
        // before peers create their pending entry; without this drain,
        // _handlePropose's `if(!pending) return` loses those votes.
        this._drainEarlyMessages(rid);

        // For single-validator stacks (N=1) we already have everything we need
        this._maybeAdvanceFromProposals(rid).catch(e =>
            console.error('AttestationConsensus: advance error for ' + rid.substring(0,16) + '...: ' + (e && e.message ? e.message : e)));
    }

    _handleMessage(envelope){
        switch(envelope.type){
            case ATTEST_PROPOSE: this._handlePropose(envelope); break;
            case ATTEST_PREPARE: this._handlePrepare(envelope); break;
            case ATTEST_COMMIT:  this._handleCommit(envelope);  break;
        }
    }

    // Maximum allowed base64 length for a peer-supplied body, derived from the
    // provider's configured max_response_bytes (x1.4 base64 expansion factor).
    // The only transport gate on an incoming PROPOSE/PREPARE is the WebSocket
    // frame limit (~1 MB), which is 22-46x larger than any legitimate provider
    // response, so a peer could otherwise force multi-hundred-KB Buffer
    // allocations per message. Falls back to a 64 KB cap when the provider def
    // or its max_response_bytes is unavailable.
    _maxBodyB64Length(providerId){
        let def      = this.providerRegistry.getDef(providerId);
        let maxBytes = (def && Number(def.max_response_bytes)) || 65536;
        return Math.ceil(maxBytes * 1.4);
    }

    // Body cap for THIS round, pinned once at propose() from the same provider
    // def the round fetched under, so the acceptance predicate cannot move
    // between two messages of one round. Reading max_response_bytes live per
    // message let a governance hotReload (which re-parses every def on every
    // proposal:finalized event, whatever the proposal was about) lower the cap
    // mid-round: this hub's own proposal is inserted directly and bypasses the
    // gate, so it would then reject the byte-identical bodies its honest peers
    // sent and stall the round to timeout. Falls back to the live read when the
    // round state carried no cap, which keeps the gate exactly as it was.
    _bodyB64Limit(pending){
        return pending.maxBodyB64Length || this._maxBodyB64Length(pending.providerId);
    }

    _handlePropose(envelope){
        let d = envelope.data;
        if(!d || !d.requestId) return;
        let rid = String(d.requestId).toLowerCase();
        if(this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending){
            // Round not started yet; buffer for drain in propose(). Without
            // this, the first proposer's PROPOSE is lost to peers whose
            // _startRound hasn't run yet, and PBFT can't reach 2f+1.
            this._bufferEarlyMessage(rid, envelope);
            return;
        }

        let senderPubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!senderPubkey) return;

        // Sender must be in the responsible set for this request
        if(!pending.responsible.some(v => v.pubkey === senderPubkey)){
            return;  // Outsider proposal; ignore
        }

        // Reject oversized payloads before allocating a Buffer. A responsible
        // peer could otherwise craft a body_b64 up to the WebSocket frame limit,
        // far larger than the provider's configured response cap.
        if(String(d.body_b64 || '').length > this._bodyB64Limit(pending)){
            console.warn('AttestationConsensus: oversized PROPOSE body from ' + senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected pre-decode)');
            return;
        }
        if(String(d.meta || '').length > ATTEST_META_MAX_LENGTH){
            console.warn('AttestationConsensus: oversized PROPOSE meta from ' + senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected)');
            return;
        }
        // Same cap for `status`, and for the same reason: it is a short outcome
        // tag ('ok', 'provider_error', 'no_quorum'), it is hashed into the
        // canonical below, stored verbatim for the round's lifetime, and
        // concatenated into the A-F4 candidate key, so an uncapped one is
        // adversarial padding on every surface `meta` is capped against.
        if(String(d.status || '').length > ATTEST_META_MAX_LENGTH){
            console.warn('AttestationConsensus: oversized PROPOSE status from ' + senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected)');
            return;
        }

        // Decode body and verify signature against canonical bytes
        let body;
        try {
            body = Buffer.from(String(d.body_b64 || ''), 'base64');
        } catch (_) { return; }
        let meta = String(d.meta || '');
        let canonical = this._buildCanonical(rid, pending.providerId, body, String(d.status || 'ok'), meta, Number(pending.request.block_index));
        if(!ValidatorIdentity.verify(canonical.toString('utf8'), String(d.sig || ''), senderPubkey)){
            console.warn('AttestationConsensus: bad PROPOSE sig from ' + senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '...');
            return;
        }

        // Store (idempotent; dedup by sender pubkey). Status is trusted only
        // because the sig was just verified over a canonical that binds it.
        if(!pending.proposals.has(senderPubkey)){
            pending.proposals.set(senderPubkey, { body: body, meta: meta, sig: String(d.sig), status: String(d.status || 'ok') });
            // A-F1 liveness: a judge_model leader PREPARE that arrived before this
            // follower had collected `need` proposals was buffered (see
            // _handlePrepare) so it could be hash-checked against real proposals
            // instead of adopted on faith. Nothing else replays that buffer before
            // a winner exists, so drain it here the moment the proposal count
            // crosses the check threshold; a still-early replay just re-buffers.
            let need = Math.min(pending.redundancy, pending.responsible.length);
            if(!pending.winner && pending.proposals.size >= need) this._drainEarlyMessages(rid);
        }

        this._maybeAdvanceFromProposals(rid).catch(e =>
            console.error('AttestationConsensus: advance error for ' + rid.substring(0,16) + '...: ' + (e && e.message ? e.message : e)));
    }

    // Once enough proposals are in, run provider.agree() to pick a winner and
    // transition to PREPARE phase. Idempotent by early return, NOT by re-sweeping:
    // once a winner exists this returns at the first statement below, so a PROPOSE
    // arriving afterwards is stored by _handlePropose but never re-verified against
    // the winner canonical and never counted into pending.signatures. The
    // winner-canonical sweep further down runs exactly once, at the moment the winner
    // is established, and _establishNonOkWinner's sweep is guarded the same way.
    //
    // So a late proposer's signature reaches the set ONLY through its own PREPARE or
    // COMMIT, each verified over the winner canonical at its own handler. That is a
    // cross-handler dependency, not an incidental one: it is why liveness holds today
    // (a validator that PROPOSEs also PREPAREs) and why moving where signatures are
    // counted must account for this path. Pinned by
    // "a post-winner PROPOSE contributes no signature; the same peer's PREPARE does"
    // in test/unit/AttestationConsensus.test.js.
    //
    // provider.agree() may be sync (http_get returns the winner immediately)
    // or async (llm runs judge_model via an API call). We always await it via
    // Promise.resolve so both shapes work.
    async _maybeAdvanceFromProposals(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        if(pending.winner) return;  // Already advanced; new proposals handled in PREPARE
        if(pending._agreeing) return;  // judge_model API call in flight; don't fire twice

        // Wait until we have at least REDUNDANCY proposals (or all responsible
        // validators have submitted). Single-validator collapses to immediate.
        // Error proposals count toward arrival: a round where every fetch
        // failed must still advance (to a non-ok outcome), not stall.
        let need = Math.min(pending.redundancy, pending.responsible.length);
        if(pending.proposals.size < need) return;

        // Split ok fetches from error reports. Every responsible validator
        // failing its fetch is the provider-outage signal: publish an explicit
        // status='provider_error' ATTEST v1 (Phase 4) so the outage is an
        // on-chain fact instead of a silent stall. The outcome is
        // deterministic (empty body, empty meta, same status → identical
        // canonical on every hub), so no judge call and no leader gate.
        let okProposals = [...pending.proposals.values()].filter(p => (p.status || 'ok') === 'ok');
        if(okProposals.length === 0){
            this._establishNonOkWinner(rid, 'provider_error');
            return;
        }

        // Run provider's consensus strategy
        let providerModule = this.providerRegistry.getModule(pending.providerId);
        if(!providerModule || typeof providerModule.agree !== 'function'){
            console.warn('AttestationConsensus: provider ' + pending.providerId + ' has no agree(); cannot finalize ' + rid.substring(0,16) + '...');
            return;
        }
        let proposalsArr = okProposals;

        // judge_model is non-deterministic across hubs: each runs its own LLM
        // judge over its own proposal ordering and may select a different winning
        // body. If every hub broadcast its own PREPARE, followers would lock
        // whichever arrived first and the federation could never converge on one
        // canonical body. So for judge_model only the elected leader runs agree()
        // and broadcasts the canonical winner; followers adopt + re-sign it via
        // the leader's PREPARE (see _handlePrepare). If the leader never resolves
        // (offline / failed self-test), the round falls through to deadline
        // expiry rather than finalizing divergent bodies. byte_equality stays
        // deterministic (the agreed body is the common one) so every hub resolves
        // locally as before.
        if(pending.pinnedConsensusStrategy === 'judge_model'
           && pending.leaderPubkey && pending.myPubkey
           && String(pending.leaderPubkey).toLowerCase() !== String(pending.myPubkey).toLowerCase()){
            return;
        }

        pending._agreeing = true;
        let winner;
        // Log-only could-not-judge channel (providers/llm.js _markInconclusive):
        // agree() fills it before every inconclusive null so the warn line below
        // can tell a judge outage / pause / spent budget from a genuine
        // not-equivalent verdict. Never reaches the canonical, PREPARE or status.
        let judgeOutcome = {};
        try {
            // Bound the judge call to the same fetch-timeout budget as a
            // provider fetch, so a slow-drip judge vendor call cannot overrun
            // the round window (see the wall-clock deadline guard in
            // providers/llm.js's transports).
            // positiveIntConfig for the reason the constructor gives: a negative budget
            // makes providers/llm.js's deadlineAt already elapsed, so the judge fallback
            // chain breaks at its first iteration ("judge budget exhausted") and every
            // judge_model round resolves no_quorum.
            let judgeTimeoutMs = positiveIntConfig(this.config.ATTESTATION_FETCH_TIMEOUT, 10000,
                'ATTESTATION_FETCH_TIMEOUT');
            // expectedN pins the majority denominator to the responsible-set size,
            // not the surviving ok-proposal count (item 2642). Without it, failed
            // fetches shrink `proposals.length` and a lone unreplicated body clears
            // ceil((N+1)/2) with N=1, becoming the round winner and suppressing the
            // deterministic no_quorum audit row (byte_equality's independent-fetch
            // premise goes unexercised). byte_equality honours it; judge_model
            // ignores it. `need` is the responsible-set bound computed above.
            winner = await Promise.resolve(providerModule.agree(proposalsArr,
                { pinnedJudgeModel: pending.pinnedJudgeModel || null, pinnedVendors: pending.pinnedVendors || null,
                  pinnedApprovedModels: pending.pinnedApprovedModels || null,
                  timeoutMs: judgeTimeoutMs, expectedN: need, outcome: judgeOutcome }));
        } catch (e) {
            console.warn('AttestationConsensus: agree() threw for %s...:', rid.substring(0,16), e);
            winner = null;
        }
        pending._agreeing = false;

        // Round could have been pruned/finalized while we awaited (rare but possible)
        if(!this.pending.has(rid) || pending.finalized) return;

        if(!winner){
            if(judgeOutcome.inconclusive)
                console.warn('AttestationConsensus: no consensus on ' + rid.substring(0,16) + '... (could not judge: reason=' +
                             judgeOutcome.reason + '; ' + proposalsArr.length + ' proposals)');
            else
                console.warn('AttestationConsensus: no consensus on ' + rid.substring(0,16) + '... (' + proposalsArr.length + ' proposals diverged)');
            // Phase 4: publish an explicit STATUS=no_quorum ATTEST v1 (audit
            // row; the request stays pending on the indexer so later retry
            // rounds can still fulfill it before the deadline).
            this._establishNonOkWinner(rid, 'no_quorum');
            return;
        }

        pending.winner = winner;
        pending.status = 'ok';

        // Walk back through the proposals and collect any sigs that match the winner.
        // Proposals that diverge from the winner are slash candidates for
        // byte_equality providers (e.g. http_get). For judge_model the
        // winner is one of many semantically-equivalent candidates, so
        // non-match doesn't imply wrong.
        let winnerHash = crypto.createHash('sha256').update(winner.body).digest();
        let winnerHashHex = winnerHash.toString('hex');
        let strategy = pending.pinnedConsensusStrategy;
        // The canonical the on-chain verifier reconstructs binds `status` (hardcoded
        // 'ok' for a winner), but a proposal stores only {body, meta, sig} and its sig
        // was verified in _handlePropose over the sender's own wire status. A proposer
        // can match the winner body+meta yet have signed over status='fail', so its sig
        // does NOT verify over the winner canonical. Re-verify here before counting it,
        // mirroring _handlePrepare (614) and _handleCommit; an unverifiable sig inflates
        // signatures.size and the indexer would deterministically reject the response.
        let winnerCanonical = this._buildCanonical(rid, pending.providerId, winner.body, pending.status, winner.meta, Number(pending.request.block_index)).toString('utf8');
        for(let [pubkey, p] of pending.proposals){
            let pHash = crypto.createHash('sha256').update(p.body).digest();
            let matchesWinner = (Buffer.compare(pHash, winnerHash) === 0 && p.meta === winner.meta);
            if(matchesWinner && ValidatorIdentity.verify(winnerCanonical, String(p.sig), pubkey)){
                pending.signatures.set(pubkey, p.sig);
            } else if(matchesWinner){
                console.warn('AttestationConsensus: PROPOSE sig not over winner canonical from ' + String(pubkey).substring(0,16) + '... (not counted)');
            } else if(strategy === 'byte_equality' && (p.status || 'ok') === 'ok' && this.hub.slashDetector){
                // Diverged OK proposal under byte_equality; record as slash
                // candidate. An honest status='provider_error' report is a
                // fetch failure, not a divergence; it must never accrue here.
                // Best-effort; failures don't disrupt the round.
                this.hub.slashDetector.recordAttestationDivergence(
                    pubkey, rid, pending.providerId, pHash.toString('hex'), winnerHashHex
                ).catch(e => console.warn('AttestationConsensus: divergence record failed:', e));
            }
        }

        // judge_model is a SEMANTIC consensus: each responsible validator runs
        // its own model call and produces a byte-divergent body that the judge
        // deems equivalent, then selects ONE as canonical. The match-based sig
        // collection above therefore captures at most the single validator
        // whose body happened to be chosen. Every other responsible validator
        // contributes nothing, so an N>=3 round would finalize with one
        // signature and the on-chain response would be rejected (it requires
        // REDUNDANCY signatures over the single canonical body). Re-sign the
        // canonical winner here so THIS validator vouches for the agreed bytes.
        // Only validators that actually produced a proposal (did the work) sign.
        // "Did the work" means a non-empty ok body, NOT merely having an entry in
        // pending.proposals: a failed own fetch also lands there as an error
        // proposal ({body: empty, status: 'provider_error'}). Without this guard a
        // judge_model leader whose own fetch failed would re-sign a winner body it
        // never fetched or evaluated, and that improper vote is exactly the one
        // that pushes signatures.size to REDUNDANCY, finalizing 'ok' with only
        // REDUNDANCY-1 genuine attestations. Mirrors the follower abstention in
        // _onPrepare (no own non-empty body -> do not co-sign); fails safe (the
        // round times out / retries) rather than open.
        if(strategy === 'judge_model' && pending.myPubkey && pending.proposals.has(pending.myPubkey)){
            let myP = pending.proposals.get(pending.myPubkey);
            let myBodyOk = myP && myP.body && myP.body.length > 0 && (myP.status || 'ok') === 'ok';
            if(myBodyOk){
                let reSig = this._signCanonical(rid, pending.providerId, winner.body, pending.status, winner.meta, Number(pending.request.block_index));
                if(reSig) pending.signatures.set(pending.myPubkey, reSig);
            } else {
                console.warn('AttestationConsensus: leader abstaining from judge_model re-sign for ' + rid +
                    ' (no own non-empty ok body fetched; will not vouch for a winner it never evaluated)');
            }
        }

        // Broadcast PREPARE so other followers can verify and contribute their sigs
        let mySig = pending.signatures.get(pending.myPubkey);
        if(this.peerManager){
            this.peerManager.broadcast(ATTEST_PREPARE, {
                requestId:  rid,
                providerId: pending.providerId,
                body_b64:   winner.body.toString('base64'),
                meta:       String(winner.meta || ''),
                status:     pending.status,
                sig_pubkey: pending.myPubkey,
                sig:        mySig || null
            });
        }
        if(pending.myPubkey) pending.prepares.add(pending.myPubkey);

        this._checkPrepareQuorum(rid);

        // Winner is now set; replay any COMMITs that arrived (and were
        // buffered) before this point so their votes count toward quorum, plus any
        // non-leader judge_model PREPAREs buffered before the leader established it.
        this._drainEarlyCommits(rid);
        this._drainEarlyMessages(rid);
    }

    // Establish a NON-OK round outcome (Phase 4): winner is the canonical
    // empty body + empty meta with an explicit failure status, so every hub
    // that reaches the same conclusion signs byte-identical canonicals and the
    // round converges without a judge call. Statuses:
    //   provider_error - every responsible fetch failed (upstream outage)
    //   no_quorum      - fetches succeeded but agree() returned no winner: either
    //                    a genuine not-equivalent verdict or a could-not-judge
    //                    (judge outage, paused provider, spent budget,
    //                    unparseable verdict); the distinction is log-only
    //                    (judgeOutcome above) since the reason is leader-local
    // The indexer treats both as RETRYABLE: the request stays pending, so a
    // later round (e.g. after the model-fallback ladder advances) can still
    // fulfill it. Throttled to one publication per (request_id, status).
    _establishNonOkWinner(rid, status){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized || pending.winner) return;

        let seen = this.nonOkPublished.get(rid);
        if(seen && seen.has(status)) return;  // already on-chain; retries stay silent

        pending.winner = { body: Buffer.alloc(0), meta: '' };
        pending.status = status;

        // Error PROPOSEs were signed over this exact canonical (empty body,
        // empty meta, same status), so their sigs transfer directly. Anything
        // else (e.g. this hub's own OK proposal ahead of a no_quorum verdict)
        // needs a fresh signature over the non-ok canonical.
        let winnerCanonical = this._buildCanonical(rid, pending.providerId, pending.winner.body, status, pending.winner.meta, Number(pending.request.block_index)).toString('utf8');
        for(let [pubkey, p] of pending.proposals){
            if(ValidatorIdentity.verify(winnerCanonical, String(p.sig), pubkey))
                pending.signatures.set(pubkey, String(p.sig));
        }
        if(pending.myPubkey && pending.proposals.has(pending.myPubkey) && !pending.signatures.has(pending.myPubkey)){
            let reSig = this._signCanonical(rid, pending.providerId, pending.winner.body, status, pending.winner.meta, Number(pending.request.block_index));
            if(reSig) pending.signatures.set(pending.myPubkey, reSig);
        }

        console.warn('AttestationConsensus: non-ok outcome status=' + status + ' for ' + rid.substring(0,16) +
                    '... (' + pending.signatures.size + ' aligned sig(s))');

        let mySig = pending.signatures.get(pending.myPubkey) || null;
        if(this.peerManager){
            this.peerManager.broadcast(ATTEST_PREPARE, {
                requestId:  rid,
                providerId: pending.providerId,
                body_b64:   '',
                meta:       '',
                status:     status,
                sig_pubkey: pending.myPubkey,
                sig:        mySig
            });
        }
        if(pending.myPubkey) pending.prepares.add(pending.myPubkey);

        this._checkPrepareQuorum(rid);
        this._drainEarlyCommits(rid);
        this._drainEarlyMessages(rid);
    }

    // Record that a non-ok status has been published for a request, bounding
    // the map with the same FIFO ring discipline as `finalized` but under the
    // deadline-window-derived `nonOkPublishedMax` cap, NOT
    // `finalizedMax`: non-ok entries stay retry-suppression-relevant until
    // their provider deadline, a far longer horizon than an ok finalization.
    _recordNonOkPublished(rid, status){
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
                    console.warn('AttestationConsensus: evicted non-ok throttle entry for still-pending request ' +
                                oldest.substring(0,16) + '... (ring full at ' + this.nonOkPublishedMax +
                                '; raise ATTESTATION_NONOK_PUBLISHED_MAX; evictions_while_pending=' +
                                this.nonOkEvictedWhilePendingCount + ')');
                }
            }
        }
        set.add(status);
    }

    _handlePrepare(envelope){
        let d = envelope.data;
        if(!d || !d.requestId) return;
        let rid = String(d.requestId).toLowerCase();
        if(this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending){
            this._bufferEarlyMessage(rid, envelope);
            return;
        }

        let senderPubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.responsible.some(v => v.pubkey === senderPubkey)) return;

        // Reject oversized payloads before allocating a Buffer (see _handlePropose).
        if(String(d.body_b64 || '').length > this._bodyB64Limit(pending)){
            console.warn('AttestationConsensus: oversized PREPARE body from ' + senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected pre-decode)');
            return;
        }
        if(String(d.meta || '').length > ATTEST_META_MAX_LENGTH){
            console.warn('AttestationConsensus: oversized PREPARE meta from ' + senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected)');
            return;
        }
        // Status cap, mirroring the PROPOSE guard above.
        if(String(d.status || '').length > ATTEST_META_MAX_LENGTH){
            console.warn('AttestationConsensus: oversized PREPARE status from ' + senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected)');
            return;
        }

        // If we haven't picked a winner yet, this PREPARE tells us what the leader/sender
        // believes is the winning body. Adopt it after sig verification.
        let body;
        try { body = Buffer.from(String(d.body_b64 || ''), 'base64'); }
        catch (_) { return; }
        let meta = String(d.meta || '');
        let status = String(d.status || 'ok');

        if(!pending.winner && status !== 'ok'){
            // NON-OK adoption (Phase 4). A non-ok outcome is DETERMINISTIC
            // (canonical empty body + empty meta + status), so unlike a
            // judge_model ok-winner it may be established by ANY responsible
            // sender, not just the leader: a dead leader must not block an
            // outage from being recorded. Safety comes from the co-sign rules
            // below (a hub only vouches for what it observed), never from
            // trusting the sender.
            if(body.length !== 0 || meta !== ''){
                console.warn('AttestationConsensus: non-ok PREPARE with non-canonical body/meta from ' + senderPubkey.substring(0,16) + '... (rejected)');
                return;
            }
            // Whitelist the adopted status to the exact set a hub can DERIVE
            // (`_establishNonOkWinner` only ever emits these two). `status` is
            // the raw wire value; without this gate a single Byzantine
            // responsible sender could forge any other non-ok status (e.g. the
            // indexer-terminal 'expired'), have honest peers whose own fetch
            // failed co-sign it, and finalize a terminal ATTEST that kills an
            // otherwise-retryable request and triggers a wrongful refund.
            if(status !== 'provider_error' && status !== 'no_quorum'){
                console.warn('AttestationConsensus: non-ok PREPARE with non-derivable status "' + status + '" from ' + senderPubkey.substring(0,16) + '... (rejected)');
                return;
            }
            let seenNonOk = this.nonOkPublished.get(rid);
            if(seenNonOk && seenNonOk.has(status)) return;  // this status already published; don't co-sign a duplicate
            if(!d.sig || !d.sig_pubkey){
                console.warn('AttestationConsensus: unsigned non-ok PREPARE rejected from ' + senderPubkey.substring(0,16) + '...');
                return;
            }
            let canonical = this._buildCanonical(rid, pending.providerId, body, status, meta, Number(pending.request.block_index));
            if(!ValidatorIdentity.verify(canonical.toString('utf8'), String(d.sig), senderPubkey)){
                console.warn('AttestationConsensus: bad non-ok PREPARE sig from ' + senderPubkey.substring(0,16) + '...');
                return;
            }
            // Self-derivation gate (items 2641, 2579). For byte_equality a
            // no_quorum verdict is LOCALLY DERIVABLE: agree() is a deterministic
            // byte tally over collected proposals, so this hub must not adopt or
            // co-sign a no_quorum PREPARE it cannot itself derive. Without this a
            // single Byzantine responsible sender racing a signed no_quorum PREPARE
            // ahead of proposal collection makes every honest hub (each of which
            // always holds its own proposal) co-sign on faith, forcing the round to
            // no_quorum even though all honest bodies are byte-identical - stalling
            // the request to deadline. Buffer until `need` proposals are in hand
            // (the same threshold _maybeAdvanceFromProposals uses), then adopt only
            // if our own agree() over the ok proposals yields no winner. judge_model
            // is deliberately exempt: only the leader runs the judge, so a follower
            // genuinely cannot re-derive the verdict (the seam note below), and its
            // adoption stays participation-gated by the co-sign policy.
            if(status === 'no_quorum' && pending.pinnedConsensusStrategy === 'byte_equality'){
                let needNq = Math.min(pending.redundancy, pending.responsible.length);
                if(pending.proposals.size < needNq){
                    this._bufferEarlyMessage(rid, envelope);
                    return;
                }
                let nonOkModule = this.providerRegistry.getModule(pending.providerId);
                let okForVerdict = [...pending.proposals.values()].filter(p => (p.status || 'ok') === 'ok');
                let derivedWinner = null;
                try {
                    if(nonOkModule && typeof nonOkModule.agree === 'function')
                        derivedWinner = nonOkModule.agree(okForVerdict, { expectedN: needNq });
                } catch (_) { derivedWinner = null; }
                // agree() is dual-shape by contract (see _maybeAdvanceFromProposals):
                // the ok-winner path awaits it, but this is the SYNCHRONOUS PBFT
                // PREPARE handler and cannot. A thenable return is therefore not a
                // derived winner, and reading it as one (every Promise is truthy)
                // would refuse EVERY no_quorum PREPARE for this provider and expire
                // the round at its deadline instead of publishing the audit row. The
                // gate keys on the pinned STRATEGY while the shape rides the MODULE,
                // so governance pointing byte_equality at an async module reaches
                // here. Settle the orphaned promise before dropping it: an unhandled
                // rejection from a provider call nobody awaits takes the hub process
                // down. Fail closed either way - a verdict this hub cannot itself
                // derive is one it must not co-sign (items 2641, 2579).
                if(derivedWinner && typeof derivedWinner.then === 'function'){
                    derivedWinner.then(() => {}, () => {});
                    console.error('AttestationConsensus: byte_equality provider "' + pending.providerId +
                        '" exports an async agree(); no_quorum self-derivation is unavailable on the ' +
                        'synchronous PREPARE path, so ' + rid.substring(0,16) + '... is not co-signed ' +
                        '(config error: strategy/module shape mismatch)');
                    return;
                }
                if(derivedWinner){
                    console.warn('AttestationConsensus: refusing no_quorum PREPARE from ' + senderPubkey.substring(0,16) +
                        '... for ' + rid.substring(0,16) + '... (own agree() derives an ok winner; not co-signing)');
                    return;
                }
                // derivedWinner === null: this hub independently derives no_quorum,
                // so adopting and co-signing below is self-evidenced.
            }
            pending.signatures.set(senderPubkey, String(d.sig));
            pending.winner = { body: body, meta: meta };
            pending.status = status;

            // Co-sign policy: only vouch for a failure mode we can stand
            // behind ourselves.
            //   provider_error - our own fetch must ALSO have failed. A hub
            //                    whose fetch succeeded has direct evidence the
            //                    provider is up and abstains.
            //   no_quorum      - we participated (produced a proposal) but no
            //                    equivalence verdict is checkable by a
            //                    follower (only the leader runs the judge), so
            //                    participation is the strongest local check.
            let myProposal = pending.proposals.get(pending.myPubkey);
            // Require the claimed status to match the failure mode THIS hub
            // itself observed, not merely that our own fetch failed. For
            // provider_error that means our own proposal is provider_error too
            // (a hub that saw a different failure mode must abstain rather than
            // vouch for a status it did not derive).
            let mayCoSign  = !!myProposal && (
                status === 'no_quorum'
                || (status === 'provider_error' && (myProposal.status || 'ok') === 'provider_error')
            );
            if(mayCoSign && !pending.signatures.has(pending.myPubkey)){
                let reSig = ValidatorIdentity.verify(canonical.toString('utf8'), String(myProposal.sig || ''), pending.myPubkey)
                    ? String(myProposal.sig)
                    : this._signCanonical(rid, pending.providerId, body, status, meta, Number(pending.request.block_index));
                if(reSig){
                    pending.signatures.set(pending.myPubkey, reSig);
                    // Echo our endorsing PREPARE exactly once (this !winner
                    // block only runs on first adoption) so prepare-quorum is
                    // reachable; mirrors the judge_model ok-winner echo.
                    if(this.peerManager){
                        this.peerManager.broadcast(ATTEST_PREPARE, {
                            requestId:  rid,
                            providerId: pending.providerId,
                            body_b64:   '',
                            meta:       '',
                            status:     status,
                            sig_pubkey: pending.myPubkey,
                            sig:        reSig
                        });
                        pending.prepares.add(pending.myPubkey);
                    }
                }
            }
        } else if(!pending.winner){
            // judge_model is non-deterministic across hubs: only the ELECTED LEADER
            // runs agree() and its selected body is the canonical winner. So only the
            // leader's PREPARE may establish the winner. A Byzantine responsible
            // non-leader that broadcasts a divergent body FIRST must not have honest
            // followers adopt it. Buffer a non-leader judge_model PREPARE until the
            // leader's winner lands (it then replays through the "winner already
            // established" path below and verifies over the canonical winner) or the
            // round expires. byte_equality is deterministic (independently-fetched
            // identical bodies) and stays first-verified-PREPARE-wins.
            if(pending.pinnedConsensusStrategy === 'judge_model' && pending.leaderPubkey &&
               senderPubkey !== String(pending.leaderPubkey).toLowerCase()){
                this._bufferEarlyMessage(rid, envelope);
                return;
            }
            // First PREPARE we accept establishes the winner. It MUST carry a valid
            // signature from its sender over the proposed body. An unsigned (or badly
            // signed) PREPARE must never set the winner: otherwise a peer that spoofs
            // the sender pubkey can inject an arbitrary body honest followers then
            // co-sign (item 4559). For judge_model the sender is already constrained to
            // the elected leader above; a node that cannot sign cannot lead a round.
            if(!d.sig || !d.sig_pubkey){
                console.warn('AttestationConsensus: unsigned PREPARE rejected from ' + senderPubkey.substring(0,16) + '...');
                return;
            }
            let canonical = this._buildCanonical(rid, pending.providerId, body, status, meta, Number(pending.request.block_index));
            if(!ValidatorIdentity.verify(canonical.toString('utf8'), String(d.sig), senderPubkey)){
                console.warn('AttestationConsensus: bad PREPARE sig from ' + senderPubkey.substring(0,16) + '...');
                return;
            }
            let prepBodyHash = crypto.createHash('sha256').update(body).digest('hex');
            if(pending.pinnedConsensusStrategy === 'judge_model'){
                // A-F1: the leader's signature proves authorship, not honesty. agree()
                // only ever SELECTS one of the collected proposals, so an honest
                // leader's winner must hash-match a proposal this follower collected
                // itself; a Byzantine per-request leader injecting a fabricated body
                // (that no responsible validator proposed) must not be adopted and
                // re-signed on faith. If we haven't collected enough proposals to
                // check yet, buffer the PREPARE (replayed once proposals arrive via
                // _handlePropose) instead of accepting blind.
                let need = Math.min(pending.redundancy, pending.responsible.length);
                if(pending.proposals.size < need){
                    this._bufferEarlyMessage(rid, envelope);
                    return;
                }
                let matchesProposal = false;
                for(let p of pending.proposals.values()){
                    // Only OK proposals can vouch: agree() selects among ok proposals
                    // exclusively (_maybeAdvanceFromProposals filters), and a failed
                    // fetch proposes provider_error with an EMPTY body - without this
                    // filter a Byzantine leader could canonicalize an empty-body
                    // 'ok' winner by hash-matching any peer's error proposal (AF1-R1).
                    if((p.status || 'ok') !== 'ok') continue;
                    if(crypto.createHash('sha256').update(p.body).digest('hex') === prepBodyHash && p.meta === meta){
                        matchesProposal = true;
                        break;
                    }
                }
                if(!matchesProposal){
                    console.warn('AttestationConsensus: leader PREPARE body matches no collected proposal from ' +
                        senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected, A-F1)');
                    return;
                }
            } else {
                // A-F4: byte_equality winner adoption must not latch from a single
                // foreign PREPARE. The strategy's whole safety argument is that every
                // honest validator independently fetched identical bytes, so before
                // adopting we require either (a) our OWN proposal to byte-match the
                // announced winner, or (b) a second responsible signer corroborating
                // the same body+meta+status. A lone Byzantine responsible peer racing
                // its divergent body in first can otherwise wedge this hub's round
                // (honest sigs then "don't verify over winner" and never count).
                let ownMatches = false;
                let myP = pending.proposals.get(pending.myPubkey);
                if(myP && (myP.status || 'ok') === 'ok'){
                    ownMatches = crypto.createHash('sha256').update(myP.body).digest('hex') === prepBodyHash
                        && myP.meta === meta;
                }
                if(!ownMatches){
                    if(!pending.prepareCandidates) pending.prepareCandidates = new Map();
                    let key = prepBodyHash + '|' + meta + '|' + status;
                    // One live candidate per sender (AF4-R1): a re-announce replaces the
                    // sender's previous body rather than accumulating. Without this a
                    // Byzantine responsible peer streaming distinct self-signed bodies
                    // grows the map without bound for the round's lifetime; honest
                    // validators only ever announce one body per round anyway.
                    for(let [k, m] of pending.prepareCandidates){
                        if(k !== key && m.delete(senderPubkey) && m.size === 0) pending.prepareCandidates.delete(k);
                    }
                    let cand = pending.prepareCandidates.get(key);
                    if(!cand){ cand = new Map(); pending.prepareCandidates.set(key, cand); }
                    cand.set(senderPubkey, String(d.sig));
                    // Bounded: senders are membership-checked responsible validators,
                    // each holding at most one live candidate entry, so entries <=
                    // responsible.length.
                    if(cand.size < 2){
                        pending.prepares.add(senderPubkey);
                        return;   // hold: not corroborated yet, and our own body disagrees/is absent
                    }
                    // Corroborated by two distinct responsible signers: adopt, and
                    // carry both already-verified sigs into the winner's sig set.
                    for(let [pk, sg] of cand) pending.signatures.set(pk, sg);
                }
            }
            pending.signatures.set(senderPubkey, String(d.sig));
            pending.winner = { body: body, meta: meta };
            pending.status = status;
            // Sign our own copy if we agreed (we might have proposed the same body)
            let myProposal = pending.proposals.get(pending.myPubkey);
            if(myProposal){
                let strategy    = pending.pinnedConsensusStrategy;
                if(strategy === 'judge_model'){
                    // Liveness guard (item 5314): a follower re-signs the leader's
                    // chosen body only after verifying the leader's Ed25519 sig, so it
                    // never re-judges (LLM non-determinism makes that infeasible; the
                    // AttestationSpotChecker audits divergence instead). At minimum it
                    // must have independently fetched a NON-EMPTY body of its own for
                    // this request. If its own fetch failed it abstains rather than
                    // vouching for bytes it never evaluated; the round still reaches
                    // quorum via other validators or correctly times out.
                    let ownBody = myProposal.body;
                    if(!ownBody || ownBody.length === 0){
                        console.warn('AttestationConsensus: abstaining from judge_model PREPARE for ' + rid + ' (no own non-empty body fetched; will not co-sign leader winner)');
                        return;
                    }
                    // Semantic consensus: our own body is byte-divergent from the
                    // judge-selected winner even though both are valid. Re-sign
                    // the canonical winner so our vote carries a verifying
                    // signature over the agreed bytes (see _maybeAdvanceFromProposals).
                    let reSig = this._signCanonical(rid, pending.providerId, body, status, meta, Number(pending.request.block_index));
                    if(reSig) pending.signatures.set(pending.myPubkey, reSig);
                    // judge_model elects ONE leader to run agree() + PREPARE; followers
                    // only adopt that winner here and never run agree(), so without
                    // echoing our own endorsing PREPARE no node ever sees more than the
                    // leader's single PREPARE and prepare-quorum (max(quorum, REDUNDANCY))
                    // is never reached, deadlocking the round despite the leader holding
                    // enough matching-proposal sigs. Re-broadcast our PREPARE over the
                    // adopted canonical winner exactly once (this !winner block runs only
                    // on first adoption). byte_equality is unaffected: there every
                    // validator runs its own agree() and broadcasts its own PREPARE.
                    if(reSig && this.peerManager){
                        this.peerManager.broadcast(ATTEST_PREPARE, {
                            requestId:  rid,
                            providerId: pending.providerId,
                            body_b64:   pending.winner.body.toString('base64'),
                            meta:       String(pending.winner.meta || ''),
                            status:     pending.status,
                            sig_pubkey: pending.myPubkey,
                            sig:        reSig
                        });
                        pending.prepares.add(pending.myPubkey);
                    }
                } else {
                    // byte_equality: only sign if our independently-fetched body
                    // is byte-identical to the winner. A divergence is a genuine
                    // disagreement and must NOT be papered over with a signature.
                    let winnerHash = crypto.createHash('sha256').update(body).digest();
                    let myHash     = crypto.createHash('sha256').update(myProposal.body).digest();
                    if(Buffer.compare(winnerHash, myHash) === 0 && myProposal.meta === meta){
                        // Our PROPOSE sig transfers only if it verifies over the winner
                        // canonical (it binds status: a matching body signed over a
                        // non-ok status does not verify; see _maybeAdvanceFromProposals);
                        // otherwise re-sign the winner canonical.
                        let mySig = ValidatorIdentity.verify(canonical.toString('utf8'), String(myProposal.sig || ''), pending.myPubkey)
                            ? String(myProposal.sig)
                            : this._signCanonical(rid, pending.providerId, body, status, meta, Number(pending.request.block_index));
                        if(mySig) pending.signatures.set(pending.myPubkey, mySig);
                        // Prepare-quorum liveness (mirrors the judge_model echo above):
                        // we adopted the winner from a peer's PREPARE BEFORE running our
                        // own agree() (gossip reordering: missed a PROPOSE, got the
                        // derived PREPARE), and the winner-set early-return in
                        // _maybeAdvanceFromProposals means we will never broadcast our
                        // own PREPARE by any other route. Without this echo every
                        // responsible node tops out one prepare short of
                        // max(quorum, REDUNDANCY), no COMMIT is ever sent, and the round
                        // expires despite enough matching signatures. Echo exactly once
                        // (this !winner block runs only on first adoption) and self-add
                        // to prepares; a non-matching body still abstains entirely.
                        if(mySig && this.peerManager){
                            this.peerManager.broadcast(ATTEST_PREPARE, {
                                requestId:  rid,
                                providerId: pending.providerId,
                                body_b64:   pending.winner.body.toString('base64'),
                                meta:       String(pending.winner.meta || ''),
                                status:     pending.status,
                                sig_pubkey: pending.myPubkey,
                                sig:        mySig
                            });
                            pending.prepares.add(pending.myPubkey);
                        }
                    }
                }
            }
        } else if(d.sig && d.sig_pubkey){
            // Winner already established: a later PREPARE's signature must verify
            // over the CANONICAL WINNER body/status/meta (mirror _handleCommit),
            // NOT over the sender's own (possibly divergent) body. Storing a sig
            // over a divergent body would inflate signatures.size, which is the gate
            // _checkCommitQuorum finalizes on, so the emitted on-chain response
            // could carry signatures that don't all verify over the winner (and
            // be deterministically rejected by the indexer).
            let canonical = this._buildCanonical(rid, pending.providerId, pending.winner.body, pending.status, pending.winner.meta, Number(pending.request.block_index));
            if(ValidatorIdentity.verify(canonical.toString('utf8'), String(d.sig), senderPubkey)){
                pending.signatures.set(senderPubkey, String(d.sig));
            } else {
                console.warn('AttestationConsensus: PREPARE sig not over winner body from ' + senderPubkey.substring(0,16) + '... (not counted)');
            }
        }

        pending.prepares.add(senderPubkey);
        this._checkPrepareQuorum(rid);

        // A PREPARE can be the first thing to establish our winner (when we
        // adopt the leader's body above). Replay any COMMITs buffered before
        // then so their votes aren't lost, and any non-leader judge_model
        // PREPAREs buffered pre-winner, which now verify over the canonical winner.
        if(pending.winner){
            this._drainEarlyCommits(rid);
            this._drainEarlyMessages(rid);
            // A late PREPARE can carry the signature that crosses the commit
            // quorum AFTER this node already broadcast its COMMIT. In that state
            // _checkPrepareQuorum short-circuits on `_commitSent`, so the only
            // finalization gate (_checkCommitQuorum) would otherwise never be
            // re-run and a fully-quorate round would stall until round timeout
            // (e.g. the peer's COMMIT was lost on best-effort gossip). Re-check,
            // but ONLY once we have committed: before that, prepare quorum is the
            // required gate, and signatures.size can already equal `needed` from
            // the agree phase, so an unconditional call would finalize before
            // prepare quorum is reached. Post-commit the call is idempotent
            // (gated on signatures.size >= needed and the finalized flag).
            if(pending._commitSent) this._checkCommitQuorum(rid);
        }
    }

    _checkPrepareQuorum(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized || !pending.winner) return;
        if(pending._commitSent) return;

        let quorum = pending.quorum;
        // `pending.quorum` is the PBFT quorum computed INLINE in propose() over
        // responsible.length (the redundancy-sized responsible set), NOT
        // CapabilitySnapshot.getQuorum() (which is scoped to the full snapshot
        // count and is deliberately not the source here). For very small
        // federations (e.g. responsible.length <= 1) that inline value is 0;
        // collapse to REDUNDANCY in that case. Given the quorum <= redundancy
        // invariant documented in propose(), this max() always resolves to
        // redundancy: the effective gate is redundancy-of-redundancy.
        let needed = Math.max(quorum, pending.redundancy);

        if(pending.prepares.size >= needed){
            pending._commitSent = true;
            if(pending.myPubkey) pending.commits.add(pending.myPubkey);

            let mySig = pending.signatures.get(pending.myPubkey) || null;
            if(this.peerManager){
                this.peerManager.broadcast(ATTEST_COMMIT, {
                    requestId:  rid,
                    providerId: pending.providerId,
                    body_b64:   pending.winner.body.toString('base64'),
                    meta:       String(pending.winner.meta || ''),
                    status:     pending.status,
                    sig_pubkey: pending.myPubkey,
                    sig:        mySig
                });
            }
            this._checkCommitQuorum(rid);
        }
    }

    _handleCommit(envelope){
        let d = envelope.data;
        if(!d || !d.requestId) return;
        let rid = String(d.requestId).toLowerCase();
        if(this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending){
            this._bufferEarlyMessage(rid, envelope);
            return;
        }
        if(!pending.winner){
            // Winner not yet established (the PROPOSE->agree() transition is
            // async). Hold this COMMIT and replay it once the winner is set,
            // rather than dropping the peer's vote. See _drainEarlyCommits.
            // Membership gate (A-F5 parity): pending.responsible is populated at
            // round start, before the winner, so apply the same responsible-set
            // check used post-winner (below) here too. This refuses to buffer
            // COMMITs from non-responsible peers, closing an unauthenticated
            // memory-amplification vector; buffered members are still re-checked
            // for a valid signature on replay.
            let earlySender = String(d.sig_pubkey || '').toLowerCase();
            if(!pending.responsible.some(v => v.pubkey === earlySender)) return;
            this._bufferEarlyCommit(rid, envelope);
            return;
        }

        let senderPubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.responsible.some(v => v.pubkey === senderPubkey)) return;

        if(d.sig && d.sig_pubkey){
            let canonical = this._buildCanonical(rid, pending.providerId, pending.winner.body, pending.status, pending.winner.meta, Number(pending.request.block_index));
            if(ValidatorIdentity.verify(canonical.toString('utf8'), String(d.sig), senderPubkey)){
                pending.signatures.set(senderPubkey, String(d.sig));
            }
        }
        pending.commits.add(senderPubkey);
        this._checkCommitQuorum(rid);
    }

    _checkCommitQuorum(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        // As in _checkPrepareQuorum: quorum <= redundancy by construction (see
        // propose()), so this max() always resolves to redundancy.
        let needed = Math.max(pending.quorum, pending.redundancy);
        // Gate on the number of VALID signatures over the canonical body, not on
        // raw participation (commits.size). A COMMIT vote is counted even when it
        // carries no verifying signature (null sig, or a sig over a divergent
        // body), so finalizing on commits.size would emit an on-chain response
        // with fewer signatures than REDUNDANCY, which the indexer
        // deterministically rejects. Requiring `needed` signatures guarantees the
        // emitted response is on-chain-fulfillable; rounds that can't reach it
        // (genuine divergence under byte_equality) correctly fall through to
        // deadline expiry instead of dead-lettering a doomed payload every cycle.
        if(pending.signatures.size < needed) return;

        pending.finalized = true;
        if(pending.status === 'ok'){
            // Terminal on the hub: the indexer flips the request to fulfilled.
            this._markFinalized(rid);
        } else {
            // Non-ok statuses are RETRYABLE on the indexer (the request stays
            // pending), so the rid must NOT enter `finalized` or no retry round
            // could ever start. Record the publication instead so retries stop
            // re-publishing the same failure (once per request_id + status).
            this._recordNonOkPublished(rid, pending.status);
            // This teardown path does not enter `this.finalized`, so clear the
            // early-message buffer and suppress post-teardown buffering to stop a
            // retry round replaying this attempt's stale PBFT votes (item 2640).
            this.earlyMessages.delete(rid);
            this.earlyMessageTtl.delete(rid);
            this._markTornDown(rid);
        }
        if(pending.timer) clearTimeout(pending.timer);

        // We need at least max(REDUNDANCY, quorum) sigs on the on-chain response.
        let sigsArray = [];
        for(let [pk, sg] of pending.signatures){
            sigsArray.push({ pubkey: pk, sig: sg });
        }

        console.log('AttestationConsensus: finalized ' + rid.substring(0,16) + '... (' +
                    pending.prepares.size + ' prepares, ' + pending.commits.size + ' commits, ' +
                    sigsArray.length + ' sigs)');

        // Emit for AttestationPublisher to broadcast on-chain. Only the leader
        // actually broadcasts the response tx; followers' publishers are no-ops
        // for this request (publisher checks role).
        this.emit('request:finalized', {
            requestId:    rid,
            request:      pending.request,
            providerId:   pending.providerId,
            responseBody: pending.winner.body,
            meta:         pending.winner.meta,
            status:       pending.status,
            signatures:   sigsArray,
            leaderPubkey: pending.leaderPubkey,
            role:         pending.role
        });

        this.earlyCommits.delete(rid);
        let evictTimer = setTimeout(() => this.pending.delete(rid), PENDING_EVICT_MS);
        if (evictTimer.unref) evictTimer.unref();  // housekeeping timer; never pin process liveness
    }

    // Record a finalized request ID, evicting the oldest once the ring-buffer
    // cap (`finalizedMax`) is reached. Keeps `finalized` bounded while
    // preserving Set semantics for the duplicate-finalization guards.
    _markFinalized(rid){
        if(this.finalized.has(rid)) return;
        this.finalized.add(rid);
        this._finalizedOrder.push(rid);
        if(this._finalizedOrder.length > this.finalizedMax){
            let oldest = this._finalizedOrder.shift();
            this.finalized.delete(oldest);
            this._rememberEvictedFinalized(oldest);
        }
    }

    // Tombstone an evicted ok rid so propose() can later prove the eviction was
    // premature. Ring-bounded FIFO like every other set here, so the detector
    // cannot itself become the unbounded growth `finalized` was capped to avoid.
    _rememberEvictedFinalized(rid){
        if(this._finalizedEvicted.has(rid)) return;
        this._finalizedEvicted.add(rid);
        this._finalizedEvictedOrder.push(rid);
        if(this._finalizedEvictedOrder.length > this.finalizedMax)
            this._finalizedEvicted.delete(this._finalizedEvictedOrder.shift());
    }

    // Build the indexer-canonical signing message (returned as UTF-8 Buffer):
    //   request_id || provider_id || sha256(response_payload) || status || meta
    // At/above the EQUIV flag-day (WI-2 bump 2) the raw STRING is wrapped in the uniform
    // header (TAG=XATTEST, ROUND_ID=request_id, VIEW=0; attestation has no view change)
    // before the Buffer conversion. The gate keys on the REQUEST's block (deterministic
    // from request_id; the indexer derives the same via request.block_index) + the hub's
    // network, so the hub and the on-chain verifier flip identically. `requestBlock`
    // undefined (no request in scope) -> gate OFF -> bare bytes (safe).
    _buildCanonical(requestId, providerId, body, status, meta, requestBlock){
        let responseHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
        let raw = String(requestId) + String(providerId) + responseHash + String(status) + String(meta || '');
        if(eq.isEquivHeaderActive(requestBlock, this.hub && this.hub.network))
            raw = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, requestId, 0, raw);
        return Buffer.from(raw, 'utf8');
    }

    // Sign the canonical bytes with this validator's identity. Returns
    // 128-hex-char sig or null when no identity is available.
    _signCanonical(requestId, providerId, body, status, meta, requestBlock){
        if(!this.identity) return null;
        try {
            let canonical = this._buildCanonical(requestId, providerId, body, status, meta, requestBlock);
            return this.identity.sign(canonical.toString('utf8'));
        } catch (e) {
            console.warn('AttestationConsensus: sign failed:', e);
            return null;
        }
    }
}

module.exports = AttestationConsensus;
module.exports.ATTEST_PROPOSE = ATTEST_PROPOSE;
module.exports.ATTEST_PREPARE = ATTEST_PREPARE;
module.exports.ATTEST_COMMIT  = ATTEST_COMMIT;
