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
const nodeUtil = require('node:util');
const { getLogger } = require('../observability');
const logger = getLogger();
// The parts this class is assembled from. Each exports plain methods that are
// installed on the prototype below, so a caller, a stub or a walk over an
// instance sees exactly the class it saw before the split.
const injection = require('./spot_checker/injection.js');
const judge     = require('./spot_checker/judge.js');
const evidence  = require('./spot_checker/evidence.js');

const DEFAULT_FAILURE_WINDOW_MS   = 24 * 60 * 60 * 1000;  // 24h per spec §8.1
const DEFAULT_FAILURE_THRESHOLD   = 3;

const DEFAULT_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000;    // 1h between injection ticks
const DEFAULT_MAX_INJECTIONS_PER_TICK = 1;

// Retention window for the durable spot-check outcome table. One row lands per
// judged (validator, request) and nothing but the reorg rollback ever deleted one,
// so the table grew for the life of the deployment while every sibling hub audit
// table carries an explicit window (telemetry_pings, oracle_submissions,
// oracle_published_rounds, attest_published_requests). 90 days matches
// attest_published_requests, the closest sibling. 0 disables the sweep.
const DEFAULT_STATS_RETENTION_MS  = 90 * 24 * 60 * 60 * 1000;

// Cadence and give-up age for the re-judge sweep; the queue they bound, and the
// reasons worth retrying, live in spot_checker/judge.js.
const DEFAULT_REJUDGE_MAX_AGE_MS = 30 * 60 * 1000;       // 30m, then give up and drop
const DEFAULT_REJUDGE_SWEEP_MS   = 5 * 60 * 1000;        // 5m between re-judge passes

class AttestationSpotChecker {

    constructor(hub, providerRegistry){
        this.hub              = hub;
        this.providerRegistry = providerRegistry;

        let cfg = hub.p2pConfig || {};
        this.failureWindowMs  = parseInt(cfg.SPOT_CHECK_FAILURE_WINDOW_MS) || DEFAULT_FAILURE_WINDOW_MS;
        this.failureThreshold = parseInt(cfg.SPOT_CHECK_FAILURE_THRESHOLD) || DEFAULT_FAILURE_THRESHOLD;

        // Scheduler config (see header). Off unless SPOT_CHECK_ENABLED is set.
        this.schedulerEnabled = this.isTruthy(cfg.SPOT_CHECK_ENABLED);
        this.intervalMs       = parseInt(cfg.SPOT_CHECK_INTERVAL_MS) || DEFAULT_SCHEDULER_INTERVAL_MS;
        this.maxPerTick       = parseInt(cfg.SPOT_CHECK_MAX_PER_TICK) || DEFAULT_MAX_INJECTIONS_PER_TICK;
        this.corpus           = this.parseCorpus(cfg.SPOT_CHECK_CORPUS);
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
        this._tickInFlight   = false;   // scheduler self-overlap guard, see schedulerTick()
        this._sweepInFlight  = false;   // same guard for the re-judge sweep

        // Durable-outcome retention, see pruneStats(). 0 (explicitly configured)
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

    isTruthy(v){
        if (v === true) return true;
        let s = String(v == null ? '' : v).trim().toLowerCase();
        return s === '1' || s === 'true' || s === 'yes' || s === 'on';
    }

    // Accepts a JSON string or an array of { providerId|provider_id, prompt,
    // expectedPattern|expected } entries. Silently drops malformed entries so a
    // bad governance config can never crash the scheduler.
    parseCorpus(raw){
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
                    logger.warn('AttestationSpotChecker: rollback error: ' + (err && err.message ? err.message : err)));
            };
            reorg.on('reorg:confirmed', this._reorgHandler);
        }

        this.startReJudgeSweep();

        let consensus = this.hub.attestationConsensus;
        if (!consensus) {
            logger.info('AttestationSpotChecker: no AttestationConsensus, skipping consensus wiring');
            this.startScheduler();
            return;
        }
        this._messageHandler = (event) => {
            this.onRequestFinalized(event).catch(err =>
                logger.warn('AttestationSpotChecker: onRequestFinalized error: ' + (err && err.message ? err.message : err)));
        };
        consensus.on('request:finalized', this._messageHandler);
        logger.info('AttestationSpotChecker started (window=' + this.failureWindowMs + 'ms, threshold=' + this.failureThreshold + ')');
        this.startScheduler();
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

    // For tests + introspection
    failuresFor(pubkey){
        return (this._failures.get(String(pubkey || '').toLowerCase()) || []).slice();
    }
    queueSize(){ return this._queue.size; }
    pendingReJudgeSize(){ return this._pendingReJudge.size; }
}

// The parts are installed as NON-ENUMERABLE prototype methods, the descriptor a
// class body gives its own, so the split cannot change what a for-in walk, a deep
// compare or a sinon stub over an instance sees.
for (const part of [injection, judge, evidence]) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(part))) {
        Object.defineProperty(AttestationSpotChecker.prototype, name, Object.assign(descriptor, { enumerable: false }));
    }
}

module.exports = AttestationSpotChecker;

