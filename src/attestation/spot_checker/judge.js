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
 * XChain Hub - Attestation Spot-Check Judging
 *
 * What happens to a registered spot-check once its round finalizes: the inline
 * judge call, the scoring of its verdict against every signer, and the queue
 * that holds the rounds whose judge could not answer until it can.
 *
 ********************************************************************/

'use strict';
const nodeUtil = require('node:util');
const { getLogger } = require('../../observability');
const logger = getLogger();

// Re-judge queue. An ok finalization is TERMINAL: claimSpotCheck deletes the
// queue entry before judging and no later event re-triggers the spot-check, so
// a judge that could not answer would lose it for good. These bound the
// recovery queue that holds those cases until the judge answers.
const MAX_PENDING_REJUDGE        = 256;
const REJUDGE_MAX_ATTEMPTS       = 5;

// Which inconclusive reasons can change on a later attempt. Only a reason whose
// cause is the JUDGE being unavailable is retried: the provider is paused
// (llm.js markInconclusive 'provider_paused'), its endpoint is unreachable, or
// its rolling spend window is spent ('budget_exhausted', heals when the window rolls).
// Every other reason is a property of the round's own bytes (meta_unrecognized,
// meta_uncorroborated, no_proposals, unparseable, empty_verdict, truncated_pick)
// so re-asking returns the same neutral verdict; those keep today's drop.
const TRANSIENT_INCONCLUSIVE = ['provider_paused', 'unreachable', 'budget_exhausted'];

module.exports = {

    // Called via the consensus 'request:finalized' event. Looks up the
    // request_id; if it's a spot-check, runs the provider's judge over
    // the published response vs the expected pattern. Failures accrue
    // against each signing validator in a rolling window; crossing the
    // threshold records a slash proposal.
    //
    // event shape (from AttestationConsensus):
    //   { requestId, providerId, responseBody, status, meta, signatures: [{pubkey, sig}], leaderPubkey }
    async onRequestFinalized(event){
        let claim = this.claimSpotCheck(event);
        if (!claim) return;
        let { rid, entry, provider } = claim;

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
        // deferReJudge; the queue entry is already gone by this point (claimSpotCheck),
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
            logger.warn(nodeUtil.format('AttestationSpotChecker: judge call threw for %s...; deferred for re-judge:', rid.substring(0, 16), e));
            this.deferReJudge(rid, deferRecord);
            return;
        }
        if (this.heldForReJudge(rid, verdict, outcome, deferRecord)) return;

        // Reorg-safe record: persist the outcome for every signer, keyed by the
        // request's creation block so a reorg can roll it back. Best-effort; a
        // DB hiccup must not abort judging or throw out of the event handler.
        // A match clears nothing: failures accumulate over the window regardless
        // of intervening passes (per spec: 3 failures in 24h, not a streak).
        await this.scoreVerdict(entry.providerId, rid, event.signatures, blockIndex, !!verdict);
    },

    // The queue half of onRequestFinalized: is this finalization a spot-check
    // this hub can judge at all? Returns the registered entry and the provider
    // module that judges it, or null when the round is not a spot-check, is not
    // an answer, or names a provider that cannot judge here.
    claimSpotCheck(event){
        if (!event || !event.requestId) return null;
        let rid = String(event.requestId).toLowerCase();
        let entry = this._queue.get(rid);
        if (!entry) return null;  // Not a spot-check

        // A non-ok finalization (Phase 4: provider_error / no_quorum) is an
        // honest outage report, not an answer; judging its empty body against
        // the expected pattern would charge spot-check failures to validators
        // for truthfully reporting downtime. Leave the queue entry in place:
        // the request is still pending on-chain and a later ok round (e.g.
        // after the model-fallback ladder advances) still gets checked.
        if (String(event.status || 'ok') !== 'ok') return null;

        this._queue.delete(rid);

        if (entry.providerId !== event.providerId) {
            // Provider mismatch (almost certainly a bug at registration).
            // Treat as inconclusive rather than slash.
            logger.warn('AttestationSpotChecker: provider mismatch on ' + rid.substring(0, 16) +
                         '... (registered=' + entry.providerId + ', finalized=' + event.providerId + ')');
            return null;
        }

        let provider = this.providerRegistry && this.providerRegistry.getModule(entry.providerId);
        if (!provider || typeof provider.agree !== 'function') {
            logger.warn('AttestationSpotChecker: no agree() on provider ' + entry.providerId + ': cannot judge spot-check');
            return null;
        }

        return { rid: rid, entry: entry, provider: provider };
    },

    // The two inconclusive outcomes, together because the difference between them
    // is the whole decision: a judge that was UNAVAILABLE can answer on a later
    // sweep, a judge that answered without a verdict never will. True when the
    // spot-check has been dealt with here and must not be scored.
    heldForReJudge(rid, verdict, outcome, deferRecord){
        if (!verdict && outcome.inconclusive && TRANSIENT_INCONCLUSIVE.indexOf(String(outcome.reason)) >= 0) {
            // The judge was unavailable (paused provider, unreachable endpoint), which
            // says nothing about the round. Dropping it here lost the check for good:
            // llm.js pauses deliberately, and no later consensus event re-judges a
            // finalized request. Hold it and let the sweep score it once the judge is
            // back. Still neutral in the meantime: no evidence is recorded either way.
            logger.warn('AttestationSpotChecker: judge unavailable on ' + rid.substring(0, 16) +
                         '... (reason=' + outcome.reason + '); deferred for re-judge');
            this.deferReJudge(rid, deferRecord);
            return true;
        }

        if (!verdict && outcome.inconclusive) {
            // The judge answered but could not reach a verdict (refusal, unparseable
            // output, unrecognized meta, or a truncated-candidate fail-closed pick).
            // That is neutral, not a failure: it must not accrue slash evidence
            // against the signers, matching every other inconclusive branch in this
            // round (claimSpotCheck: non-ok finalization, provider mismatch). Unlike
            // the judge-unavailable branch above and the thrown-judge branch in
            // onRequestFinalized, it is also FINAL: the reason is a
            // property of this round's own bytes, so re-asking cannot change it and
            // holding the record would only burn attempts.
            logger.warn('AttestationSpotChecker: inconclusive judge verdict on ' + rid.substring(0, 16) +
                         '... (reason=' + outcome.reason + '); no evidence recorded');
            return true;
        }

        return false;
    },

    // Drive the re-judge sweep on its own timer rather than folding it
    // into schedulerTick. The injection scheduler is inert unless SPOT_CHECK_ENABLED
    // plus an injector plus a non-empty corpus are all present, and in exactly that
    // state the module still judges externally-registered spot-checks (see header),
    // so a sweep hung off the scheduler would never run for the deployments that
    // most need it. Unref'd, and a no-op pass over an empty map when nothing is held.
    startReJudgeSweep(){
        if (this._sweeper) return;
        this._sweeper = setInterval(() => {
            this.sweepReJudge().catch(err =>
                logger.warn('AttestationSpotChecker: re-judge sweep error: ' + (err && err.message ? err.message : err)));
        }, this.rejudgeSweepMs);
        if (this._sweeper.unref) this._sweeper.unref();
    },

    // Hold a spot-check whose judge could not answer, so a later sweep can score it.
    // Bounded: at capacity the OLDEST held record is dropped, matching register()'s
    // eviction rule, because an unbounded map here would cache response bodies for
    // the process lifetime.
    deferReJudge(rid, record){
        if (this._pendingReJudge.size >= MAX_PENDING_REJUDGE) {
            let firstKey = this._pendingReJudge.keys().next().value;
            if (firstKey) this._pendingReJudge.delete(firstKey);
        }
        this._pendingReJudge.set(rid, record);
    },

    // One re-judge pass: re-ask the judge about every held spot-check and score the
    // ones that now have a conclusive verdict, through the same persistStats /
    // recordFailure paths the inline judge uses. Still-inconclusive records stay
    // until they run out of attempts or age out; each record is independently
    // guarded so one provider failure cannot abort the pass or throw out of the
    // timer. Overlap-guarded for the same reason schedulerTick is: nothing
    // bounds a judge round trip, so a hung provider would otherwise let passes
    // stack up and re-ask the same records concurrently.
    async sweepReJudge(){
        if (this._pendingReJudge.size === 0) return 0;
        if (this._sweepInFlight) return 0;
        this._sweepInFlight = true;
        try {
            let scored = 0;
            let now = Date.now();
            for (let [rid, rec] of Array.from(this._pendingReJudge.entries())) {
                if (now - rec.firstSeen > this.rejudgeMaxAgeMs || rec.attempts >= REJUDGE_MAX_ATTEMPTS) {
                    this._pendingReJudge.delete(rid);
                    logger.warn('AttestationSpotChecker: giving up on deferred spot-check ' + rid.substring(0, 16) +
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
                    logger.warn('AttestationSpotChecker: re-judge threw for ' + rid.substring(0, 16) + '...: ' +
                                 (e && e.message ? e.message : e));
                    continue;
                }
                if (!verdict && outcome.inconclusive) {
                    // Still could not judge. A reason that is no longer transient can
                    // never change, so stop holding the record rather than burning the
                    // remaining attempts on it.
                    if (TRANSIENT_INCONCLUSIVE.indexOf(String(outcome.reason)) < 0) {
                        this._pendingReJudge.delete(rid);
                        logger.warn('AttestationSpotChecker: deferred spot-check ' + rid.substring(0, 16) +
                                     '... resolved inconclusive (reason=' + outcome.reason + '); no evidence recorded');
                    }
                    continue;
                }
                this._pendingReJudge.delete(rid);
                await this.scoreVerdict(rec.providerId, rid, rec.signatures, rec.blockIndex, !!verdict);
                scored++;
            }
            return scored;
        } finally {
            this._sweepInFlight = false;
        }
    },

    // The scoring half of a judged spot-check, shared by the inline judge in
    // onRequestFinalized and the re-judge sweep so the two can never drift.
    // Persists one row per signer (reorg-safe, keyed by the request's creation
    // block) and accrues a failure against every signer on a judged-wrong round.
    async scoreVerdict(providerId, rid, signatures, blockIndex, passed){
        for (let s of (signatures || [])) {
            await this.persistStats(s.pubkey, providerId, rid, blockIndex, passed);
        }
        if (passed) return;
        logger.warn('AttestationSpotChecker: failed spot-check on ' + rid.substring(0, 16) +
                     '... (provider=' + providerId + ', signers=' + (signatures || []).length + ')');
        for (let s of (signatures || [])) {
            this.recordFailure(s.pubkey, rid);
        }
    }

};
