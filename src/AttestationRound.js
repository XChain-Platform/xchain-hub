/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Hub - Attestation Round Manager
 *
 * Per-request lifecycle on the validator side of the External Attestation
 * Framework. Unlike OracleRound (wall-clock cadence), AttestationRound is
 * event-driven — it polls the indexer for new ATTEST v0 (request) rows in
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
const POLL_LIMIT              = 100;    // max pending requests fetched per poll page (cursor advances across pages)

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

        // Requests we've already evaluated, as request_id -> last-evaluated
        // timestamp (ms). A Map rather than a Set so entries can be evicted
        // after `retryAfterMs`: a request skipped for a transient reason
        // (provider not yet registered, empty capability snapshot) becomes
        // eligible for re-evaluation once the window lapses, instead of being
        // suppressed for the whole process lifetime. Also bounds memory —
        // a plain Set grew monotonically with historical request volume.
        this.seen = new Map();

        // Keyset cursor for paging through pending requests across poll cycles.
        // null = start a fresh sweep from the oldest pending request.
        this.pollCursor = null;

        // AttestationConsensus instance — set via setConsensus after creation
        this.consensus = null;

        this._pollTimer      = null;

        this.pollMs         = parseInt(this.config.ATTESTATION_POLL_MS)        || DEFAULT_POLL_MS;
        this.confirmations  = parseInt(this.config.ATTESTATION_CONFIRMATIONS)  || DEFAULT_CONFIRMATIONS;
        this.fetchTimeoutMs = parseInt(this.config.ATTESTATION_FETCH_TIMEOUT)  || DEFAULT_FETCH_TIMEOUT;
        // How long a request stays in `seen` before it can be re-evaluated.
        // Defaults to 5 poll cycles so transient skips clear quickly while
        // still suppressing the steady-state re-poll of confirmed work.
        this.retryAfterMs   = parseInt(this.config.ATTESTATION_RETRY_AFTER_MS) || (5 * this.pollMs);
        // How long a `rounds` entry is retained before lazy eviction. A round's
        // active lifecycle is ~2 min (consensus round timeout), so the 1-hour
        // default leaves a wide safety margin while bounding memory — without
        // this the Map grew monotonically with lifetime request volume (it was
        // only ever cleared on stop()).
        this.roundsTtlMs    = parseInt(this.config.ATTESTATION_ROUND_TTL_MS)   || (60 * 60 * 1000);
    }

    setConsensus(consensus){
        this.consensus = consensus;
    }

    async start(){
        if(!this.peerManager){
            console.log('AttestationRound: no peer manager — skipping start');
            return;
        }
        this._pollTimer = setInterval(() => {
            this._pollPending().catch(e => console.error('AttestationRound: poll error:', e));
        }, this.pollMs);
        // Kick the first poll without waiting for the interval
        this._pollPending().catch(e => console.error('AttestationRound: initial poll error:', e));
        console.log('AttestationRound: started (poll=' + this.pollMs + 'ms, confirmations=' + this.confirmations + ')');
    }

    async stop(){
        if(this._pollTimer){
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        this.rounds.clear();
        this.seen.clear();
        this.pollCursor = null;
    }

    // Poll the BTC indexer for pending attestation_requests. For each new row
    // not already in `seen`, evaluate responsibility and (if responsible)
    // start a round.
    async _pollPending(){
        if(!this.identity) return;  // observer-only hub; nothing to propose
        let url = await this._resolveBtcIndexerUrl();
        if(!url) return;

        // Drop `seen` entries older than the retry window so transiently-skipped
        // requests can be re-evaluated once their blocking condition clears.
        this._evictStaleSeen();

        // Drop `rounds` entries older than the round TTL so completed/abandoned
        // round state doesn't accumulate for the process lifetime.
        this._evictStaleRounds();

        // Page forward from where the last poll left off. When the cursor is
        // null this requests the oldest page; otherwise it asks the indexer for
        // rows strictly after the last (block_index, action_index) we saw.
        let params = { limit: POLL_LIMIT };
        if(this.pollCursor){
            params.after_block_index  = this.pollCursor.block_index;
            params.after_action_index = this.pollCursor.action_index;
        }

        let res;
        try {
            res = await axios.post(url, {
                jsonrpc: '2.0', id: Date.now(),
                method:  'getpendingattestation_requests',
                params:  params
            }, { headers: this.hub._btcIndexerHeaders(), timeout: 5000 });
        } catch (e) {
            console.warn('AttestationRound: poll failed —', e);
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

            this.seen.set(rid, Date.now());
            this._startRound(req).catch(e =>
                console.error('AttestationRound: start failed for ' + rid.substring(0,16) + '...: ' + (e && e.message ? e.message : e))
            );
        }

        // Advance the cursor to the last (highest-ordered) row in this page so
        // the next poll continues past it. A short page (< POLL_LIMIT) means we
        // reached the tail of the queue, so reset to null to restart the sweep
        // from the oldest pending request next cycle. Resetting also lets any
        // row we cursored past but didn't act on (e.g. not yet confirmed) be
        // re-seen on the next sweep.
        if(requests.length > 0){
            let last = requests[requests.length - 1];
            this.pollCursor = { block_index: Number(last.block_index), action_index: Number(last.action_index) };
        }
        if(requests.length < POLL_LIMIT){
            if(this.pollCursor) console.log('AttestationRound: reached end of pending queue — restarting sweep next poll');
            this.pollCursor = null;
        }
    }

    // Remove `seen` entries whose last-evaluated timestamp is older than the
    // retry window, so a request previously skipped for a transient reason is
    // treated as new again on the next poll.
    _evictStaleSeen(){
        let cutoff = Date.now() - this.retryAfterMs;
        for(let [rid, ts] of this.seen){
            if(ts < cutoff) this.seen.delete(rid);
        }
    }

    // Remove `rounds` entries whose proposedAt is older than the round TTL.
    // Round state is only needed while a request's PBFT round is in flight
    // (getRoundState lookups by consensus); long-completed rounds are dead
    // weight, so evicting them bounds memory.
    _evictStaleRounds(){
        let cutoff = Date.now() - this.roundsTtlMs;
        for(let [rid, st] of this.rounds){
            if(st && typeof st.proposedAt === 'number' && st.proposedAt < cutoff){
                this.rounds.delete(rid);
            }
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

        // Provider known? (governance might have ATTEST v0 (request) whose
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
            console.warn('AttestationRound: fetch failed for ' + rid.substring(0,16) + '...: ', e);
            // Persist 'inactive' so we don't retry the same broken URL forever.
            this.rounds.set(rid, { request, role: amLeader ? 'leader' : 'follower', error: e.message, proposedAt: Date.now() });
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

    getStats(){
        let proposed = 0, failed = 0;
        for(let [, entry] of this.rounds){
            if(entry.error) failed++;
            else proposed++;
        }
        return {
            seen_count:      this.seen.size,
            in_flight_count: this.seen.size - this.rounds.size,  // seen but _startRound not yet resolved
            proposed_count:  proposed,
            failed_count:    failed
        };
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
