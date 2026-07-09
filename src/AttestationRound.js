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
 * XChain Hub - Attestation Round Manager
 *
 * Per-request lifecycle on the validator side of the External Attestation
 * Framework. Unlike OracleRound (wall-clock cadence), AttestationRound is
 * event-driven: it polls the indexer for new ATTEST v0 (request) rows in
 * 'pending' status, decides whether this validator is in the request's
 * responsible set, fetches the payload via the provider module, and gossips
 * an ATTEST_PROPOSE for AttestationConsensus to drive to quorum.
 *
 * Leader / responsible-set selection (spec §8.2):
 *   1. Filter to validators qualifying for `attestation` at the request's
 *      block_index (snapshot via CapabilitySnapshot).
 *   2. Sort by SHA-256(request_id || pubkey) ascending. (Spec calls for
 *      keccak256; SHA-256 has equivalent ordering properties; see plan §1.)
 *   3. Top REDUNDANCY are responsible; lowest-hash is leader.
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md
 *
 ********************************************************************/

const crypto = require('crypto');
const axios  = require('axios');
const bc     = require('./bcmath.js');
const swq    = require('./stake_weighted_quorum.js');
const esc    = require('./attestation_escalation.js');

const ATTEST_PROPOSE = 'ATTEST_PROPOSE';

const DEFAULT_POLL_MS         = 15000;  // how often to poll the indexer for new pending requests
const DEFAULT_CONFIRMATIONS   = 3;      // BTC blocks of confirmation before initiating fetch (spec §14)
const DEFAULT_FETCH_TIMEOUT   = 10000;  // ms: provider fetch timeout
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
        // suppressed for the whole process lifetime. Also bounds memory;
        // a plain Set grew monotonically with historical request volume.
        this.seen = new Map();

        // Keyset cursor for paging through pending requests across poll cycles.
        // null = start a fresh sweep from the oldest pending request.
        this.pollCursor = null;

        // AttestationConsensus instance; set via setConsensus after creation
        this.consensus = null;

        this._pollTimer      = null;

        this.pollMs         = parseInt(this.config.ATTESTATION_POLL_MS)        || DEFAULT_POLL_MS;
        this.confirmations  = parseInt(this.config.ATTESTATION_CONFIRMATIONS)  || DEFAULT_CONFIRMATIONS;
        this.fetchTimeoutMs = parseInt(this.config.ATTESTATION_FETCH_TIMEOUT)  || DEFAULT_FETCH_TIMEOUT;
        // Blocks of leader silence before the round leader rotates one slot down
        // the responsible set (and the model-fallback ladder advances; both are
        // pure functions of chain height, see attestation_escalation.js).
        this.leaderRotationBlocks = parseInt(this.config.ATTESTATION_LEADER_ROTATION_BLOCKS) || esc.DEFAULT_ROTATION_WINDOW_BLOCKS;
        // How long a request stays in `seen` before it can be re-evaluated.
        // Defaults to 5 poll cycles so transient skips clear quickly while
        // still suppressing the steady-state re-poll of confirmed work.
        this.retryAfterMs   = parseInt(this.config.ATTESTATION_RETRY_AFTER_MS) || (5 * this.pollMs);
        // How long a `rounds` entry is retained before lazy eviction. A round's
        // active lifecycle is ~2 min (consensus round timeout), so the 1-hour
        // default leaves a wide safety margin while bounding memory. Without
        // this the Map grew monotonically with lifetime request volume (it was
        // only ever cleared on stop()).
        this.roundsTtlMs    = parseInt(this.config.ATTESTATION_ROUND_TTL_MS)   || (60 * 60 * 1000);
    }

    setConsensus(consensus){
        this.consensus = consensus;
    }

    async start(){
        if(!this.peerManager){
            console.log('AttestationRound: no peer manager; skipping start');
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
            let status = e && e.response && e.response.status;
            if(status === 401 || status === 403){
                // Auth failure is distinct from the indexer being down: the operator
                // has a key mismatch between the indexer and this hub. Log clearly so
                // they can identify the misconfiguration instead of seeing a generic
                // "unreachable" message and chasing a network issue.
                console.warn('AttestationRound: HTTP ' + status + ' from BTC indexer at ' + url +
                    ': auth mismatch - check that BTC_INDEXER_API_KEY on this hub matches INDEXER_API_KEY on the indexer');
            } else {
                console.warn('AttestationRound: poll failed:', e && e.message ? e.message : e);
            }
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
            // any external API call (spec §14; avoids paying for reorg'd work).
            if(Number(req.block_index) + this.confirmations > latestBlock) continue;

            this.seen.set(rid, Date.now());
            this._startRound(req, latestBlock).catch(e =>
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
            if(this.pollCursor) console.log('AttestationRound: reached end of pending queue; restarting sweep next poll');
            this.pollCursor = null;
        }
    }

    _evictStaleSeen(){
        let cutoff = Date.now() - this.retryAfterMs;
        for(let [rid, ts] of this.seen){
            if(ts < cutoff) this.seen.delete(rid);
        }
    }

    _evictStaleRounds(){
        let cutoff = Date.now() - this.roundsTtlMs;
        for(let [rid, st] of this.rounds){
            if(st && typeof st.proposedAt === 'number' && st.proposedAt < cutoff){
                this.rounds.delete(rid);
            }
        }
    }

    // Idempotent: repeat calls for the same requestId are dropped.
    // `latestBlock` is the indexer tip observed by the poll that surfaced this
    // request; it drives the deterministic leader-rotation + model-fallback
    // ladders (attestation_escalation.js).
    async _startRound(request, latestBlock){
        let rid          = String(request.request_id).toLowerCase();
        let providerId   = String(request.provider_id);
        let redundancy   = Number(request.redundancy) || 1;
        let snapshotBlk  = Number(request.block_index);
        let myPubkey     = this.identity.getPubkeyHex().toLowerCase();

        // Provider known? (governance might have ATTEST v0 (request) whose
        // provider is governance-defined but not deployed locally.)
        if(!this.providerRegistry.isKnown(providerId)){
            console.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... provider ' + providerId + ' unknown');
            return;
        }
        let providerModule = this.providerRegistry.getModule(providerId);
        if(!providerModule || typeof providerModule.fetch !== 'function'){
            console.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... provider ' + providerId + ' module missing fetch()');
            return;
        }

        // Snapshot of validators qualifying for `attestation` at the request's
        // block boundary. Each hub computes the same set (deterministic).
        // STAKE_WEIGHTED_QUORUM: at/above activation, resolve the SOURCE-keyed
        // weight snapshot so the responsible-set selection can dedupe by staking
        // source (one slot per source), closing the delegation slot-inflation
        // hole. The within-subset quorum stays count-based (attestation is an
        // independent-replication check, not a stake vote). Gated on the request's
        // block + the hub's network so every hub flips on the same anchor.
        let weighted = swq.isStakeWeightedQuorumActive(snapshotBlk, this.hub.network);
        let snapshot = this.hub.capabilitySnapshot
            ? (weighted
                ? await this.hub.capabilitySnapshot.getWeightSnapshot('attestation', snapshotBlk)
                : await this.hub.capabilitySnapshot.getSnapshot('attestation', snapshotBlk))
            : null;
        if(!snapshot || !Array.isArray(snapshot.validators) || snapshot.validators.length === 0){
            // Empty snapshot means no qualified validators exist at the request's
            // block; request can't be served. Will eventually expire on deadline.
            console.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... empty capability snapshot at block ' + snapshotBlk);
            return;
        }

        let responsible = this._computeResponsibleSet(snapshot.validators, rid, redundancy, weighted);
        // Leader rotation (Phase 4): a silent leader must not stall the request
        // until deadline expiry. The leader slot advances one step down the
        // hash-ordered responsible set per rotation window of elapsed chain
        // time. The SET stays identical (indexer signature validation keys on
        // membership, never on leadership), only the slot that runs agree() and
        // broadcasts first moves. Falls back to slot 0 when the poll couldn't
        // resolve a tip height.
        let step = Number.isFinite(Number(latestBlock)) && Number(latestBlock) > 0
            ? esc.escalationStep(Number(latestBlock), snapshotBlk, this.confirmations, this.leaderRotationBlocks)
            : 0;
        let leaderIdx    = esc.leaderIndex(step, responsible.length);
        let leaderPubkey = responsible[leaderIdx] ? responsible[leaderIdx].pubkey : (responsible[0] ? responsible[0].pubkey : null);
        let amResponsible = responsible.some(v => v.pubkey === myPubkey);
        if(!amResponsible){
            // Not in the responsible set; log so operators can distinguish "saw and skipped" from "never polled".
            console.log('AttestationRound: skipping ' + rid.substring(0,16) + '... not responsible at block ' + snapshotBlk +
                        ' (snapshot=' + snapshot.validators.length + ', leader=' + (leaderPubkey ? leaderPubkey.substring(0,16) + '...' : 'none') + ')');
            return;
        }
        let amLeader = (leaderPubkey === myPubkey);

        let providerDef = this.providerRegistry.getDef(providerId);

        // Resolve the provider's model identity from the BLOCK-ANCHORED provider
        // config at the request's block (snapshotBlk), so every hub fetches and
        // judges with the same model for this request regardless of when its local
        // governance change finalized, and a governance change activated at a later
        // block cannot alter an in-flight round. Mirrors the block-anchored MIN_STAKE
        // resolution that locks the responsible set.
        let pinnedAc = this.providerRegistry.getAdditionalConfig(providerId, snapshotBlk) || {};
        // Model fallback ladder (Phase 4): the block-anchored approved_models
        // list is an ORDERED fallback chain. The request's serviceable span is
        // split into one segment per model, so a dead primary vendor stops
        // burning the deadline window once the chain crosses into the next
        // segment. Deterministic: every hub derives the same modelIdx from the
        // same chain height, so all validators in a round fetch with the SAME
        // model (a judge_model round mixing vendors would fail equivalence).
        let approvedModels = Array.isArray(pinnedAc.approved_models) ? pinnedAc.approved_models : [];
        let modelIdx = Number.isFinite(Number(latestBlock)) && Number(latestBlock) > 0
            ? esc.modelIndex(Number(latestBlock), snapshotBlk, this.confirmations, Number(request.deadline_block), approvedModels.length)
            : 0;
        let pinnedFetchModel = approvedModels[modelIdx] || approvedModels[0] || null;
        let pinnedJudgeModel = pinnedAc.judge_model || null;
        if(!pinnedFetchModel){
            console.warn('AttestationRound: provider "' + providerId + '" has no approved_models at block ' +
                         snapshotBlk + '; fetch falls back to the provider module default (un-pinned)');
        }

        // Hub-local min_fee floor (E1, governance-synced via the provider
        // definition). Below-floor requests are skipped BEFORE any provider
        // fetch; with every hub applying the same floor the request simply
        // expires on-chain and the fee refunds. This is economically clean
        // back-pressure with zero consensus involvement.
        let minFee    = (providerDef && !bc.isNull(providerDef.min_fee_xchain)) ? String(providerDef.min_fee_xchain) : '0';
        let reqFeeAmt = (request && !bc.isNull(request.fee_amount)) ? String(request.fee_amount) : '0';
        if(bc.bcgt(minFee, '0') && bc.bclt(reqFeeAmt, minFee)){
            console.log('AttestationRound: skipping ' + rid.substring(0,16) + '... fee ' + reqFeeAmt +
                        ' below provider "' + providerId + '" min_fee ' + minFee + ' (request will expire + refund)');
            return;
        }

        // Fetch the payload via the provider module. Capped at provider's max
        // response bytes; timeout from config. A failed fetch no longer goes
        // silent: it becomes a status='provider_error' proposal (empty body,
        // empty meta) so the round can quorum-sign an explicit non-ok ATTEST v1
        // (Phase 4) instead of stalling every peer until deadline expiry.
        let fetched   = null;
        let myStatus  = 'ok';
        try {
            fetched = await providerModule.fetch(request.payload, {
                maxResponseBytes: providerDef.max_response_bytes,
                timeoutMs:        this.fetchTimeoutMs,
                pinnedModel:      pinnedFetchModel,
                // Rank of the pinned model on the fallback ladder; providers
                // enforce request-level fallback policy on it (llm 'strict').
                modelRank:        modelIdx
            });
        } catch (e) {
            console.warn('AttestationRound: fetch failed for ' + rid.substring(0,16) + '...: ', e);
            myStatus = 'provider_error';
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
            // Error proposals carry an empty body and empty meta so every
            // failed fetcher signs the IDENTICAL canonical bytes (the non-ok
            // outcome converges without a judge; see AttestationConsensus).
            myProposal:     (myStatus === 'ok')
                ? { body: fetched.body, meta: fetched.meta, status: 'ok' }
                : { body: Buffer.alloc(0), meta: '', status: myStatus },
            pinnedJudgeModel: pinnedJudgeModel,
            error:          (myStatus === 'ok') ? undefined : myStatus,
            proposedAt:     Date.now()
        };
        this.rounds.set(rid, roundState);

        console.log('AttestationRound: ' + (amLeader ? '[LEADER]' : '[FOLLOWER]') +
                    ' proposing ' + rid.substring(0,16) + '... (provider=' + providerId +
                    ', status=' + myStatus +
                    (myStatus === 'ok' ? ', body=' + fetched.body.length + 'B, meta=' + fetched.meta : '') +
                    ', model=' + (pinnedFetchModel || 'default') + '[' + modelIdx + '], leaderSlot=' + leaderIdx + ')');

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
    // STAKE_WEIGHTED_QUORUM (weighted=true): first dedupe by staking source so a
    // source's delegated keys can't occupy multiple responsible slots; keep each
    // source's lowest-hash key (iterate in hash order).
    //
    // CONSENSUS-CRITICAL: the indexer (actions/attest.js) must apply the
    // identical rule or validation forks. The two implementations are currently
    // behaviorally identical (hash-order sort, source===null keep branch,
    // redundancy slice), but no cross-service test feeds the same validators +
    // requestId through both and asserts identical output. Any silent change to
    // either copy is a fork surface; always update both files together.
    _computeResponsibleSet(validators, requestId, redundancy, weighted){
        let withHash = validators.map(v => {
            let pk = String(v.pubkey).toLowerCase();
            let h  = crypto.createHash('sha256').update(requestId, 'utf8').update(pk, 'utf8').digest('hex');
            return { pubkey: pk, source: (v.source != null ? String(v.source) : null), hash: h };
        });
        withHash.sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0));
        if(weighted){
            let seen = new Set();
            withHash = withHash.filter(v => {
                if(v.source === null) return true;          // no source info -> keep (defensive)
                if(seen.has(v.source)) return false;        // source already represented
                seen.add(v.source);
                return true;
            });
        }
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

    async _resolveBtcIndexerUrl(){
        if(typeof this.hub._resolveBtcIndexerUrl === 'function'){
            return await this.hub._resolveBtcIndexerUrl();
        }
        return null;
    }
}

module.exports = AttestationRound;
module.exports.ATTEST_PROPOSE = ATTEST_PROPOSE;
