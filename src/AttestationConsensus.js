/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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
 *        provider.agree(proposals) → winner. Sign canonical bytes for the
 *        winner. Broadcast ATTEST_PREPARE.
 *   ATTEST_PREPARE handler
 *     -> collect prepares; on PBFT quorum (2f+1 over capability snapshot N),
 *        broadcast ATTEST_COMMIT.
 *   ATTEST_COMMIT handler
 *     -> collect commits; on quorum, emit 'request:finalized' for the
 *        publisher to ship the on-chain ATTESTATION_RESPONSE.
 *
 * Validator-set snapshot is locked at the request's block_index via
 * CapabilitySnapshot — every hub computes the same quorum N for the round.
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md
 *
 ********************************************************************/

const crypto            = require('crypto');
const EventEmitter      = require('events');
const ValidatorIdentity = require('./ValidatorIdentity.js');

const ATTEST_PROPOSE = 'ATTEST_PROPOSE';
const ATTEST_PREPARE = 'ATTEST_PREPARE';
const ATTEST_COMMIT  = 'ATTEST_COMMIT';

const DEFAULT_ROUND_TIMEOUT_MS = 120000;  // 2 minutes per request lifecycle

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

        // Already-finalized requests (prevents double-publish on re-receipt)
        this.finalized = new Set();

        // Early-arrival buffer. With staggered hub polls, the first proposer's
        // PROPOSE often reaches peers before they start their own round —
        // _handlePropose silently returns at `if(!pending)`, losing the vote.
        // Buffer envelopes here keyed by rid and drain in propose() once
        // pending exists. Bounded TTL prevents leaks if pending never starts.
        // Map<rid, Array<envelope>>
        this.earlyMessages = new Map();
        // Map<rid, expiresAtMs>
        this.earlyMessageTtl = new Map();
        this.earlyMessageTtlMs = 60 * 1000;
        this.earlyMessageMaxPerRid = 32;

        this._messageHandler = null;
        this.roundTimeoutMs  = parseInt(this.config.ATTESTATION_ROUND_TIMEOUT_MS) || DEFAULT_ROUND_TIMEOUT_MS;
    }

    async start(){
        if(!this.peerManager){
            console.log('AttestationConsensus: no peer manager — skipping start');
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
        this.earlyMessages.delete(rid);
        this.earlyMessageTtl.delete(rid);
        for(let env of arr){
            this._handleMessage(env);
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
        let quorum   = this.hub.capabilitySnapshot
            ? this.hub.capabilitySnapshot.getQuorum(snapshot)
            : (snapshot && snapshot.validators ? snapshot.validators.length : 0);

        let myPubkey  = this.identity ? this.identity.getPubkeyHex().toLowerCase() : null;
        let myBody    = roundState.myProposal.body;
        let myMeta    = roundState.myProposal.meta;
        let mySig     = this._signCanonical(rid, roundState.providerId, myBody, 'ok', myMeta);

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
            // Set <pubkey>  — PREPARE/COMMIT votes (track by pubkey, not addr,
            // because attestation responsibility is pubkey-scoped)
            prepares:     new Set(),
            commits:      new Set(),
            // Map<pubkey, sig over canonical(winning body)>
            signatures:   new Map(),
            // Set once provider.agree() picks a winner from accumulated proposals
            winner:       null,
            status:       'ok',
            finalized:    false,
            timer:        null
        };

        if(myPubkey && myBody && mySig){
            pending.proposals.set(myPubkey, { body: myBody, meta: myMeta, sig: mySig });
        }

        pending.timer = setTimeout(() => {
            if(!pending.finalized){
                console.warn('AttestationConsensus: round timeout for ' + rid.substring(0,16) + '...');
                this.pending.delete(rid);
            }
        }, this.roundTimeoutMs);

        this.pending.set(rid, pending);

        // Broadcast our PROPOSE
        if(this.peerManager){
            this.peerManager.broadcast(ATTEST_PROPOSE, {
                requestId:  rid,
                providerId: pending.providerId,
                body_b64:   myBody ? myBody.toString('base64') : '',
                meta:       String(myMeta || ''),
                status:     'ok',
                sig_pubkey: myPubkey,
                sig:        mySig
            });
        }

        // Replay messages that arrived before our round was set up. With
        // staggered hub polls, the first proposer's PROPOSE typically lands
        // before peers create their pending entry — without this drain,
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

    _handlePropose(envelope){
        let d = envelope.data;
        if(!d || !d.requestId) return;
        let rid = String(d.requestId).toLowerCase();
        if(this.finalized.has(rid)) return;
        let pending = this.pending.get(rid);
        if(!pending){
            // Round not started yet — buffer for drain in propose(). Without
            // this, the first proposer's PROPOSE is lost to peers whose
            // _startRound hasn't run yet, and PBFT can't reach 2f+1.
            this._bufferEarlyMessage(rid, envelope);
            return;
        }

        let senderPubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!senderPubkey) return;

        // Sender must be in the responsible set for this request
        if(!pending.responsible.some(v => v.pubkey === senderPubkey)){
            return;  // Outsider proposal — ignore
        }

        // Decode body and verify signature against canonical bytes
        let body;
        try {
            body = Buffer.from(String(d.body_b64 || ''), 'base64');
        } catch (_) { return; }
        let meta = String(d.meta || '');
        let canonical = this._buildCanonical(rid, pending.providerId, body, String(d.status || 'ok'), meta);
        if(!ValidatorIdentity.verify(canonical.toString('utf8'), String(d.sig || ''), senderPubkey)){
            console.warn('AttestationConsensus: bad PROPOSE sig from ' + senderPubkey.substring(0,16) + '... for ' + rid.substring(0,16) + '...');
            return;
        }

        // Store (idempotent — dedup by sender pubkey)
        if(!pending.proposals.has(senderPubkey)){
            pending.proposals.set(senderPubkey, { body: body, meta: meta, sig: String(d.sig) });
        }

        this._maybeAdvanceFromProposals(rid).catch(e =>
            console.error('AttestationConsensus: advance error for ' + rid.substring(0,16) + '...: ' + (e && e.message ? e.message : e)));
    }

    // Once enough proposals are in, run provider.agree() to pick a winner and
    // transition to PREPARE phase. Idempotent — extra proposals after a winner
    // is picked are validated against the winner and their sigs collected.
    //
    // provider.agree() may be sync (http_get returns the winner immediately)
    // or async (llm runs judge_model via an API call). We always await it via
    // Promise.resolve so both shapes work.
    async _maybeAdvanceFromProposals(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized) return;
        if(pending.winner) return;  // Already advanced; new proposals handled in PREPARE
        if(pending._agreeing) return;  // judge_model API call in flight — don't fire twice

        // Wait until we have at least REDUNDANCY proposals (or all responsible
        // validators have submitted). Single-validator collapses to immediate.
        let need = Math.min(pending.redundancy, pending.responsible.length);
        if(pending.proposals.size < need) return;

        // Run provider's consensus strategy
        let providerModule = this.providerRegistry.getModule(pending.providerId);
        if(!providerModule || typeof providerModule.agree !== 'function'){
            console.warn('AttestationConsensus: provider ' + pending.providerId + ' has no agree() — cannot finalize ' + rid.substring(0,16) + '...');
            return;
        }
        let proposalsArr = [...pending.proposals.values()];
        pending._agreeing = true;
        let winner;
        try {
            winner = await Promise.resolve(providerModule.agree(proposalsArr));
        } catch (e) {
            console.warn('AttestationConsensus: agree() threw for ' + rid.substring(0,16) + '...: ' + (e && e.message ? e.message : e));
            winner = null;
        }
        pending._agreeing = false;

        // Round could have been pruned/finalized while we awaited (rare but possible)
        if(!this.pending.has(rid) || pending.finalized) return;

        if(!winner){
            console.log('AttestationConsensus: no consensus on ' + rid.substring(0,16) + '... (' + proposalsArr.length + ' proposals diverged)');
            // STATUS=no_quorum response is published in Phase 4. For now, let
            // the deadline-expiry handler on the indexer flip status to expired.
            return;
        }

        pending.winner = winner;
        pending.status = 'ok';

        // Walk back through the proposals and collect any sigs that match the winner.
        // Proposals that diverge from the winner are slash candidates for
        // byte_equality providers (e.g. http_get) — for judge_model the
        // winner is one of many semantically-equivalent candidates, so
        // non-match doesn't imply wrong.
        let winnerHash = crypto.createHash('sha256').update(winner.body).digest();
        let winnerHashHex = winnerHash.toString('hex');
        let providerDef = this.providerRegistry.getDef(pending.providerId);
        let strategy = providerDef && providerDef.consensus_strategy;
        for(let [pubkey, p] of pending.proposals){
            let pHash = crypto.createHash('sha256').update(p.body).digest();
            let matchesWinner = (Buffer.compare(pHash, winnerHash) === 0 && p.meta === winner.meta);
            if(matchesWinner){
                pending.signatures.set(pubkey, p.sig);
            } else if(strategy === 'byte_equality' && this.hub.slashDetector){
                // Diverged proposal under byte_equality — record as slash candidate.
                // Best-effort; failures don't disrupt the round.
                this.hub.slashDetector.recordAttestationDivergence(
                    pubkey, rid, pending.providerId, pHash.toString('hex'), winnerHashHex
                ).catch(e => console.warn('AttestationConsensus: divergence record failed: ' + (e && e.message ? e.message : e)));
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

        // If we haven't picked a winner yet, this PREPARE tells us what the leader/sender
        // believes is the winning body. Adopt it after sig verification.
        let body;
        try { body = Buffer.from(String(d.body_b64 || ''), 'base64'); }
        catch (_) { return; }
        let meta = String(d.meta || '');
        let status = String(d.status || 'ok');

        if(d.sig && d.sig_pubkey){
            let canonical = this._buildCanonical(rid, pending.providerId, body, status, meta);
            if(!ValidatorIdentity.verify(canonical.toString('utf8'), String(d.sig), senderPubkey)){
                console.warn('AttestationConsensus: bad PREPARE sig from ' + senderPubkey.substring(0,16) + '...');
                return;
            }
            pending.signatures.set(senderPubkey, String(d.sig));
        }

        if(!pending.winner){
            pending.winner = { body: body, meta: meta };
            pending.status = status;
            // Sign our own copy if we agreed (we might have proposed the same body)
            let myProposal = pending.proposals.get(pending.myPubkey);
            if(myProposal){
                let winnerHash = crypto.createHash('sha256').update(body).digest();
                let myHash     = crypto.createHash('sha256').update(myProposal.body).digest();
                if(Buffer.compare(winnerHash, myHash) === 0 && myProposal.meta === meta){
                    pending.signatures.set(pending.myPubkey, myProposal.sig);
                }
            }
        }

        pending.prepares.add(senderPubkey);
        this._checkPrepareQuorum(rid);
    }

    _checkPrepareQuorum(rid){
        let pending = this.pending.get(rid);
        if(!pending || pending.finalized || !pending.winner) return;
        if(pending._commitSent) return;

        let quorum = pending.quorum;
        // For very small federations (e.g. N=1) quorum can be 0 from
        // getQuorum — collapse to REDUNDANCY in that case.
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
        if(!pending.winner) return;

        let senderPubkey = String(d.sig_pubkey || '').toLowerCase();
        if(!pending.responsible.some(v => v.pubkey === senderPubkey)) return;

        if(d.sig && d.sig_pubkey){
            let canonical = this._buildCanonical(rid, pending.providerId, pending.winner.body, pending.status, pending.winner.meta);
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
        let needed = Math.max(pending.quorum, pending.redundancy);
        if(pending.commits.size < needed) return;

        pending.finalized = true;
        this.finalized.add(rid);
        if(pending.timer) clearTimeout(pending.timer);

        // Convert signatures Map to [{pubkey, sig}] array for publisher
        let sigsArray = [];
        for(let [pk, sg] of pending.signatures){
            sigsArray.push({ pubkey: pk, sig: sg });
        }
        // Pare back if we somehow over-collected (rarely matters)
        // We need at least max(REDUNDANCY, quorum) sigs on the on-chain response.

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

        // Free memory shortly
        setTimeout(() => this.pending.delete(rid), 10000);
    }

    // Build the indexer-canonical signing message:
    //   request_id || provider_id || sha256(response_payload) || status || meta
    _buildCanonical(requestId, providerId, body, status, meta){
        let responseHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
        return Buffer.from(String(requestId) + String(providerId) + responseHash + String(status) + String(meta || ''), 'utf8');
    }

    // Sign the canonical bytes with this validator's identity. Returns
    // 128-hex-char sig or null when no identity is available.
    _signCanonical(requestId, providerId, body, status, meta){
        if(!this.identity) return null;
        try {
            let canonical = this._buildCanonical(requestId, providerId, body, status, meta);
            return this.identity.sign(canonical.toString('utf8'));
        } catch (e) {
            console.warn('AttestationConsensus: sign failed: ' + e.message);
            return null;
        }
    }
}

module.exports = AttestationConsensus;
module.exports.ATTEST_PROPOSE = ATTEST_PROPOSE;
module.exports.ATTEST_PREPARE = ATTEST_PREPARE;
module.exports.ATTEST_COMMIT  = ATTEST_COMMIT;
