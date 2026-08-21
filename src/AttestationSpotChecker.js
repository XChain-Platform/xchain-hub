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
 * XChain Hub - Attestation Spot-Checker
 *
 * Privately holds the expected-response patterns for synthetic
 * ATTEST v0 (request) rows that the platform injects to verify validator
 * honesty. Validators don't know which requests are spot-checks (the
 * pattern is only known to the platform).
 *
 * When AttestationConsensus finalizes a round, this module looks up
 * whether the request_id is a spot-check; if so, it runs the provider's
 * judge_model comparator over the published response and the expected
 * pattern. A failed match accumulates in a rolling 24h window per
 * signing validator. Crossing the failure threshold records a slash
 * proposal via SlashDetector.
 *
 * Phase 4 quality enforcement ships three pieces here:
 *
 *   1. Spot-check scheduler. On `SPOT_CHECK_INTERVAL_MS` (default 1h) the
 *      scheduler walks a platform-private corpus of prompts whose answers
 *      the platform already knows, and asks its `injector` to emit each as
 *      an on-chain ATTEST v0 (request). The returned request_id is
 *      auto-registered as a spot-check, so its finalization is judged like
 *      any other. The injector is a pluggable dependency
 *      (`hub.spotCheckInjector`): production wires it to the encoder path
 *      that broadcasts a request from a funded platform address; tests pass
 *      a fake. The scheduler is inert until `SPOT_CHECK_ENABLED` is set AND
 *      an injector AND a non-empty corpus are present (deliberately off by
 *      default so no fleet emits synthetic traffic without operator opt-in).
 *
 *   2. Slash-conversion. A judged-wrong spot-check accrues a failure
 *      against every signing validator; crossing the threshold in the
 *      rolling window records a slash proposal via SlashDetector, which
 *      SlashGovernance mediates into a federation-wide penalty.
 *
 *   3. Reorg-safe validator stats. Every judged outcome (pass or fail) is
 *      persisted to `attestation_validator_stats`, keyed by the request's
 *      creation block. A confirmed reorg (`reorgHandler` 'reorg:confirmed')
 *      deletes rows for orphaned blocks and clears the in-memory failure
 *      window, so a validator is never slashed on evidence from a block
 *      that no longer exists. Persistence is best-effort: with no DB the
 *      module still runs on its in-memory window (single-node / tests).
 *
 ********************************************************************/

'use strict';

const DEFAULT_FAILURE_WINDOW_MS   = 24 * 60 * 60 * 1000;  // 24h per spec §8.1
const DEFAULT_FAILURE_THRESHOLD   = 3;
const MAX_HISTORY_PER_VALIDATOR   = 64;
const MAX_QUEUE_SIZE              = 1024;
const DEFAULT_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;    // 1h between injection ticks
const DEFAULT_MAX_INJECTIONS_PER_TICK = 1;
const STATS_TABLE                = 'attestation_validator_stats';

// Retention window for the durable spot-check outcome table. One row lands per
// judged (validator, request) and nothing but the reorg rollback ever deleted one,
// so the table grew for the life of the deployment while every sibling hub audit
// table carries an explicit window (telemetry_pings, oracle_submissions,
// oracle_published_rounds, attest_published_requests). 90 days matches
// attest_published_requests, the closest sibling. 0 disables the sweep.
const DEFAULT_STATS_RETENTION_MS  = 90 * 24 * 60 * 60 * 1000;
// The prune has nothing new to do for hours after it runs, and the DELETE scans on
// checked_at, so throttle it rather than running it on every judged outcome.
const STATS_SWEEP_MIN_INTERVAL_MS = 60 * 60 * 1000;

// Re-judge queue. An ok finalization is TERMINAL: onRequestFinalized
// deletes the queue entry before judging, so a judge that could not answer used
// to drop the spot-check permanently and no later event re-triggered it. These
// bound the recovery queue that now holds those cases until the judge answers.
const MAX_PENDING_REJUDGE        = 256;
const REJUDGE_MAX_ATTEMPTS       = 5;
const DEFAULT_REJUDGE_MAX_AGE_MS = 30 * 60 * 1000;       // 30m, then give up and drop
const DEFAULT_REJUDGE_SWEEP_MS   = 5 * 60 * 1000;        // 5m between re-judge passes

// Which inconclusive reasons can change on a later attempt. Only a reason whose
// cause is the JUDGE being unavailable is retried: the provider is paused
// (llm.js _markInconclusive 'provider_paused') or its endpoint is unreachable.
// Every other reason is a property of the round's own bytes (meta_unrecognized,
// meta_uncorroborated, no_proposals, unparseable, empty_verdict, truncated_pick)
// so re-asking returns the same neutral verdict; those keep today's drop.
const TRANSIENT_INCONCLUSIVE = ['provider_paused', 'unreachable'];

class AttestationSpotChecker {

    constructor(hub, providerRegistry){
        this.hub              = hub;
        this.providerRegistry = providerRegistry;

        let cfg = hub.p2pConfig || {};
        this.failureWindowMs  = parseInt(cfg.SPOT_CHECK_FAILURE_WINDOW_MS) || DEFAULT_FAILURE_WINDOW_MS;
        this.failureThreshold = parseInt(cfg.SPOT_CHECK_FAILURE_THRESHOLD) || DEFAULT_FAILURE_THRESHOLD;

        // Scheduler config (see header). Off unless SPOT_CHECK_ENABLED is set.
        this.schedulerEnabled = this._isTruthy(cfg.SPOT_CHECK_ENABLED);
        this.intervalMs       = parseInt(cfg.SPOT_CHECK_INTERVAL_MS) || DEFAULT_SCHEDULER_INTERVAL_MS;
        this.maxPerTick       = parseInt(cfg.SPOT_CHECK_MAX_PER_TICK) || DEFAULT_MAX_INJECTIONS_PER_TICK;
        this.corpus           = this._parseCorpus(cfg.SPOT_CHECK_CORPUS);
        this._corpusCursor    = 0;
        this._injectedCount   = 0;

        // Pluggable on-chain request emitter: async ({providerId, prompt,
        // expectedPattern}) => { requestId } (or a bare request_id string).
        this._injector = (typeof hub.spotCheckInjector === 'function')
            ? hub.spotCheckInjector.bind(hub)
            : null;

        // Active spot-check entries: Map<requestIdLower, { providerId, expectedPattern, registeredAt }>
        this._queue = new Map();

        // Per-validator failure history: Map<pubkeyLower, [{ requestId, timestamp }]>
        this._failures = new Map();

        // Spot-checks whose judge was unavailable, held for re-judging.
        // Map<requestIdLower, { providerId, expectedPattern, publishedBody, meta,
        //                       signatures, blockIndex, attempts, firstSeen }>
        this._pendingReJudge = new Map();
        this.rejudgeSweepMs  = parseInt(cfg.SPOT_CHECK_REJUDGE_SWEEP_MS)  || DEFAULT_REJUDGE_SWEEP_MS;
        this.rejudgeMaxAgeMs = parseInt(cfg.SPOT_CHECK_REJUDGE_MAX_AGE_MS) || DEFAULT_REJUDGE_MAX_AGE_MS;

        this._messageHandler = null;
        this._reorgHandler   = null;
        this._scheduler      = null;
        this._sweeper        = null;
        this._tickInFlight   = false;   // scheduler self-overlap guard, see _schedulerTick()
        this._sweepInFlight  = false;   // same guard for the re-judge sweep

        // Durable-outcome retention, see _pruneStats(). 0 (explicitly configured)
        // disables the sweep; anything unparseable or negative falls back to the
        // default rather than silently disabling it.
        this.statsRetentionMs = parseInt(cfg.SPOT_CHECK_STATS_RETENTION_MS);
        if (!Number.isFinite(this.statsRetentionMs) || this.statsRetentionMs < 0) {
            this.statsRetentionMs = DEFAULT_STATS_RETENTION_MS;
        }
        this.statsPruned   = 0;      // lifetime outcome rows deleted by the sweep
        this._statsSweptAt = 0;      // throttle stamp; 0 means the first write sweeps
        this._statsSweep   = null;   // in-flight handle: fire-and-forget, so this is
                                     // what makes it awaitable in tests
    }

    _isTruthy(v){
        if (v === true) return true;
        let s = String(v == null ? '' : v).trim().toLowerCase();
        return s === '1' || s === 'true' || s === 'yes' || s === 'on';
    }

    // Accepts a JSON string or an array of { providerId|provider_id, prompt,
    // expectedPattern|expected } entries. Silently drops malformed entries so a
    // bad governance config can never crash the scheduler.
    _parseCorpus(raw){
        let arr = raw;
        if (typeof raw === 'string') {
            try { arr = JSON.parse(raw); } catch (e) { arr = []; }
        }
        if (!Array.isArray(arr)) return [];
        let out = [];
        for (let e of arr) {
            if (!e || typeof e !== 'object') continue;
            let providerId = String(e.providerId || e.provider_id || '');
            let prompt     = e.prompt != null ? String(e.prompt) : '';
            let expected   = String(e.expectedPattern != null ? e.expectedPattern : (e.expected != null ? e.expected : ''));
            if (!providerId || !prompt) continue;
            out.push({ providerId, prompt, expectedPattern: expected });
        }
        return out;
    }

    // Wire to AttestationConsensus.start() flow. The hub calls start() after
    // attestationConsensus exists.
    async start(){
        // Reorg-safe stats: roll orphaned spot-checks back on a confirmed reorg,
        // independent of whether attestation consensus is running.
        let reorg = this.hub.reorgHandler;
        if (reorg && typeof reorg.on === 'function') {
            this._reorgHandler = (evt) => {
                let height = evt && (evt.reorgHeight != null ? evt.reorgHeight : evt.height);
                this.rollback(height).catch(err =>
                    console.warn('AttestationSpotChecker: rollback error: ' + (err && err.message ? err.message : err)));
            };
            reorg.on('reorg:confirmed', this._reorgHandler);
        }

        this._startReJudgeSweep();

        let consensus = this.hub.attestationConsensus;
        if (!consensus) {
            console.log('AttestationSpotChecker: no AttestationConsensus, skipping consensus wiring');
            this._startScheduler();
            return;
        }
        this._messageHandler = (event) => {
            this.onRequestFinalized(event).catch(err =>
                console.warn('AttestationSpotChecker: onRequestFinalized error: ' + (err && err.message ? err.message : err)));
        };
        consensus.on('request:finalized', this._messageHandler);
        console.log('AttestationSpotChecker started (window=' + this.failureWindowMs + 'ms, threshold=' + this.failureThreshold + ')');
        this._startScheduler();
    }

    // Start the injection scheduler when opted in and fully wired. Silent no-op
    // otherwise (the module still judges externally-registered spot-checks).
    _startScheduler(){
        if (this._scheduler) return;
        if (!this.schedulerEnabled) return;
        if (!this._injector) {
            console.log('AttestationSpotChecker: SPOT_CHECK_ENABLED but no injector wired; scheduler idle');
            return;
        }
        if (this.corpus.length === 0) {
            console.log('AttestationSpotChecker: SPOT_CHECK_ENABLED but corpus empty; scheduler idle');
            return;
        }
        this._scheduler = setInterval(() => {
            this._schedulerTick().catch(err =>
                console.warn('AttestationSpotChecker: scheduler tick error: ' + (err && err.message ? err.message : err)));
        }, this.intervalMs);
        if (this._scheduler.unref) this._scheduler.unref();  // never pin process liveness
        console.log('AttestationSpotChecker scheduler started (interval=' + this.intervalMs +
                    'ms, corpus=' + this.corpus.length + ', maxPerTick=' + this.maxPerTick + ')');
    }

    // One scheduler pass: inject up to maxPerTick synthetic requests, round-
    // robin over the corpus. Each injection is independently guarded so a single
    // provider/encoder failure cannot abort the batch or throw out of the timer.
    async _schedulerTick(){
        if (!this._injector || this.corpus.length === 0) return 0;
        // Scheduler self-overlap guard (house convention:
        // FullNodeChallengeRound._tick). The injector is an operator-supplied hook that
        // emits a real on-chain ATTEST v0 request, and nothing here bounds its round
        // trip, so a hung encoder/BTC send parks a tick until the socket dies and the
        // next interval fires on top of it. The backpressure test below cannot stop the
        // second tick: both read _queue before either registers anything, so injections
        // land past the headroom it reserves and evict LIVE entries (register() drops the
        // oldest, a real validator's pending spot-check, whose verdict then never scores),
        // and the fee-bearing batch runs at twice its configured rate. The finally is
        // load-bearing: only this timer ever clears the flag, so a throw out of the body
        // would wedge the scheduler for the process lifetime.
        if (this._tickInFlight) {
            console.warn('AttestationSpotChecker: injection tick still in flight; skipping this scheduler pass');
            return 0;
        }
        // Backpressure: leave headroom so injections never evict live entries.
        if (this._queue.size >= Math.floor(MAX_QUEUE_SIZE * 0.9)) {
            console.warn('AttestationSpotChecker: spot-check queue near capacity, skipping injection tick');
            return 0;
        }
        this._tickInFlight = true;
        try {
            let injected = 0;
            let n = Math.min(this.maxPerTick, this.corpus.length);
            for (let i = 0; i < n; i++) {
                let entry = this.corpus[this._corpusCursor % this.corpus.length];
                this._corpusCursor = (this._corpusCursor + 1) % this.corpus.length;
                try {
                    let res = await this._injector({
                        providerId:      entry.providerId,
                        prompt:          entry.prompt,
                        expectedPattern: entry.expectedPattern
                    });
                    let requestId = (res && (res.requestId || res.request_id))
                        || (typeof res === 'string' ? res : null);
                    if (!requestId) {
                        console.warn('AttestationSpotChecker: injector returned no request_id for provider ' + entry.providerId);
                        continue;
                    }
                    this.register(requestId, entry.providerId, entry.expectedPattern);
                    this._injectedCount++;
                    injected++;
                } catch (e) {
                    console.warn('AttestationSpotChecker: injection failed for provider ' + entry.providerId + ': ' +
                                 (e && e.message ? e.message : e));
                }
            }
            return injected;
        } finally {
            this._tickInFlight = false;
        }
    }

    // Drive the re-judge sweep on its own timer rather than folding it
    // into _schedulerTick. The injection scheduler is inert unless SPOT_CHECK_ENABLED
    // plus an injector plus a non-empty corpus are all present, and in exactly that
    // state the module still judges externally-registered spot-checks (see header),
    // so a sweep hung off the scheduler would never run for the deployments that
    // most need it. Unref'd, and a no-op pass over an empty map when nothing is held.
    _startReJudgeSweep(){
        if (this._sweeper) return;
        this._sweeper = setInterval(() => {
            this._sweepReJudge().catch(err =>
                console.warn('AttestationSpotChecker: re-judge sweep error: ' + (err && err.message ? err.message : err)));
        }, this.rejudgeSweepMs);
        if (this._sweeper.unref) this._sweeper.unref();
    }

    // Hold a spot-check whose judge could not answer, so a later sweep can score it.
    // Bounded: at capacity the OLDEST held record is dropped, matching register()'s
    // eviction rule, because an unbounded map here would cache response bodies for
    // the process lifetime.
    _deferReJudge(rid, record){
        if (this._pendingReJudge.size >= MAX_PENDING_REJUDGE) {
            let firstKey = this._pendingReJudge.keys().next().value;
            if (firstKey) this._pendingReJudge.delete(firstKey);
        }
        this._pendingReJudge.set(rid, record);
    }

    // One re-judge pass: re-ask the judge about every held spot-check and score the
    // ones that now have a conclusive verdict, through the same _persistStats /
    // _recordFailure paths the inline judge uses. Still-inconclusive records stay
    // until they run out of attempts or age out; each record is independently
    // guarded so one provider failure cannot abort the pass or throw out of the
    // timer. Overlap-guarded for the same reason _schedulerTick is: nothing
    // bounds a judge round trip, so a hung provider would otherwise let passes
    // stack up and re-ask the same records concurrently.
    async _sweepReJudge(){
        if (this._pendingReJudge.size === 0) return 0;
        if (this._sweepInFlight) return 0;
        this._sweepInFlight = true;
        try {
            let scored = 0;
            let now = Date.now();
            for (let [rid, rec] of Array.from(this._pendingReJudge.entries())) {
                if (now - rec.firstSeen > this.rejudgeMaxAgeMs || rec.attempts >= REJUDGE_MAX_ATTEMPTS) {
                    this._pendingReJudge.delete(rid);
                    console.warn('AttestationSpotChecker: giving up on deferred spot-check ' + rid.substring(0, 16) +
                                 '... after ' + rec.attempts + ' attempt(s); no evidence recorded');
                    continue;
                }
                rec.attempts++;
                let provider = this.providerRegistry && this.providerRegistry.getModule(rec.providerId);
                if (!provider || typeof provider.agree !== 'function') continue;
                let outcome = {};
                let verdict;
                try {
                    verdict = await Promise.resolve(provider.agree([
                        { body: rec.publishedBody, meta: rec.meta },
                        { body: Buffer.from(String(rec.expectedPattern || ''), 'utf8'), meta: rec.meta }
                    ], { outcome }));
                } catch (e) {
                    console.warn('AttestationSpotChecker: re-judge threw for ' + rid.substring(0, 16) + '...: ' +
                                 (e && e.message ? e.message : e));
                    continue;
                }
                if (!verdict && outcome.inconclusive) {
                    // Still could not judge. A reason that is no longer transient can
                    // never change, so stop holding the record rather than burning the
                    // remaining attempts on it.
                    if (TRANSIENT_INCONCLUSIVE.indexOf(String(outcome.reason)) < 0) {
                        this._pendingReJudge.delete(rid);
                        console.warn('AttestationSpotChecker: deferred spot-check ' + rid.substring(0, 16) +
                                     '... resolved inconclusive (reason=' + outcome.reason + '); no evidence recorded');
                    }
                    continue;
                }
                this._pendingReJudge.delete(rid);
                await this._scoreVerdict(rec.providerId, rid, rec.signatures, rec.blockIndex, !!verdict);
                scored++;
            }
            return scored;
        } finally {
            this._sweepInFlight = false;
        }
    }

    // The scoring half of a judged spot-check, shared by the inline judge in
    // onRequestFinalized and the re-judge sweep so the two can never drift.
    // Persists one row per signer (reorg-safe, keyed by the request's creation
    // block) and accrues a failure against every signer on a judged-wrong round.
    async _scoreVerdict(providerId, rid, signatures, blockIndex, passed){
        for (let s of (signatures || [])) {
            await this._persistStats(s.pubkey, providerId, rid, blockIndex, passed);
        }
        if (passed) return;
        console.warn('AttestationSpotChecker: failed spot-check on ' + rid.substring(0, 16) +
                     '... (provider=' + providerId + ', signers=' + (signatures || []).length + ')');
        for (let s of (signatures || [])) {
            this._recordFailure(s.pubkey, rid);
        }
    }

    async stop(){
        let consensus = this.hub.attestationConsensus;
        if (consensus && this._messageHandler) {
            consensus.removeListener('request:finalized', this._messageHandler);
            this._messageHandler = null;
        }
        let reorg = this.hub.reorgHandler;
        if (reorg && this._reorgHandler && typeof reorg.removeListener === 'function') {
            reorg.removeListener('reorg:confirmed', this._reorgHandler);
            this._reorgHandler = null;
        }
        if (this._scheduler) {
            clearInterval(this._scheduler);
            this._scheduler = null;
        }
        if (this._sweeper) {
            clearInterval(this._sweeper);
            this._sweeper = null;
        }
        this._queue.clear();
        this._failures.clear();
        this._pendingReJudge.clear();
    }

    // Register a synthetic request as a spot-check. Called by the
    // (future) injection scheduler immediately after the synthetic
    // ATTEST v0 (request) is broadcast. `expectedPattern` is the rubric
    // passed to the provider's judge step (string for now).
    register(requestId, providerId, expectedPattern){
        let rid = String(requestId || '').toLowerCase();
        if (!rid || !providerId) return;
        if (this._queue.size >= MAX_QUEUE_SIZE) {
            // Drop oldest by insertion order (Map preserves insertion order)
            let firstKey = this._queue.keys().next().value;
            if (firstKey) this._queue.delete(firstKey);
        }
        this._queue.set(rid, {
            providerId:      String(providerId),
            expectedPattern: String(expectedPattern || ''),
            registeredAt:    Date.now()
        });
    }

    // Check whether a request_id is being spot-checked.
    isSpotCheck(requestId){
        return this._queue.has(String(requestId || '').toLowerCase());
    }

    // Called via the consensus 'request:finalized' event. Looks up the
    // request_id; if it's a spot-check, runs the provider's judge over
    // the published response vs the expected pattern. Failures accrue
    // against each signing validator in a rolling window; crossing the
    // threshold records a slash proposal.
    //
    // event shape (from AttestationConsensus):
    //   { requestId, providerId, responseBody, status, meta, signatures: [{pubkey, sig}], leaderPubkey }
    async onRequestFinalized(event){
        if (!event || !event.requestId) return;
        let rid = String(event.requestId).toLowerCase();
        let entry = this._queue.get(rid);
        if (!entry) return;  // Not a spot-check

        // A non-ok finalization (Phase 4: provider_error / no_quorum) is an
        // honest outage report, not an answer; judging its empty body against
        // the expected pattern would charge spot-check failures to validators
        // for truthfully reporting downtime. Leave the queue entry in place:
        // the request is still pending on-chain and a later ok round (e.g.
        // after the model-fallback ladder advances) still gets checked.
        if (String(event.status || 'ok') !== 'ok') return;

        this._queue.delete(rid);

        if (entry.providerId !== event.providerId) {
            // Provider mismatch (almost certainly a bug at registration).
            // Treat as inconclusive rather than slash.
            console.warn('AttestationSpotChecker: provider mismatch on ' + rid.substring(0, 16) +
                         '... (registered=' + entry.providerId + ', finalized=' + event.providerId + ')');
            return;
        }

        let provider = this.providerRegistry && this.providerRegistry.getModule(entry.providerId);
        if (!provider || typeof provider.agree !== 'function') {
            console.warn('AttestationSpotChecker: no agree() on provider ' + entry.providerId + ': cannot judge spot-check');
            return;
        }

        // Use the provider's own agree() to compare published response
        // against expected pattern. For llm/judge_model this calls the
        // judge with a 2-candidate prompt; for byte_equality providers
        // it's a literal compare.
        let publishedBody = Buffer.isBuffer(event.responseBody)
            ? event.responseBody
            : Buffer.from(String(event.responseBody || ''), 'utf8');
        let expectedBody  = Buffer.from(String(entry.expectedPattern || ''), 'utf8');

        let blockIndex = Number(event.request && event.request.block_index) || 0;
        // Everything the sweep needs to re-ask the judge later. Built
        // before the call so both failure branches below can hand it straight to
        // _deferReJudge; the queue entry is already gone by this point (line above),
        // and an ok finalization is terminal, so this record is the only way back.
        let deferRecord = {
            providerId:      entry.providerId,
            expectedPattern: entry.expectedPattern,
            publishedBody:   publishedBody,
            meta:            String(event.meta || ''),
            signatures:      event.signatures || [],
            blockIndex:      blockIndex,
            attempts:        0,
            firstSeen:       Date.now()
        };

        let verdict;
        let outcome = {};
        try {
            verdict = await Promise.resolve(provider.agree([
                { body: publishedBody, meta: String(event.meta || '') },
                { body: expectedBody,  meta: String(event.meta || '') }
            ], { outcome }));
        } catch (e) {
            // A throw is a judge TRANSPORT failure, not a verdict about the round,
            // so hold it for re-judging rather than dropping the spot-check.
            console.warn('AttestationSpotChecker: judge call threw for %s...; deferred for re-judge:', rid.substring(0, 16), e);
            this._deferReJudge(rid, deferRecord);
            return;
        }

        if (!verdict && outcome.inconclusive && TRANSIENT_INCONCLUSIVE.indexOf(String(outcome.reason)) >= 0) {
            // The judge was unavailable (paused provider, unreachable endpoint), which
            // says nothing about the round. Dropping it here lost the check for good:
            // llm.js pauses deliberately, and no later consensus event re-judges a
            // finalized request. Hold it and let the sweep score it once the judge is
            // back. Still neutral in the meantime: no evidence is recorded either way.
            console.warn('AttestationSpotChecker: judge unavailable on ' + rid.substring(0, 16) +
                         '... (reason=' + outcome.reason + '); deferred for re-judge');
            this._deferReJudge(rid, deferRecord);
            return;
        }

        if (!verdict && outcome.inconclusive) {
            // The judge answered but could not reach a verdict (refusal, unparseable
            // output, unrecognized meta, or a truncated-candidate fail-closed pick).
            // That is neutral, not a failure: it must not accrue slash evidence
            // against the signers, matching every other inconclusive branch in this
            // method (lines above: non-ok finalization, provider mismatch). Unlike
            // the two branches directly above it is also FINAL: the reason is a
            // property of this round's own bytes, so re-asking cannot change it and
            // holding the record would only burn attempts.
            console.warn('AttestationSpotChecker: inconclusive judge verdict on ' + rid.substring(0, 16) +
                         '... (reason=' + outcome.reason + '); no evidence recorded');
            return;
        }

        // Reorg-safe record: persist the outcome for every signer, keyed by the
        // request's creation block so a reorg can roll it back. Best-effort; a
        // DB hiccup must not abort judging or throw out of the event handler.
        // A match clears nothing: failures accumulate over the window regardless
        // of intervening passes (per spec: 3 failures in 24h, not a streak).
        await this._scoreVerdict(entry.providerId, rid, event.signatures, blockIndex, !!verdict);
    }

    // Persist one judged spot-check outcome to attestation_validator_stats.
    // Idempotent per (validator, request). No-op when the hub has no DB
    // (single-node / unit tests run purely on the in-memory window).
    async _persistStats(pubkey, providerId, requestId, blockIndex, passed){
        if (!pubkey) return;
        let db = this.hub && this.hub.db;
        if (!db || typeof db.doQuery !== 'function') return;
        try {
            await db.doQuery(
                'INSERT INTO ' + STATS_TABLE +
                ' (validator_pubkey, provider_id, request_id, block_index, passed)' +
                ' VALUES (?, ?, ?, ?, ?)' +
                ' ON DUPLICATE KEY UPDATE passed = VALUES(passed),' +
                ' provider_id = VALUES(provider_id), block_index = VALUES(block_index)',
                [String(pubkey).toLowerCase(), String(providerId), String(requestId),
                 Number(blockIndex) || 0, passed ? 1 : 0]
            );
            // A row just landed, which is the only way this table ever grows, so this
            // is where the retention sweep belongs (same reasoning as the sibling
            // publishers' post-write sweeps). Throttled and fire-and-forget inside.
            this._sweepStatsRetention();
        } catch (e) {
            console.warn('AttestationSpotChecker: stats persist failed for ' +
                         String(pubkey).substring(0, 16) + '...: ' + (e && e.message ? e.message : e));
        }
    }

    // Bound the durable outcome table. Age-based, and computed in DB-clock arithmetic
    // on BOTH sides: checked_at is written by CURRENT_TIMESTAMP, so comparing it
    // against a Node-side timestamp would fold host/DB clock skew straight into the
    // cutoff. The window is floored at the rolling failure window, so a misconfigured
    // short retention can never delete a row inside the span the slash trigger reasons
    // over; at the 90-day default nothing reorg-reachable is anywhere near the cutoff,
    // which is why no block-height clamp is needed on top. Returns rows deleted.
    // Throws on a DB error, and the caller decides what that costs.
    async _pruneStats(){
        let db = this.hub && this.hub.db;
        if (!db || typeof db.doQuery !== 'function') return 0;
        if (!this.statsRetentionMs || this.statsRetentionMs <= 0) return 0;

        let windowSec = Math.ceil(Math.max(this.statsRetentionMs, this.failureWindowMs) / 1000);
        let res = await db.doQuery(
            'DELETE FROM ' + STATS_TABLE + ' WHERE checked_at < DATE_SUB(NOW(), INTERVAL ? SECOND)',
            [windowSec]);
        let deleted = (res && res.affectedRows) ? Number(res.affectedRows) : 0;
        if (deleted > 0) {
            this.statsPruned += deleted;
            console.log('AttestationSpotChecker: spot-check stats retention pruned ' + deleted +
                        ' outcome row(s) older than ' + windowSec + 's');
        }
        return deleted;
    }

    // Housekeeping hook for the retention sweep. Throttled, because the prune has
    // nothing new to delete for hours after it runs and the judge path calls it on
    // every persisted outcome. Fire-and-forget with the rejection swallowed:
    // retention is housekeeping and must never fail or stall a judging pass.
    _sweepStatsRetention(){
        if (!this.statsRetentionMs) return;
        let now = Date.now();
        if (now - this._statsSweptAt < STATS_SWEEP_MIN_INTERVAL_MS) return;
        this._statsSweptAt = now;
        this._statsSweep = this._pruneStats().catch((e) => {
            console.warn('AttestationSpotChecker: spot-check stats retention sweep failed ' +
                         '(the outcome table keeps growing until it succeeds): ' +
                         (e && e.message ? e.message : e));
            return 0;
        });
    }

    // Reorg rollback: a confirmed reorg to `height` orphans every block above
    // it, so spot-check outcomes anchored to those blocks are no longer valid
    // evidence. Delete them and clear the in-memory failure window so no slash
    // proposal fires on evidence from a block that no longer exists (fail-safe:
    // we drop the whole window rather than risk keeping an orphaned failure).
    // Returns the number of DB rows removed. Best-effort and non-throwing.
    async rollback(height){
        this._failures.clear();
        let h = Number(height);
        // A spot-check held for re-judging is anchored to the same
        // orphaned block, so purge it before the sweep can score a rolled-back
        // round into the stats the DELETE below is clearing.
        if (Number.isFinite(h)) {
            for (let [rid, rec] of Array.from(this._pendingReJudge.entries())) {
                if (Number(rec.blockIndex) > h) this._pendingReJudge.delete(rid);
            }
        }
        let db = this.hub && this.hub.db;
        if (!db || typeof db.doQuery !== 'function' || !Number.isFinite(h)) return 0;
        try {
            let res = await db.doQuery(
                'DELETE FROM ' + STATS_TABLE + ' WHERE block_index > ?', [h]);
            let removed = res && (res.affectedRows != null ? res.affectedRows : (Array.isArray(res) ? 0 : 0));
            if (removed) {
                console.log('AttestationSpotChecker: reorg rollback removed ' + removed +
                            ' spot-check row(s) above block ' + h);
            }
            return removed || 0;
        } catch (e) {
            console.warn('AttestationSpotChecker: reorg rollback failed: ' + (e && e.message ? e.message : e));
            return 0;
        }
    }

    // Aggregate durable stats for one validator (introspection / future RPC):
    // { total, failed, passed }. Reads from the persistent table; {0,0,0} when
    // no DB or no rows.
    async statsFor(pubkey){
        let empty = { total: 0, failed: 0, passed: 0 };
        if (!pubkey) return empty;
        let db = this.hub && this.hub.db;
        if (!db || typeof db.doQuery !== 'function') return empty;
        try {
            let rows = await db.doQuery(
                'SELECT COUNT(*) AS total,' +
                ' SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) AS failed' +
                ' FROM ' + STATS_TABLE + ' WHERE validator_pubkey = ?',
                [String(pubkey).toLowerCase()]);
            let r = (rows && rows[0]) || {};
            let total  = Number(r.total) || 0;
            let failed = Number(r.failed) || 0;
            return { total, failed, passed: total - failed };
        } catch (e) {
            console.warn('AttestationSpotChecker: statsFor query failed: ' + (e && e.message ? e.message : e));
            return empty;
        }
    }

    // Track a failure against a validator. If the count in the rolling
    // window crosses threshold, record a slash proposal via SlashDetector.
    _recordFailure(pubkey, requestId){
        if (!pubkey) return;
        let pk = String(pubkey).toLowerCase();
        let now = Date.now();
        let arr = this._failures.get(pk) || [];
        arr.push({ requestId: requestId, timestamp: now });
        let cutoff = now - this.failureWindowMs;
        arr = arr.filter(f => f.timestamp > cutoff);
        if (arr.length > MAX_HISTORY_PER_VALIDATOR) {
            arr = arr.slice(arr.length - MAX_HISTORY_PER_VALIDATOR);
        }
        this._failures.set(pk, arr);

        if (arr.length >= this.failureThreshold && this.hub.slashDetector
            && typeof this.hub.slashDetector._recordSlashProposal === 'function') {
            let evidence = JSON.stringify({
                failures:   arr.length,
                windowMs:   this.failureWindowMs,
                lastRequestId: requestId
            });
            let pseudoRound = parseInt(String(requestId).substring(0, 8), 16) || 0;
            this.hub.slashDetector._recordSlashProposal(pk, 'attestation_spot_check_failure', pseudoRound, evidence)
                .catch(e => console.warn('AttestationSpotChecker: slash record failed:', e));
        }
    }

    // For tests + introspection
    _failuresFor(pubkey){
        return (this._failures.get(String(pubkey || '').toLowerCase()) || []).slice();
    }
    _queueSize(){ return this._queue.size; }
    _pendingReJudgeSize(){ return this._pendingReJudge.size; }
}

module.exports = AttestationSpotChecker;
