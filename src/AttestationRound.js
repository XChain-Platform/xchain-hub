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
 * XChain Hub - Attestation Round Manager
 *
 * Per-request lifecycle on the validator side of the External Attestation
 * Framework. Unlike OracleRound (wall-clock cadence), AttestationRound is
 * event-driven — it polls the indexer for new ATTESTATION_REQUESTs in
 * 'pending' status, decides whether this validator is in the request's
 * responsible set, fetches the payload via the provider module, and gossips
 * an ATTEST_PROPOSE for AttestationConsensus to drive to quorum.
 *
 * Leader / responsible-set selection (spec §8.2):
 *   1. Filter to validators qualifying for `attestation` at the request's
 *      block_index (snapshot via CapabilitySnapshot).
 *   2. Sort by SHA-256(request_id || pubkey) ascending. (Spec calls for
 *      keccak256; SHA-256 has equivalent ordering properties — see plan §1.)
 *   3. Top REDUNDANCY are responsible; lowest-hash is leader.
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md
 *
 ********************************************************************/

const crypto = require('crypto');
const axios  = require('axios');

const ATTEST_PROPOSE = 'ATTEST_PROPOSE';

const DEFAULT_POLL_MS         = 15000;  // how often to poll the indexer for new pending requests
const DEFAULT_CONFIRMATIONS   = 3;      // BTC blocks of confirmation before initiating fetch (spec §14)
const DEFAULT_FETCH_TIMEOUT   = 10000;  // ms — provider fetch timeout

class AttestationRound {

    constructor(hub, providerRegistry){
        this.hub              = hub;
        this.peerManager      = hub.getPeerManager();
        this.db               = hub.db;
        this.identity         = hub.getIdentity ? hub.getIdentity() : null;
        this.providerRegistry = providerRegistry;
        this.config           = hub.p2pConfig || {};

        // Active round state, keyed by requestId. Each entry:
        //   { request, role: 'leader'|'follower'|'inactive', fetchedAt, proposed: bool }
        this.rounds = new Map();

        // Requests we've already evaluated (don't re-poll forever). Cleared on rollback hooks.
        this.seen = new Set();

        // AttestationConsensus instance — set via setConsensus after creation
        this.consensus = null;

        this._messageHandler = null;
        this._pollTimer      = null;

        this.pollMs         = parseInt(this.config.ATTESTATION_POLL_MS)        || DEFAULT_POLL_MS;
        this.confirmations  = parseInt(this.config.ATTESTATION_CONFIRMATIONS)  || DEFAULT_CONFIRMATIONS;
        this.fetchTimeoutMs = parseInt(this.config.ATTESTATION_FETCH_TIMEOUT)  || DEFAULT_FETCH_TIMEOUT;
    }

    setConsensus(consensus){
        this.consensus = consensus;
    }

    async start(){
        if(!this.peerManager){
            console.log('AttestationRound: no peer manager — skipping start');
            return;
        }
        this._messageHandler = (env) => this._handleMessage(env);
        this.peerManager.on('message', this._messageHandler);
        this._pollTimer = setInterval(() => {
            this._pollPending().catch(e => console.error('AttestationRound: poll error:', e && e.message ? e.message : e));
        }, this.pollMs);
        // Kick the first poll without waiting for the interval
        this._pollPending().catch(e => console.error('AttestationRound: initial poll error:', e && e.message ? e.message : e));
        console.log('AttestationRound: started (poll=' + this.pollMs + 'ms, confirmations=' + this.confirmations + ')');
    }

    async stop(){
        if(this._pollTimer){
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        if(this._messageHandler){
            this.peerManager.removeListener('message', this._messageHandler);
            this._messageHandler = null;
        }
        this.rounds.clear();
        this.seen.clear();
    }

    // Poll the BTC indexer for pending attestation_requests. For each new row
    // not already in `seen`, evaluate responsibility and (if responsible)
    // start a round.
    async _pollPending(){
        if(!this.identity) return;  // observer-only hub; nothing to propose
        let url = await this._resolveBtcIndexerUrl();
        if(!url) return;

        let res;
        try {
            res = await axios.post(url, {
                jsonrpc: '2.0', id: Date.now(),
                method:  'getpendingattestation_requests',
                params:  { limit: 100 }
            }, { timeout: 5000 });
        } catch (e) {
            console.warn('AttestationRound: poll failed — ' + (e && e.message ? e.message : e));
            return;
        }

        let result = res && res.data && res.data.result;
        if(!result || result.error) return;
        let latestBlock = Number(result.latest_block_index) || 0;
        let requests    = result.requests || [];

        for(let req of requests){
            let rid = String(req.request_id || '').toLowerCase();
            if(!rid || this.seen.has(rid)) continue;

            // Wait CONFIRMATIONS blocks past the request's tx before initiating
            // any external API call (spec §14 — avoids paying for reorg'd work).
            if(Number(req.block_index) + this.confirmations > latestBlock) continue;

            this.seen.add(rid);
            this._startRound(req).catch(e =>
                console.error('AttestationRound: start failed for ' + rid.substring(0,16) + '...: ' + (e && e.message ? e.message : e))
            );
        }
    }

    // Evaluate responsibility for this request, fetch if responsible, and
    // propose. Idempotent — repeat calls for the same requestId are dropped.
    async _startRound(request){
        let rid          = String(request.request_id).toLowerCase();
        let providerId   = String(request.provider_id);
        let redundancy   = Number(request.redundancy) || 1;
        let snapshotBlk  = Number(request.block_index);
        let myPubkey     = this.identity.getPubkeyHex().toLowerCase();

        // Provider known? (governance might have ATTESTATION_REQUEST whose
        // provider is governance-defined but not deployed locally.)
        if(!this.providerRegistry.isKnown(providerId)){
            console.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... — provider ' + providerId + ' unknown');
            return;
        }
        let providerModule = this.providerRegistry.getModule(providerId);
        if(!providerModule || typeof providerModule.fetch !== 'function'){
            console.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... — provider ' + providerId + ' module missing fetch()');
            return;
        }

        // Snapshot of validators qualifying for `attestation` at the request's
        // block boundary. Each hub computes the same set (deterministic).
        let snapshot = this.hub.capabilitySnapshot
            ? await this.hub.capabilitySnapshot.getSnapshot('attestation', snapshotBlk)
            : null;
        if(!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0){
            // Empty snapshot means no qualified validators exist at the request's
            // block — request can't be served. Will eventually expire on deadline.
            console.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... — empty capability snapshot at block ' + snapshotBlk);
            return;
        }

        let responsible = this._computeResponsibleSet(snapshot.validators, rid, redundancy);
        let leaderPubkey = responsible[0] ? responsible[0].pubkey : null;
        let amResponsible = responsible.some(v => v.pubkey === myPubkey);
        if(!amResponsible){
            // Not in the responsible set — log so operators can distinguish "saw and skipped" from "never polled".
            console.log('AttestationRound: skipping ' + rid.substring(0,16) + '... — not responsible at block ' + snapshotBlk +
                        ' (snapshot=' + snapshot.validators.length + ', leader=' + (leaderPubkey ? leaderPubkey.substring(0,16) + '...' : 'none') + ')');
            return;
        }
        let amLeader = (leaderPubkey === myPubkey);

        // Fetch the payload via the provider module. Capped at provider's max
        // response bytes; timeout from config. Failure burns the round on this
        // validator — slashing missed-validators is Phase 4.
        let providerDef = this.providerRegistry.getDef(providerId);
        let fetched;
        try {
            fetched = await providerModule.fetch(request.payload, {
                maxResponseBytes: providerDef.max_response_bytes,
                timeoutMs:        this.fetchTimeoutMs
            });
        } catch (e) {
            console.warn('AttestationRound: fetch failed for ' + rid.substring(0,16) + '...: ' + e.message);
            // Persist 'inactive' so we don't retry the same broken URL forever.
            this.rounds.set(rid, { request, role: amLeader ? 'leader' : 'follower', error: e.message });
            return;
        }

        let roundState = {
            request:        request,
            role:           amLeader ? 'leader' : 'follower',
            snapshot:       snapshot,
            snapshotBlock:  snapshotBlk,
            responsible:    responsible,
            leaderPubkey:   leaderPubkey,
            redundancy:     redundancy,
            providerId:     providerId,
            myProposal:     { body: fetched.body, meta: fetched.meta },
            proposedAt:     Date.now()
        };
        this.rounds.set(rid, roundState);

        console.log('AttestationRound: ' + (amLeader ? '[LEADER]' : '[FOLLOWER]') +
                    ' proposing ' + rid.substring(0,16) + '... (provider=' + providerId +
                    ', body=' + fetched.body.length + 'B, meta=' + fetched.meta + ')');

        // Hand to consensus so it can collect PROPOSEs from other validators
        // and drive PBFT. Consensus is responsible for the actual ATTEST_PROPOSE
        // broadcast (so it owns the canonical-bytes/signature shape).
        if(this.consensus){
            await this.consensus.propose(rid, roundState);
        }
    }

    // Deterministic responsibility computation. Sort validators by
    // SHA256(request_id || pubkey) ascending, take top REDUNDANCY.
    // Returns [{ pubkey, hash }] sorted by hash. responsible[0] is leader.
    _computeResponsibleSet(validators, requestId, redundancy){
        let withHash = validators.map(v => {
            let pk = String(v.pubkey).toLowerCase();
            let h  = crypto.createHash('sha256').update(requestId, 'utf8').update(pk, 'utf8').digest('hex');
            return { pubkey: pk, hash: h };
        });
        withHash.sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
        return withHash.slice(0, Math.max(1, redundancy));
    }

    // Look up the round state for a given requestId. Used by consensus to
    // verify incoming PROPOSE messages against our own view of responsibility.
    getRoundState(requestId){
        return this.rounds.get(String(requestId).toLowerCase()) || null;
    }

    _handleMessage(envelope){
        // AttestationRound itself doesn't handle PBFT messages — those go
        // to AttestationConsensus. We only listen so that subclassed
        // implementations or future scope can hook here without re-subscribing.
    }

    // ----- BTC indexer URL resolution (mirrors XChainHub helpers) -----

    async _resolveBtcIndexerUrl(){
        if(typeof this.hub._resolveBtcIndexerUrl === 'function'){
            return await this.hub._resolveBtcIndexerUrl();
        }
        return null;
    }
}

module.exports = AttestationRound;
module.exports.ATTEST_PROPOSE = ATTEST_PROPOSE;
