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
const wid    = require('./attest_responsible_widening_activation.js');
// The zero-confirmation flag day. Selects the effective confirmation count for a
// request (confirmationsFor) and carries the boot-time ordering assertion the
// constructor runs; keyed on the REQUEST's own block, never on the tip.
const zc     = require('./attest_zero_conf_activation.js');
// The leader-rotation silent-slot skip flag day. Keyed on the REQUEST's own block
// like the two above, so every hub flips the leader arithmetic on the same request
// rather than on whichever tip it happened to poll.
const lss    = require('./attest_leader_silence_skip_activation.js');
// The consensus round-timeout default the seen-window floor below is keyed to.
// Required, never re-spelled: see the constant's own note in constants.js.
// SUPPORTED_CONSENSUS_STRATEGIES is the admission allowlist _startRound declines an
// unrecognised block-anchored strategy against; shared with the dispatch sites it names.
const { DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS, SUPPORTED_CONSENSUS_STRATEGIES } = require('./constants.js');
const { positiveIntConfig } = require('./lib/config_int.js');

const ATTEST_PROPOSE = 'ATTEST_PROPOSE';

// How often to poll the indexer for new pending requests. 3 s, not the historical
// 15 s: above ATTEST_ZERO_CONF_ACTIVATION the hub serves a request at the tip it
// was mined at, so this interval IS the floor on how long a contract waits for its
// response, and a 15 s floor dominated the whole mined-to-mirrored budget. Two
// indexer queries per poll (the tip read and the pending page), so a five-hub
// federation costs about 3.3 queries a second fleet-wide.
const DEFAULT_POLL_MS         = 3000;
const DEFAULT_CONFIRMATIONS   = 3;      // BTC blocks of confirmation before initiating fetch (spec §14)
// ms: provider fetch timeout. 20 s, not the historical 10 s (operator ruling
// 2026-09-11): a slow-but-healthy provider fetch that crossed 10 s aborted here and
// left the round with fewer independent bodies than its redundancy asked for, which
// byte_equality reads as a no_quorum rather than as a slow vendor. 20 s still sits an
// order of magnitude under DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS, so the round timer
// remains the terminal backstop. AttestationConsensus bounds the judge call with the
// same key and must carry the same literal; the two are read on separate paths.
const DEFAULT_FETCH_TIMEOUT   = 20000;
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

        // Leader-silence observation, keyed by requestId. One entry per request
        // this hub has run a round for:
        //   { silent: Set<pubkey>, watchPubkey, watchBlock,
        //     heldLogged: bool, updatedAt: ms }
        // It has to live HERE rather than on a round or a consensus `pending`,
        // because both of those are torn down and rebuilt on every retry while the
        // question it answers ("has this member ever spoken for this request?")
        // spans the request's whole life. Evicted on the `rounds` TTL.
        this.leaderSilence = new Map();

        // Keyset cursor for paging through pending requests across poll cycles.
        // null = start a fresh sweep from the oldest pending request.
        this.pollCursor = null;

        // The BTC tip the last successful poll reported, as
        // { blockHeight, observedAt (ms) }, or null before the first one. Every hub
        // that runs rounds polls a Bitcoin indexer, so this is a BTC height every
        // attestation validator holds; the batch publisher anchors on it when no
        // indexer has pushed a chain_tips row to this hub, which on a federation
        // that shares one Bitcoin indexer is every hub but the one it pushes to.
        this.observedTip = null;

        // AttestationConsensus instance; set via setConsensus after creation
        this.consensus = null;

        this._pollTimer      = null;
        // In-flight guard for the interval-driven poll. Matches the
        // house convention (XChainIndexer _hubConfigPollRunning, XChainDecoder
        // mempoolBusy, HubPushQueue draining): a poll that outruns pollMs under a
        // slow/partitioned indexer or a tightened ATTESTATION_POLL_MS must not
        // stack a second concurrent _pollPending that races this.pollCursor.
        this._pollRunning    = false;

        // positiveIntConfig, not `parseInt(cfg) || DEFAULT`, for the reason
        // AttestationConsensus states over its own ring caps: a negative is TRUTHY, so
        // it survives the `||` fallback and silently inverts the gate it sizes. A
        // negative ATTESTATION_CONFIRMATIONS makes `block_index + confirmations >
        // latestBlock` false below spec §14 depth, so this hub pays for fetches on
        // requests the federation still considers reorg-able; a negative POLL_MS or
        // FETCH_TIMEOUT collapses the poll cadence and the fetch budget the same way.
        // Zero and garbage already fell back, so this changes nothing an operator can
        // configure today except that a negative now warns and falls back too.
        this.pollMs         = positiveIntConfig(this.config.ATTESTATION_POLL_MS,       DEFAULT_POLL_MS,       'ATTESTATION_POLL_MS');
        this.confirmations  = positiveIntConfig(this.config.ATTESTATION_CONFIRMATIONS, DEFAULT_CONFIRMATIONS, 'ATTESTATION_CONFIRMATIONS');
        this.fetchTimeoutMs = positiveIntConfig(this.config.ATTESTATION_FETCH_TIMEOUT, DEFAULT_FETCH_TIMEOUT, 'ATTESTATION_FETCH_TIMEOUT');
        // Blocks of leader silence before the round leader rotates one slot down
        // the responsible set (and the model-fallback ladder advances; both are
        // pure functions of chain height, see attestation_escalation.js).
        this.leaderRotationBlocks = positiveIntConfig(this.config.ATTESTATION_LEADER_ROTATION_BLOCKS,
            esc.DEFAULT_ROTATION_WINDOW_BLOCKS, 'ATTESTATION_LEADER_ROTATION_BLOCKS');
        // How long a request stays in `seen` before it can be re-evaluated.
        // Defaults to 5 poll cycles so transient skips clear quickly while
        // still suppressing the steady-state re-poll of confirmed work.
        //
        // Floor it above the consensus round timeout. The seen window
        // must never nest inside a LIVE consensus round: if it evicts first, the
        // next poll re-`_startRound`s a request whose round is still pending and
        // issues another paid provider fetch that consensus.propose() then discards
        // on its `pending.has(rid)` guard. At stock defaults 5*3s=15s is far shorter
        // than the 120s round timeout, so it is the Math.max floor below that binds
        // and the effective window is 120s+3s=123s; lowering ATTESTATION_POLL_MS
        // widens the gap silently. Sourcing the round timeout from the same config
        // key AND the same shared default AttestationConsensus reads keeps the two
        // windows coupled on both paths; a re-spelled literal here coupled them only
        // while the two copies happened to be equal, so raising the consensus default
        // one-sidedly re-nested the window on any hub with no explicit key. The paid
        // fetch is also short-circuited directly in _startRound via
        // consensus.isRoundActive(), but flooring closes the nesting at its root.
        // The floor is only as strong as the weaker of the two parses: a negative
        // ATTESTATION_ROUND_TIMEOUT_MS survived `||` here and in the consensus copy,
        // collapsing this Math.max to 5*pollMs while every round died on the next tick,
        // which is the paid-duplicate-fetch nesting the paragraph above closes.
        let roundTimeoutMs  = positiveIntConfig(this.config.ATTESTATION_ROUND_TIMEOUT_MS,
            DEFAULT_ATTESTATION_ROUND_TIMEOUT_MS, 'ATTESTATION_ROUND_TIMEOUT_MS');
        this.retryAfterMs   = Math.max(
            positiveIntConfig(this.config.ATTESTATION_RETRY_AFTER_MS, 5 * this.pollMs, 'ATTESTATION_RETRY_AFTER_MS'),
            roundTimeoutMs + this.pollMs
        );
        // How long a `rounds` entry is retained before lazy eviction. A round's
        // active lifecycle is ~2 min (consensus round timeout), so the 1-hour
        // default leaves a wide safety margin while bounding memory. Without
        // this the Map grew monotonically with lifetime request volume (it was
        // only ever cleared on stop()).
        this.roundsTtlMs    = parseInt(this.config.ATTESTATION_ROUND_TTL_MS)   || (60 * 60 * 1000);

        // Fetch accounting, monotonic for the process life and reported by getStats.
        // No fetch counter existed anywhere before: the durable fetch cache's whole
        // purpose is to keep a restart from re-paying a provider, and nothing made
        // "did this hub pay once or twice for this request" observable. Consumers
        // alert on a rise in fetchCount without a matching request, and read
        // fetchCacheHitCount as the cache doing its job.
        this.fetchCount         = 0;   // provider calls this process actually issued
        this.fetchCacheHitCount = 0;   // rounds served from the durable cache instead
        this.finalizedSkipCount = 0;   // re-polls refused on the finalized ring before any fetch

        // Poll-rejection accounting (item 7650). An indexer that answers HTTP 200 with a
        // JSON-RPC error - an unknown method on an incompatible build is the shape that
        // costs the most - never reaches the catch above that logs transport failures, so
        // without this counter the quieter failure leaves the poll in silence: no counter
        // moves, no line is written, and every counter below stays frozen at its last
        // value while the request feed admits nothing. Monotonic for the
        // process life for the same reason fetchCount is: consumers alert on a rise, and
        // a restart is exactly when the evicting maps are empty.
        this.pollRpcErrorCount = 0;
        // Timestamp of the last poll whose JSON-RPC result was usable. Null until one
        // succeeds, which is also the observer-only steady state, so getStats reports the
        // age as null rather than as a huge number that reads like a stall.
        this.lastPollOkAt      = null;
        // Warn throttle for the above. A broken indexer is broken on every tick, and at
        // the default cadence that is a line every few seconds forever; log the first
        // occurrence and then at most one per pollMs-scaled window.
        this._pollRpcWarnAt    = 0;

        // Boot-time ordering assertion for the zero-confirmation flag day (spec
        // §3.2 a): zero-conf must sit at or above both the mirror and the widening
        // heights, or a request between the heights is served at the tip under rules
        // that still expect the wait, with no headroom behind it. Throws on mainnet
        // and testnet, warns on regtest and standalone; a hub with no network string
        // is standalone and the seam returns without a word. Deliberately NOT caught:
        // a misordered map is a consensus misconfiguration and must stop the boot.
        zc.assertZeroConfOrdering(this.hub && this.hub.network ? this.hub.network : '');
    }

    // The confirmation depth this hub waits before it starts a round for a request
    // admitted at `requestBlock`. Above ATTEST_ZERO_CONF_ACTIVATION it is 0: the hub
    // serves the request the block it is mined in (operator ruling 2026-09-07; the
    // provider spend on a request that later reorgs is an accepted cost of business).
    // Below it, it is the operator's legacy-era ATTESTATION_CONFIRMATIONS tunable.
    //
    // Keyed on the REQUEST's own block rather than the tip, so the rule for a given
    // request is fixed the moment it is admitted and cannot move under it mid-window.
    // Every site that shapes what a peer sees must read THIS and not this.confirmations:
    // the effective count feeds the leader slot and the model index, and two hubs that
    // disagree on it elect different leaders and fetch with different models, which
    // stalls the round on the equivalence check.
    confirmationsFor(requestBlock){
        return zc.isZeroConfActive(requestBlock, this.hub ? this.hub.network : undefined)
            ? 0
            : this.confirmations;
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
        this.leaderSilence.clear();
        this.pollCursor = null;
        this.observedTip = null;
        this._pollRunning = false;
    }

    // The BTC tip the last successful poll reported, or null. A copy, so a reader
    // cannot move the round's own record.
    getObservedBtcTip(){
        return this.observedTip ? Object.assign({}, this.observedTip) : null;
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

        // Same TTL, same reason, for the per-request leader-silence observation.
        this._evictStaleLeaderSilence();

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
        if(!result || result.error){
            // The indexer answered, so nothing above catches this: an HTTP-200 JSON-RPC
            // rejection (top-level error with no result, or an error nested in the
            // result) would otherwise return in silence. Count it and say so, leaving the
            // early return, the cursor and the in-flight guard untouched: this is
            // instrumentation, not a behaviour change, and no request may be admitted on
            // an error response. Detail wording follows CapabilitySnapshot.rpcErrorDetail:
            // the useful part is WHICH of the two cases happened.
            this.pollRpcErrorCount++;
            let now    = Date.now();
            let detail = !result
                ? 'no JSON-RPC result (empty or non-JSON body)'
                : 'a JSON-RPC error: ' + String((result.error && (result.error.message || result.error))).slice(0, 200);
            if(this._pollRpcWarnAt === 0 || now - this._pollRpcWarnAt >= this.pollMs){
                this._pollRpcWarnAt = now;
                console.warn('AttestationRound: getpendingattestation_requests returned ' + detail +
                    ' from BTC indexer at ' + url + ' - no attestation requests are being admitted' +
                    ' (rejections so far: ' + this.pollRpcErrorCount + ')');
            }
            return;
        }
        this.lastPollOkAt = Date.now();
        let latestBlock = Number(result.latest_block_index) || 0;
        let requests    = result.requests || [];
        if(latestBlock > 0) this.observedTip = { blockHeight: latestBlock, observedAt: Date.now() };

        for(let req of requests){
            let rid = String(req.request_id || '').toLowerCase();
            if(!rid || this.seen.has(rid)) continue;

            // Wait CONFIRMATIONS blocks past the request's tx before initiating
            // any external API call (spec §14; avoids paying for reorg'd work).
            // Above the zero-conf flag day the effective count is 0 and the request
            // is eligible in the block it was mined in; confirmationsFor takes the
            // REQUEST's block, which is the same height the ladders below key on.
            if(Number(req.block_index) + this.confirmationsFor(req.block_index) > latestBlock) continue;

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

    _evictStaleLeaderSilence(){
        let cutoff = Date.now() - this.roundsTtlMs;
        for(let [rid, rec] of this.leaderSilence){
            if(rec && typeof rec.updatedAt === 'number' && rec.updatedAt < cutoff){
                this.leaderSilence.delete(rid);
            }
        }
    }

    // The EFFECTIVE leader for this poll: the escalation ladder's slot, with
    // slots whose member this hub has proven silent stepped over.
    //
    // WHY A SKIP RATHER THAN A STOP (ledger P60, measured on testnet4). The bare
    // ladder caps at MAX_LEADER_ROTATIONS and never wraps, so for a request at
    // block R the slot froze at 3 from R+9 onward. A frozen slot holding a member
    // that never sends a PROPOSE is terminal: with no leader proposal,
    // AttestationConsensus._resolveRoundEffectiveTime falls back to each hub's own
    // wall clock, the hubs stamp tens of seconds apart, no two PREPAREs share a
    // canonical, and the round times out on every retry for the rest of the
    // request's life (request 233: 28 consecutive rounds at leaderSlot=3 with
    // every llm-capable hub seated and proposing status=ok).
    //
    // Silence is OBSERVED here and never derived, which is what keeps the
    // arithmetic in attestation_escalation.js pure: a member is proven silent only
    // once it has held the slot for a full rotation window of chain time with no
    // PROPOSE from it for this request. A silent key sends nothing to ANY hub, so
    // every hub reaches the same set from its own local observation; a hub that
    // gets there a window later runs the pre-skip ladder for one more poll, which
    // is the same transient skew the escalation module's header already tolerates.
    //
    // GATED on attest_leader_silence_skip_activation.js, keyed on `requestBlock`
    // (the request's own block_index, the same anchor the widening and zero-conf
    // gates use). Below the height this returns the bare spec §8.2 ladder and
    // touches nothing else: no silent set is consulted, no watch is armed and no
    // skip warning is emitted, so a mixed-version fleet cannot disagree about the
    // leader of a request admitted below the flag day. `esc.leaderIndex` is the
    // empty-observation case of `esc.effectiveLeaderSlot`, which is what makes the
    // gated-off path the pre-skip result rather than a reimplementation of it.
    //
    // `latestBlock` is the poll's indexer tip and `step` the ladder step already
    // derived from it. Returns { index, pubkey } for the slot the round should run.
    _resolveLeader(rid, responsible, step, latestBlock, requestBlock){
        let pubkeyOf = (i) => (responsible[i] ? responsible[i].pubkey : (responsible[0] ? responsible[0].pubkey : null));

        if(!lss.isLeaderSilenceSkipActive(requestBlock, this.hub ? this.hub.network : undefined)){
            let plain = esc.leaderIndex(step, responsible.length);
            return { index: plain, pubkey: pubkeyOf(plain) };
        }

        let rec = this.leaderSilence.get(rid);
        if(!rec){
            rec = { silent: new Set(), watchPubkey: null, watchBlock: null, heldLogged: false, updatedAt: 0 };
            this.leaderSilence.set(rid, rec);
        }
        rec.updatedAt = Date.now();

        // Slot indices are recomputed from pubkeys on every call: the responsible
        // set can widen mid-request (attest_responsible_widening_activation.js), so
        // a slot NUMBER is not stable across polls while the pubkey in it is.
        let silentSlots = () => {
            let s = new Set();
            for(let i = 0; i < responsible.length; i++){
                if(rec.silent.has(responsible[i].pubkey)) s.add(i);
            }
            return s;
        };
        let idx    = esc.effectiveLeaderSlot(step, responsible.length, silentSlots());
        let pubkey = pubkeyOf(idx);

        // Has this member proposed for this request at any point, across every
        // retry round? Consensus owns that record because it owns the PROPOSE
        // wire; typeof-guarded so a hub wired to a consensus without the accessor
        // simply never skips, i.e. degrades to the pre-skip ladder.
        let hasProposed = (pk) => !!(pk && this.consensus
            && typeof this.consensus.hasProposedFor === 'function'
            && this.consensus.hasProposedFor(rid, pk));

        if(pubkey && rec.watchPubkey === pubkey && !hasProposed(pubkey)
           && esc.isProvenSilent(latestBlock, rec.watchBlock, this.leaderRotationBlocks)){
            rec.silent.add(pubkey);
            console.warn('AttestationRound: leader slot ' + idx + ' skipped for ' + rid.substring(0,16) +
                         '... (' + pubkey.substring(0,16) + '... held the slot from block ' + rec.watchBlock +
                         ' to ' + latestBlock + ' with no PROPOSE for this request; the skip does not spend a rotation)');
            let skippedIdx = idx;
            idx    = esc.effectiveLeaderSlot(step, responsible.length, silentSlots());
            pubkey = pubkeyOf(idx);

            // Rule: when no live slot remains AHEAD, the ladder holds the last live
            // slot it reached instead of running off the end. The tell is that the
            // walk could not get past the slot just proven silent. Say so once per
            // request, so an operator reading a stalled request sees the fleet is
            // out of leaders rather than that rotation quietly stopped working.
            if(idx <= skippedIdx && !rec.heldLogged){
                rec.heldLogged = true;
                console.warn('AttestationRound: no live leader slot remains for ' + rid.substring(0,16) +
                             '... (' + rec.silent.size + ' of ' + responsible.length +
                             ' responsible members proven silent); holding slot ' + idx);
            }
        }

        // Arm (or re-arm) the window on whoever holds the slot now. The watch
        // block is the height this hub FIRST saw this member holding it, so the
        // full-window test above measures a held slot rather than a poll gap.
        if(pubkey !== rec.watchPubkey){
            rec.watchPubkey = pubkey;
            rec.watchBlock  = Number(latestBlock);
        }
        return { index: idx, pubkey: pubkey };
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
        // RESPONSIBLE-SET WIDENING (spec §8.2 liveness ladder). A staked validator that
        // serves nothing keeps its slot forever, because the snapshot is drawn from stake
        // alone, so a set holding one dead member can never produce the `redundancy`
        // signatures finalization needs and the request burns its whole window. The set
        // therefore grows by one slot per segment of the request's own serviceable span.
        // Pure function of chain height and the request's own fields, on FROZEN constants
        // rather than this hub's tunables, so every hub and every indexer derive the same
        // widening; flag-day gated per network, and 0 below it, where this is byte-for-byte
        // the legacy fixed-REDUNDANCY selection. `needed` is untouched: widening grows the
        // pool permitted to sign, never the count required to finalize.
        let widen = Number.isFinite(Number(latestBlock)) && Number(latestBlock) > 0
            ? wid.widenSlots(Number(latestBlock), snapshotBlk, Number(request.deadline_block), this.hub.network)
            : 0;
        let responsible = this._computeResponsibleSet(snapshot.validators, rid, redundancy, weighted, providerFloor, widen);
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
        //
        // _resolveLeader layers the silent-slot skip (ledger P60) over that
        // arithmetic: the ladder stopping ON a mute member, rather than stepping
        // over it, is what pinned request 233 at leaderSlot=3 forever. The skip is
        // gated on the request's own block (attest_leader_silence_skip_activation.js),
        // so a request admitted below the flag day gets the bare ladder on every hub
        // whatever build it runs.
        let step = Number.isFinite(Number(latestBlock)) && Number(latestBlock) > 0
            ? esc.escalationStep(Number(latestBlock), snapshotBlk, this.confirmationsFor(snapshotBlk), this.leaderRotationBlocks)
            : 0;
        let leader       = this._resolveLeader(rid, responsible, step, latestBlock, snapshotBlk);
        let leaderIdx    = leader.index;
        let leaderPubkey = leader.pubkey;
        let amResponsible = responsible.some(v => v.pubkey === myPubkey);
        if(!amResponsible){
            // Not in the responsible set; log so operators can distinguish "saw and skipped" from "never polled".
            console.log('AttestationRound: skipping ' + rid.substring(0,16) + '... not responsible at block ' + snapshotBlk +
                        ' (snapshot=' + snapshot.validators.length + ', leader=' + (leaderPubkey ? leaderPubkey.substring(0,16) + '...' : 'none') + ')');
            return;
        }
        let amLeader = (leaderPubkey === myPubkey);

        // The round's opening line, one per started round on a responsible hub, and
        // the only place the EFFECTIVE confirmation count is visible: the boot line
        // reports the constructor's tunable, which has no request block to key on.
        // Format is pinned by the acceptance drill (spec §10 ZC1 greps for
        // `tip=<N> conf=0 widen=1`), so it is a contract, not a debug line.
        console.log('AttestationRound: starting ' + rid.substring(0,16) +
                    '... tip=' + latestBlock +
                    ' conf=' + this.confirmationsFor(snapshotBlk) +
                    ' widen=' + widen);

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
            ? esc.modelIndex(Number(latestBlock), snapshotBlk, this.confirmationsFor(snapshotBlk), Number(request.deadline_block), approvedModels.length)
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
        //
        // Fail closed on an UNSUPPORTED one for the same reason. The registry carries an
        // unrecognised name verbatim (ProviderRegistry.normalizeConsensusStrategy) so every
        // hub resolves the same value rather than walking back to an older strategy; this
        // gate is the half that then declines. Without it a non-empty unknown name is
        // truthy, pins, and reaches AttestationConsensus, whose dispatch is positive
        // equality against SUPPORTED_CONSENSUS_STRATEGIES only: the round would run the
        // byte_equality branches with the no_quorum self-derivation gate (items 2641/2579)
        // switched off, which is not a machine any peer runs. Checked HERE, before the
        // provider fetch, so a round this build cannot serve costs no vendor call.
        let pinnedConsensusStrategy = (this.providerRegistry && typeof this.providerRegistry.getConsensusStrategy === 'function')
            ? this.providerRegistry.getConsensusStrategy(providerId, snapshotBlk) : null;
        if(!pinnedConsensusStrategy){
            console.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... provider "' + providerId +
                         '" has no block-anchored consensus_strategy at block ' + snapshotBlk + ' (failing closed)');
            return;
        }
        if(SUPPORTED_CONSENSUS_STRATEGIES.indexOf(pinnedConsensusStrategy) === -1){
            console.warn('AttestationRound: skipping ' + rid.substring(0,16) + '... provider "' + providerId +
                         '" has unsupported consensus_strategy "' + pinnedConsensusStrategy + '" at block ' + snapshotBlk +
                         ' (failing closed; this build implements ' + SUPPORTED_CONSENSUS_STRATEGIES.join(', ') + ')');
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
        // The same short-circuit for a round this hub already FINALIZED. The
        // request stays pending on the indexer until its callback binds, at
        // least one block later, which outlives both `seen` and the durable
        // cache (retryAfterMs), so a re-poll in that window must be refused
        // here rather than by propose()'s ring check after the provider is paid.
        if(this.consensus && typeof this.consensus.isFinalized === 'function' && this.consensus.isFinalized(rid)){
            this.finalizedSkipCount++;
            console.log('AttestationRound: skipping fetch for ' + rid.substring(0,16) + '... (already finalized; awaiting bind)');
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
            this.fetchCacheHitCount++;
            console.log('AttestationRound: reusing recorded fetch for ' + rid.substring(0,16) +
                        '... (status=' + myStatus + '); no provider call issued');
        } else {
            // Counted BEFORE the call, not after it: a fetch that throws may still
            // have reached the provider and cost money, and the number this exposes
            // is "what did this hub spend", not "what came back".
            this.fetchCount++;
            try {
                fetched = await providerModule.fetch(request.payload, {
                    maxResponseBytes: providerDef.max_response_bytes,
                    timeoutMs:        this.fetchTimeoutMs,
                    pinnedModel:      pinnedFetchModel,
                    // Block-anchored model->vendor map for the pinned id.
                    pinnedVendors:    pinnedVendors,
                    // Rank of the pinned model on the fallback ladder; providers
                    // enforce request-level fallback policy on it (llm 'strict').
                    modelRank:        modelIdx,
                    // This hub's api.js-validated HUB_NETWORK. http_get gates its
                    // private-address escape hatch on it, and the e2e harness runs
                    // several hubs in one process, where process.env cannot tell
                    // them apart.
                    network:          this.hub.network
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
    // `widen` is the liveness ladder's extra slot count for the current chain height
    // (attest_responsible_widening_activation.js), 0 below its flag-day and on an unratified
    // network, where this routine is byte-for-byte its pre-widening self.
    _computeResponsibleSet(validators, requestId, redundancy, weighted, minStake, widen){
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
        let extra = Number(widen);
        if(!Number.isFinite(extra) || extra < 0) extra = 0;
        return withHash.slice(0, Math.max(1, redundancy) + extra);
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
