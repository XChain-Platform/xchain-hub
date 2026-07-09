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
 * Phase status:
 *   - Queue + comparator: shipped here (data plumbing for §8.1).
 *   - Synthetic-request *injection* (hub-driven creation of platform
 *     ATTEST v0 (request) rows with a known prompt): NOT YET. Requires a
 *     platform-owned contract + scheduler design that's out of scope
 *     for this module. Operators / tests can populate the queue
 *     manually via `register()` until that lands.
 *
 * Spec: claude/reports/specs/2026-05-24_llm-attestation-provider.md §8.1
 *
 ********************************************************************/

'use strict';

const DEFAULT_FAILURE_WINDOW_MS   = 24 * 60 * 60 * 1000;  // 24h per spec §8.1
const DEFAULT_FAILURE_THRESHOLD   = 3;
const MAX_HISTORY_PER_VALIDATOR   = 64;
const MAX_QUEUE_SIZE              = 1024;

class AttestationSpotChecker {

    constructor(hub, providerRegistry){
        this.hub              = hub;
        this.providerRegistry = providerRegistry;

        let cfg = hub.p2pConfig || {};
        this.failureWindowMs  = parseInt(cfg.SPOT_CHECK_FAILURE_WINDOW_MS) || DEFAULT_FAILURE_WINDOW_MS;
        this.failureThreshold = parseInt(cfg.SPOT_CHECK_FAILURE_THRESHOLD) || DEFAULT_FAILURE_THRESHOLD;

        // Active spot-check entries: Map<requestIdLower, { providerId, expectedPattern, registeredAt }>
        this._queue = new Map();

        // Per-validator failure history: Map<pubkeyLower, [{ requestId, timestamp }]>
        this._failures = new Map();

        this._messageHandler = null;
    }

    // Wire to AttestationConsensus.start() flow. The hub calls start() after
    // attestationConsensus exists.
    async start(){
        let consensus = this.hub.attestationConsensus;
        if (!consensus) {
            console.log('AttestationSpotChecker: no AttestationConsensus, skipping start');
            return;
        }
        this._messageHandler = (event) => {
            this.onRequestFinalized(event).catch(err =>
                console.warn('AttestationSpotChecker: onRequestFinalized error: ' + (err && err.message ? err.message : err)));
        };
        consensus.on('request:finalized', this._messageHandler);
        console.log('AttestationSpotChecker started (window=' + this.failureWindowMs + 'ms, threshold=' + this.failureThreshold + ')');
    }

    async stop(){
        let consensus = this.hub.attestationConsensus;
        if (consensus && this._messageHandler) {
            consensus.removeListener('request:finalized', this._messageHandler);
            this._messageHandler = null;
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
        try {
            verdict = await Promise.resolve(provider.agree([
                { body: publishedBody, meta: String(event.meta || '') },
                { body: expectedBody,  meta: String(event.meta || '') }
            ]));
        } catch (e) {
            console.warn('AttestationSpotChecker: judge call threw for ' + rid.substring(0, 16) + '...: ', e);
            return;
        }

        let passed = !!verdict;
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
