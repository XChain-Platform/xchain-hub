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
 * Phase 4 quality enforcement  ships three pieces here:
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
 * Spec: claude/reports/specs/2026-05-24_llm-attestation-provider.md §8.1
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

        this._messageHandler = null;
        this._reorgHandler   = null;
        this._scheduler      = null;
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
        // Backpressure: leave headroom so injections never evict live entries.
        if (this._queue.size >= Math.floor(MAX_QUEUE_SIZE * 0.9)) {
            console.warn('AttestationSpotChecker: spot-check queue near capacity, skipping injection tick');
            return 0;
        }
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
        this._queue.clear();
        this._failures.clear();
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

        let verdict;
        let outcome = {};
        try {
            verdict = await Promise.resolve(provider.agree([
                { body: publishedBody, meta: String(event.meta || '') },
                { body: expectedBody,  meta: String(event.meta || '') }
            ], { outcome }));
        } catch (e) {
            console.warn('AttestationSpotChecker: judge call threw for ' + rid.substring(0, 16) + '...: ', e);
            return;
        }

        if (!verdict && outcome.inconclusive) {
            // The judge could not reach a verdict (unreachable chain, refusal,
            // unparseable output, or a truncated-candidate fail-closed pick).
            // That is neutral, not a failure: it must not accrue slash
            // evidence against the signers, matching every other inconclusive
            // branch in this method (lines above: non-ok finalization,
            // provider mismatch, judge call threw).
            console.warn('AttestationSpotChecker: inconclusive judge verdict on ' + rid.substring(0, 16) +
                         '... (reason=' + outcome.reason + '); no evidence recorded');
            return;
        }

        let passed = !!verdict;
        let blockIndex = Number(event.request && event.request.block_index) || 0;

        // Reorg-safe record: persist the outcome for every signer, keyed by the
        // request's creation block so a reorg can roll it back. Best-effort; a
        // DB hiccup must not abort judging or throw out of the event handler.
        for (let s of (event.signatures || [])) {
            await this._persistStats(s.pubkey, entry.providerId, rid, blockIndex, passed);
        }

        if (passed) {
            // Match: clear nothing; failures accumulate over the window
            // regardless of intervening passes (per spec: 3 failures in
            // 24h is the trigger, not a streak).
            return;
        }

        console.warn('AttestationSpotChecker: failed spot-check on ' + rid.substring(0, 16) +
                     '... (provider=' + entry.providerId + ', signers=' + (event.signatures || []).length + ')');
        for (let s of (event.signatures || [])) {
            this._recordFailure(s.pubkey, rid);
        }
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
        } catch (e) {
            console.warn('AttestationSpotChecker: stats persist failed for ' +
                         String(pubkey).substring(0, 16) + '...: ' + (e && e.message ? e.message : e));
        }
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
}

module.exports = AttestationSpotChecker;
