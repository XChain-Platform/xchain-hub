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
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md
 *
 ********************************************************************/

const crypto            = require('crypto');
const EventEmitter      = require('events');
const ValidatorIdentity = require('./ValidatorIdentity.js');
const eq                = require('./equivocation_header.js');

const ATTEST_PROPOSE = 'ATTEST_PROPOSE';
const ATTEST_PREPARE = 'ATTEST_PREPARE';
const ATTEST_COMMIT  = 'ATTEST_COMMIT';

const DEFAULT_ROUND_TIMEOUT_MS = 120000;  // 2 minutes per request lifecycle
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
        this.finalizedMax    = parseInt(this.config.ATTESTATION_FINALIZED_MAX) || 10000;

        // Non-ok publication throttle (Phase 4). A non-ok finalization leaves
        // the request PENDING on the indexer (retryable), so without a throttle
        // every subsequent failed retry round would quorum-sign and broadcast
        // the same provider_error/no_quorum response again, burning a BTC tx
        // per poll cycle for no new information. One publication per
        // (request_id, status) is the audit trail; the deadline-expiry path
        // remains the terminal backstop. Ring-bounded like `finalized`.
        // Map<rid, Set<status>>
        this.nonOkPublished       = new Map();
        this._nonOkPublishedOrder = [];

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

        this._messageHandler = null;
        this.roundTimeoutMs  = parseInt(this.config.ATTESTATION_ROUND_TIMEOUT_MS) || DEFAULT_ROUND_TIMEOUT_MS;
    }

    async start(){
        if(!this.peerManager){
            console.log('AttestationConsensus: no peer manager; skipping start');
            return;
        }
        this._messageHandler = (env) => this._handleMessage(env);
        this.peerManager.on('message', this._messageHandler);
        console.log('AttestationConsensus: started');
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
        let now = Date.now();
        this._pruneEarlyMessages(now);
        let arr = this.earlyMessages.get(rid);
        if(!arr){
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
        let quorum      = responsible.length <= 1
            ? 0
            : Math.max(2 * Math.floor((responsible.length - 1) / 3) + 1,
                       Math.ceil((responsible.length + 1) / 2));

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
            finalized:    false,
            timer:        null
        };

        if(myPubkey && myBody && mySig){
            pending.proposals.set(myPubkey, { body: myBody, meta: myMeta, sig: mySig, status: myStatus });
        }

        pending.timer = setTimeout(() => {
            if(!pending.finalized){
                console.warn('AttestationConsensus: round timeout for ' + rid.substring(0,16) + '...');
                this.pending.delete(rid);
                this.earlyCommits.delete(rid);
            }
        }, this.roundTimeoutMs);

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
        if(String(d.body_b64 || '').length > this._maxBodyB64Length(pending.providerId)){
            console.warn('AttestationConsensus: oversized PROPOSE body from ' + senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected pre-decode)');
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
        }

        this._maybeAdvanceFromProposals(rid).catch(e =>
            console.error('AttestationConsensus: advance error for ' + rid.substring(0,16) + '...: ' + (e && e.message ? e.message : e)));
    }

    // Once enough proposals are in, run provider.agree() to pick a winner and
    // transition to PREPARE phase. Idempotent: extra proposals after a winner
    // is picked are validated against the winner and their sigs collected.
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
        let agreeDef = this.providerRegistry.getDef(pending.providerId);
        if(agreeDef && agreeDef.consensus_strategy === 'judge_model'
           && pending.leaderPubkey && pending.myPubkey
           && String(pending.leaderPubkey).toLowerCase() !== String(pending.myPubkey).toLowerCase()){
            return;
        }

        pending._agreeing = true;
        let winner;
        try {
            winner = await Promise.resolve(providerModule.agree(proposalsArr, { pinnedJudgeModel: pending.pinnedJudgeModel || null }));
        } catch (e) {
            console.warn('AttestationConsensus: agree() threw for ' + rid.substring(0,16) + '...: ', e);
            winner = null;
        }
        pending._agreeing = false;

        // Round could have been pruned/finalized while we awaited (rare but possible)
        if(!this.pending.has(rid) || pending.finalized) return;

        if(!winner){
            console.log('AttestationConsensus: no consensus on ' + rid.substring(0,16) + '... (' + proposalsArr.length + ' proposals diverged)');
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
        let providerDef = this.providerRegistry.getDef(pending.providerId);
        let strategy = providerDef && providerDef.consensus_strategy;
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
        if(strategy === 'judge_model' && pending.myPubkey && pending.proposals.has(pending.myPubkey)){
            let reSig = this._signCanonical(rid, pending.providerId, winner.body, pending.status, winner.meta, Number(pending.request.block_index));
            if(reSig) pending.signatures.set(pending.myPubkey, reSig);
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
    //   no_quorum      - fetches succeeded but agree() found no equivalence
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

        console.log('AttestationConsensus: non-ok outcome status=' + status + ' for ' + rid.substring(0,16) +
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
    // the map with the same FIFO ring discipline as `finalized`.
    _recordNonOkPublished(rid, status){
        let set = this.nonOkPublished.get(rid);
        if(!set){
            set = new Set();
            this.nonOkPublished.set(rid, set);
            this._nonOkPublishedOrder.push(rid);
            if(this._nonOkPublishedOrder.length > this.finalizedMax){
                let oldest = this._nonOkPublishedOrder.shift();
                this.nonOkPublished.delete(oldest);
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
        if(String(d.body_b64 || '').length > this._maxBodyB64Length(pending.providerId)){
            console.warn('AttestationConsensus: oversized PREPARE body from ' + senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '... (rejected pre-decode)');
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
            let mayCoSign  = !!myProposal && (status === 'no_quorum' || (myProposal.status || 'ok') !== 'ok');
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
            let providerDef = this.providerRegistry.getDef(pending.providerId);
            if(providerDef && providerDef.consensus_strategy === 'judge_model' && pending.leaderPubkey &&
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
            pending.signatures.set(senderPubkey, String(d.sig));
            pending.winner = { body: body, meta: meta };
            pending.status = status;
            // Sign our own copy if we agreed (we might have proposed the same body)
            let myProposal = pending.proposals.get(pending.myPubkey);
            if(myProposal){
                let providerDef = this.providerRegistry.getDef(pending.providerId);
                let strategy    = providerDef && providerDef.consensus_strategy;
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
        }
    }

    _checkPrepareQuorum(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized || !pending.winner) return;
        if(pending._commitSent) return;

        let quorum = pending.quorum;
        // For very small federations (e.g. N=1) quorum can be 0 from
        // getQuorum; collapse to REDUNDANCY in that case. Given the
        // quorum <= redundancy invariant (see propose()), this max() always
        // resolves to redundancy: the effective gate is redundancy-of-redundancy.
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
        }
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
