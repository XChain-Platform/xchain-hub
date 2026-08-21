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
 ********************************************************************/

const crypto = require('crypto');
const axios  = require('axios');
const bc     = require('./bcmath.js');
const swq    = require('./stake_weighted_quorum.js');
const esc    = require('./attestation_escalation.js');
// The consensus round-timeout default the seen-window floor below is keyed to.
// Required, never re-spelled: see the constant's own note in constants.js.
const { DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS } = require('./constants.js');

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
        // In-flight guard for the interval-driven poll. Matches the
        // house convention (XChainIndexer _hubConfigPollRunning, XChainDecoder
        // mempoolBusy, HubPushQueue draining): a poll that outruns pollMs under a
        // slow/partitioned indexer or a tightened ATTESTATION_POLL_MS must not
        // stack a second concurrent _pollPending that races this.pollCursor.
        this._pollRunning    = false;

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
        //
        // Floor it above the consensus round timeout. The seen window
        // must never nest inside a LIVE consensus round: if it evicts first, the
        // next poll re-`_startRound`s a request whose round is still pending and
        // issues another paid provider fetch that consensus.propose() then discards
        // on its `pending.has(rid)` guard. At stock defaults 5*15s=75s is already
        // shorter than the 120s round timeout, and lowering ATTESTATION_POLL_MS
        // widens the gap silently. Sourcing the round timeout from the same config
        // key AND the same shared default AttestationConsensus reads keeps the two
        // windows coupled on both paths; a re-spelled literal here coupled them only
        // while the two copies happened to be equal, so raising the consensus default
        // one-sidedly re-nested the window on any hub with no explicit key. The paid
        // fetch is also short-circuited directly in _startRound via
        // consensus.isRoundActive(), but flooring closes the nesting at its root.
        let roundTimeoutMs  = parseInt(this.config.ATTESTATION_ROUND_TIMEOUT_MS)
                            || DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS;
        this.retryAfterMs   = Math.max(
            parseInt(this.config.ATTESTATION_RETRY_AFTER_MS) || (5 * this.pollMs),
            roundTimeoutMs + this.pollMs
        );
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
        this._pollRunning = false;
    }

    async _pollPending(){
        if(!this.identity) return;  // observer-only hub; nothing to propose
        // In-flight guard: if a prior poll is still awaiting the
        // indexer, skip this tick rather than stack a concurrent run that races
        // this.pollCursor. The finally clears the flag across every early return.
        if(this._pollRunning) return;
        this._pollRunning = true;
        try {
        let url = await this._resolveBtcIndexerUrl();
        if(!url) return;

        // Drop `seen` entries older than the retry window so transiently-skipped
        // requests can be re-evaluated once their blocking condition clears.
        this._evictStaleSeen();

        // Same window, durable half: drop recorded fetches whose
        // retry window has lapsed so the table cannot grow with request volume.
        await this._evictStaleFetchCache();

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
        } finally {
            this._pollRunning = false;
        }
    }

    _evictStaleSeen(){
        let cutoff = Date.now() - this.retryAfterMs;
        for(let [rid, ts] of this.seen){
            if(ts < cutoff) this.seen.delete(rid);
        }
    }

    // ----- Durable fetch cache -----
    //
    // Fail-OPEN, deliberately, and unlike AttestationPublisher's spend WAL: this
    // table only prevents paying a second time for the same fetch, so a DB fault
    // must degrade to today's behavior (fetch again) rather than drop a round.
    // Every method below therefore swallows its error and returns the
    // no-cache answer.
    _cacheCutoffEpochSec(){
        return Math.floor((Date.now() - this.retryAfterMs) / 1000);
    }

    // The recorded outcome for a request, or null when there is none, it has
    // aged past the retry window, or the DB is unreachable.
    async _readFetchCache(rid){
        if(!this.db || typeof this.db.doQuery !== 'function') return null;
        try {
            let rows = await this.db.doQuery(
                'SELECT status, body, meta FROM attestation_fetch_cache ' +
                'WHERE request_id = ? AND created_at >= FROM_UNIXTIME(?)',
                [rid, this._cacheCutoffEpochSec()]);
            let row = (rows && rows.length) ? rows[0] : null;
            if(!row) return null;
            // Providers return { body: Buffer, meta: string } and agree() drops a
            // proposal whose body is not a Buffer, so restore the BLOB as one.
            return {
                status: String(row.status || 'ok'),
                body:   Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body || ''),
                meta:   (row.meta === null || row.meta === undefined) ? '' : String(row.meta)
            };
        } catch (e) {
            console.warn('AttestationRound: fetch-cache read failed for ' + String(rid).substring(0,16) +
                         '...; falling back to a fresh fetch:', e && e.message ? e.message : e);
            return null;
        }
    }

    // Upsert the completed outcome, success and provider_error alike: a durable
    // error is what keeps a restart from re-proposing a different answer for a
    // round that already carries this hub's signed non-ok proposal.
    async _writeFetchCache(rid, providerId, status, fetched, model){
        if(!this.db || typeof this.db.doQuery !== 'function') return;
        try {
            let body = (fetched && fetched.body !== null && fetched.body !== undefined)
                ? fetched.body : Buffer.alloc(0);
            if(!Buffer.isBuffer(body)) body = Buffer.from(String(body));
            let meta = (fetched && fetched.meta !== null && fetched.meta !== undefined)
                ? String(fetched.meta) : '';
            await this.db.doQuery(
                'INSERT INTO attestation_fetch_cache ' +
                '(request_id, provider_id, status, body, meta, model) VALUES (?, ?, ?, ?, ?, ?) ' +
                'ON DUPLICATE KEY UPDATE provider_id = VALUES(provider_id), status = VALUES(status), ' +
                'body = VALUES(body), meta = VALUES(meta), model = VALUES(model), ' +
                'created_at = CURRENT_TIMESTAMP',
                [rid, String(providerId || ''), String(status || 'ok'), body, meta,
                 model ? String(model) : null]);
        } catch (e) {
            console.warn('AttestationRound: fetch-cache write failed for ' + String(rid).substring(0,16) +
                         '...; a restart may re-pay this fetch:', e && e.message ? e.message : e);
        }
    }

    // Bound growth on the same window `seen` uses; a finalized or expired round
    // has no further use for its recorded fetch.
    async _evictStaleFetchCache(){
        if(!this.db || typeof this.db.doQuery !== 'function') return;
        try {
            await this.db.doQuery(
                'DELETE FROM attestation_fetch_cache WHERE created_at < FROM_UNIXTIME(?)',
                [this._cacheCutoffEpochSec()]);
        } catch (e) {
            console.warn('AttestationRound: fetch-cache eviction failed:', e && e.message ? e.message : e);
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

        // PROVIDER STAKE FLOOR. A HIGHER, per-provider bar on top of the
        // capability MIN_STAKE the snapshot was already built at: serving an `llm`
        // attestation costs more stake than serving an `http_get` one. Resolved from
        // the BLOCK-ANCHORED provider history at the request's own block, for the same
        // reason the model identity below is: a governance change that finalized at a
        // different wall-clock moment on another hub must not make the two hubs filter
        // the same request's validator set differently.
        //
        // Fail closed on an unresolvable floor, mirroring CapabilitySnapshot's #S-F3
        // posture for the capability threshold: a floorless provider must not silently
        // widen the serving set to everyone who clears the (lower) capability bar.
        // typeof-guarded so a registry that cannot answer resolves to null and the
        // weighted path skips the round, rather than throwing mid-poll and losing every
        // other pending request in the same sweep. Fails closed either way.
        let providerFloor = (this.providerRegistry && typeof this.providerRegistry.getMinStake === 'function')
            ? this.providerRegistry.getMinStake(providerId, snapshotBlk) : null;
        if(weighted && providerFloor === null){
            console.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... provider "' + providerId +
                         '" has no min_stake_xchain floor at block ' + snapshotBlk + ' (failing closed)');
            return;
        }
        let responsible = this._computeResponsibleSet(snapshot.validators, rid, redundancy, weighted, providerFloor);
        // Unservable-redundancy guard (Pkg 7 / 87441a53): when the snapshot (or
        // its weighted source-dedupe) yields fewer responsible slots than
        // REDUNDANCY, the round can never finalize; the indexer requires
        // >= redundancy valid signatures and only responsible-set members can
        // sign. AttestationConsensus.propose already refuses the round
        // (unfinalizable-round guard); skipping HERE additionally saves the paid
        // provider fetch that propose() would discard. Same loud warn; the
        // request reaches its normal deadline expiry + refund (or, at/above the
        // indexer's ATTEST_ADMISSION flag-day, is rejected at admission and
        // never polled at all).
        if(responsible.length < Math.max(1, redundancy)){
            console.warn('AttestationRound: skipping unfinalizable ' + rid.substring(0,16) +
                '... (responsible=' + responsible.length + ' < redundancy=' + Math.max(1, redundancy) +
                ' at block ' + snapshotBlk +
                (weighted ? ', weighted source-dedupe, provider floor ' + providerFloor : '') + ')');
            return;
        }
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
        // The model->vendor map has to travel with the pinned model ids,
        // not be read from each hub's live hotReloaded config. A governance change
        // that adds a new-family model plus its model_vendors entry in one block
        // otherwise splits the round, since a laggard hub holds the pinned id but
        // not the mapping and cannot resolve a vendor at all.
        let pinnedVendors = (pinnedAc.model_vendors && typeof pinnedAc.model_vendors === 'object')
            ? pinnedAc.model_vendors : null;
        // The PBFT strategy is anchored for a stronger reason than the model identity is:
        // it selects which state machine AttestationConsensus runs for this round, not
        // merely which model answers it. Read live off the hot-reloadable registry at each
        // decision site, one hub could adopt a leader's PREPARE while another ran its own
        // agree() over the same round, because hotReload() re-parses every provider def on
        // EVERY proposal:finalized event regardless of subject. Resolved ONCE here at the
        // request's own block and carried on roundState, so a reload landing mid-round
        // cannot move it and two hubs whose reloads raced still run the same machine.
        // Fail closed on an unresolvable strategy, exactly as the provider floor does
        // below: guessing a default here would silently run byte_equality against a
        // judge_model federation.
        let pinnedConsensusStrategy = (this.providerRegistry && typeof this.providerRegistry.getConsensusStrategy === 'function')
            ? this.providerRegistry.getConsensusStrategy(providerId, snapshotBlk) : null;
        if(!pinnedConsensusStrategy){
            console.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... provider "' + providerId +
                         '" has no block-anchored consensus_strategy at block ' + snapshotBlk + ' (failing closed)');
            return;
        }
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
        // Short-circuit the paid provider call if a consensus round for this rid
        // is already live. A re-poll of a still-running round would
        // otherwise pay for a fetch that consensus.propose() immediately discards
        // on its `pending.has(rid)` guard. Checking here moves that existing guard
        // ahead of the vendor call instead of after it. Worst blast radius is
        // providers/llm, where the wasted call burns vendor quota on precisely the
        // degraded rounds already running long.
        if(this.consensus && typeof this.consensus.isRoundActive === 'function' && this.consensus.isRoundActive(rid)){
            console.log('AttestationRound: skipping fetch for ' + rid.substring(0,16) + '... (consensus round already active)');
            return;
        }

        // Durable, request_id-keyed twin of the in-memory `seen`
        // window. Both guards above die with the process (`seen` is cleared on
        // stop(), isRoundActive reads live consensus state), so a restart inside
        // the round window re-paid the provider for a request this hub had
        // already fetched, and on a non-deterministic provider (llm) re-signed a
        // DIFFERENT body under the same rid. Reusing the recorded result makes a
        // restart behave exactly like no restart. Cache rows age out on the same
        // retryAfterMs window as `seen`, so a genuinely timed-out round still
        // re-fetches rather than replaying a stale answer forever.
        let cached    = await this._readFetchCache(rid);
        let fetched   = null;
        let myStatus  = 'ok';
        if(cached){
            fetched  = { body: cached.body, meta: cached.meta };
            myStatus = cached.status;
            console.log('AttestationRound: reusing recorded fetch for ' + rid.substring(0,16) +
                        '... (status=' + myStatus + '); no provider call issued');
        } else {
            try {
                fetched = await providerModule.fetch(request.payload, {
                    maxResponseBytes: providerDef.max_response_bytes,
                    timeoutMs:        this.fetchTimeoutMs,
                    pinnedModel:      pinnedFetchModel,
                    // Block-anchored model->vendor map for the pinned id.
                    pinnedVendors:    pinnedVendors,
                    // Rank of the pinned model on the fallback ladder; providers
                    // enforce request-level fallback policy on it (llm 'strict').
                    modelRank:        modelIdx
                });
            } catch (e) {
                console.warn('AttestationRound: fetch failed for ' + rid.substring(0,16) + '...: ', e);
                myStatus = 'provider_error';
            }
            // Record the COMPLETED outcome only. A claim written before the call
            // would let a crash mid-fetch skip a round this hub never finished,
            // trading bounded duplicate spend for a liveness hole.
            await this._writeFetchCache(rid, providerId, myStatus, fetched, pinnedFetchModel);
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
            pinnedVendors:    pinnedVendors,
            // The response cap this round's own fetch was bounded by, carried so
            // AttestationConsensus can size its inbound PROPOSE/PREPARE body gate
            // from the same number instead of re-reading the hot-reloadable
            // registry per message. A governance change landing mid-round would
            // otherwise leave this hub gating its peers' bodies at a cap its own
            // proposal never had to meet.
            pinnedMaxResponseBytes: (providerDef && Number(providerDef.max_response_bytes)) || null,
            // Block-anchored PBFT strategy for this round (see the resolution above).
            // AttestationConsensus reads ONLY this, never the live registry.
            pinnedConsensusStrategy: pinnedConsensusStrategy,
            // The allowlist that judges the winning proposal's meta has
            // to be the SAME block-anchored list this round pinned the fetch model
            // from. Judged against the live hotReloadable set instead, a governance
            // DELISTING of the pinned model made every honestly-served meta
            // unrecognized, mapping the round to no_quorum on every retry, so the
            // request could never finalize and expired despite successful provider
            // calls. A provider with no approved_models at this block travels as
            // null, leaving the live-set fallback exactly as it was.
            pinnedApprovedModels: approvedModels.length ? approvedModels.slice() : null,
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
    // CONSENSUS-CRITICAL: this rule exists in THREE copies that must apply it
    // identically or validation forks:
    //   1. here (AttestationRound._computeResponsibleSet)
    //   2. the indexer, xchain-indexer/src/actions/attest.js
    //   3. AttestationPublisher._computeResponsible (failover-rank derivation)
    // All three are behaviorally identical (hash-order sort, source===null keep
    // branch, redundancy slice with the SAME Math.max(1, Number(redundancy) || 1)
    // normalization). A FOURTH copy exists for the reorg recompute of missed_count:
    // xchain-indexer/src/rollback.js _responsibleSet, which mirrors attest.js.
    // Any silent change to one copy is a fork surface; always update all four together.
    //
    // All four now run the SAME canonical vectors
    // (xchain-documentation/protocol/test-vectors/responsible_set.json): copies 1 and 3
    // in AttestationRound.test.js, copies 2 and 4 in the indexer's
    // test/unit/actions/attest-responsible-set-vectors.test.js. Add a vector there when
    // you change the rule, or the copies can drift in a direction every suite calls green.
    //
    // PROVIDER STAKE FLOOR (weighted only): `minStake` is the request
    // provider's block-anchored min_stake_xchain. Sources whose aggregate weight is
    // below it are dropped BEFORE the ranking, so the freed slot goes to the next
    // qualifying validator rather than shrinking the set. Only the weighted snapshot
    // carries the source-aggregate `weight` the floor is defined against, which is why
    // the floor rides the STAKE_WEIGHTED_QUORUM anchor instead of minting its own
    // flag-day height. Below the gate the capability threshold stays the only bar.
    _computeResponsibleSet(validators, requestId, redundancy, weighted, minStake){
        if(weighted)
            validators = validators.filter(v => this._meetsProviderFloor(v && v.weight, minStake));
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

    // CONSENSUS-CRITICAL predicate: does a weighted-snapshot row clear the provider
    // floor? `weight` is the row's SOURCE-AGGREGATE stake (every effective key of a
    // source carries the same weight), so the bar is on the staking address, not on
    // each delegated key: a source cannot clear a 25000 floor by splitting 25000
    // across five keys, and does not have to stake 25000 per key.
    //
    // An unusable weight or an unusable floor EXCLUDES the row. Excluding is the safe
    // direction (it can only shrink the responsible set, which the caller's
    // unfinalizable-round guard already handles) and it is what keeps the rule
    // writable identically in every copy. Byte-mirrors
    // xchain-indexer/src/attestation/providerMinStakeHistory.js meetsProviderFloor,
    // down to the strict decimal-string acceptance and the decimal.js `.gte()`
    // comparison (bcmath.js bcgte), which is exact where mathjs's largerEq applies a
    // ~1e-12 epsilon; a consensus predicate that rounds is a fork surface.
    _meetsProviderFloor(weight, minStake){
        const usable = (v) => {
            if(v === null || v === undefined || typeof v === 'boolean') return null;
            let s = String(v).trim();
            return /^\d+(\.\d+)?$/.test(s) ? s : null;
        };
        let floor = usable(minStake);
        if(floor === null) return false;
        let w = usable(weight);
        if(w === null) return false;
        return bc.bcgte(w, floor);
    }

    // Look up the round state for a given requestId. Accessor over this.rounds;
    // AttestationConsensus copies responsible/leaderPubkey into `pending` at
    // propose() time and never re-consults this map, so no consensus path calls
    // this. Currently exercised only by AttestationRound's unit tests.
    getRoundState(requestId){
        return this.rounds.get(String(requestId).toLowerCase()) || null;
    }

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
            failed_count:    failed
        };
        // Expose the non-ok publication-throttle ring health so an
        // undersized ATTESTATION_NONOK_PUBLISHED_MAX (evictions of entries
        // whose requests are still pending) is operator-visible.
        if(this.consensus){
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
        return stats;
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
