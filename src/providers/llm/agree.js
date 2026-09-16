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
 * XChain Hub - llm provider: agree(), the judge_model consensus strategy
 *
 * Walks the judge fallback chain under one round budget, parses the verdict
 * strictly, and returns the canonical proposal only when the judge picked a
 * body it saw in full and that proposal's `meta` passes both gates.
 *
 ********************************************************************/

const { modelCarriesSystemRole } = require('./models');
const { markInconclusive, buildJudgePrompt, judgeRequest, parseJudgement } = require('./judge');

// Sentinel resolved by the outer wall-clock race in agree(). A private
// Symbol so it can never collide with a verdict (agree() resolves an object or
// null) no matter what a transport returns.
const _AGREE_BUDGET_SPENT = Symbol('agree budget spent');

class JudgeAgreement {
    // Every dependency is the provider instance's own: its logger, LlmSettings (the
    // live config and kill switch), SpendAudit (the guard and the billed runLlm) and
    // MetaGates.
    constructor({ logger, settings, spend, metaGates }) {
        this.logger    = logger;
        this.settings  = settings;
        this.spend     = spend;
        this.metaGates = metaGates;
        this.runLlm    = (opts) => spend.runLlm(opts);
        this._judgeCall = this.runLlm;
    }

    // The judge transport, as a rebindable binding rather than a direct call. Always
    // runLlm on a validator; nothing reads it off config or the environment, so it
    // cannot be swapped anywhere but in-process.
    //
    // It exists because the OUTER budget below has to hold against a transport that
    // does not honour the timeout it was handed, and no real transport here has that
    // shape: both HTTP branches arm armWallClockDeadline and the CLI branch arms a
    // SIGTERM kill, so a suite that mocks https or child_process only ever reproduces
    // the bound that already worked. Injecting the judge call is the only way to build
    // the failure the wall is for.
    setJudgeCallForTest(fn) { this._judgeCall = (typeof fn === 'function') ? fn : this.runLlm; }

    // The answer for the paths that never dial a judge, or undefined when the
    // multi-proposal judge call should go ahead.
    verdictWithoutJudge(proposals, options) {
        // Kill switch: a single proposal is returned without any billed
        // judge call, so only gate the paths that would actually dial a vendor (the
        // multi-proposal judge fan-out below). Guarded again just before runLlm.
        let paused = !this.settings.llmEnabled();
        if (!Array.isArray(proposals) || proposals.length === 0) {
            markInconclusive(options, 'no_proposals');
            return null;
        }
        if (proposals.length === 1) {
            // Allowlist still applies with a single proposal. There is nothing to
            // corroborate against, but an unapproved identifier is unrecognized either way
            // and must not reach the canonical signature.
            let solo = this.metaGates.canonicalMeta(proposals, 0, options);
            if (solo === null) return null;
            return { body: proposals[0].body, meta: solo };
        }

        // The multi-proposal path below issues a billed judge call. When the
        // provider is paused, do not dial: mark the round inconclusive (could-not-judge)
        // and return null, the same contract a judge-transport outage already produces.
        if (paused) {
            markInconclusive(options, 'provider_paused');
            return null;
        }
        // Same shape for a spent budget. The guard is hub-global (one SpendGuard for
        // every model and vendor), so once the window is exhausted every fallback in
        // the chain below is refused at runLlm's reserve gate too; walking it would
        // only write a futile intent+blocked settle pair per model and then record the
        // round as 'unreachable', the vendor-outage shape. allow() is a pure predicate
        // (no budget consumed); the in-loop budgetExhausted check below covers the
        // concurrent-round race between this allow() and the chain's reserve().
        if (!this.spend.spendGuard().allow(null)) {
            markInconclusive(options, 'budget_exhausted');
            return null;
        }
        return undefined;
    }

    // Only carry models that can receive the trusted judge framing in a real
    // system/developer turn (see modelCarriesSystemRole). A model that
    // cannot is skipped rather than silently flattening the SECURITY
    // data-vs-instruction boundary into the same user turn as the
    // nonce-fenced untrusted candidates; if that drops the chain to empty,
    // the existing !reached -> no_quorum path below still applies.
    judgeChainFor(judgeModel) {
        return [judgeModel, ...this.settings.JUDGE_FALLBACK_MODELS.filter(m => m && m !== judgeModel)]
            .filter(m => {
                if (modelCarriesSystemRole(m)) return true;
                this.logger.warn('llm: judge model ' + m + ' cannot carry a system/developer role; skipping from judge chain');
                return false;
            });
    }

    // True when a failed judge attempt ends the chain, with the round already
    // marked inconclusive; false when the chain may advance to the next model.
    judgeFailureStopsChain(e, jm, options) {
        // Transport-only invariant: a REACHED judge's outcome (a model
        // refusal, a truncation, or a hard non-transient API error) is a
        // judgment outcome, not a transport failure, and must NOT be re-asked
        // of a different fallback model. Only transport failures (transient
        // errors, credential/endpoint resolution) may advance the chain.
        // A spent budget is neither: the guard is hub-global, so every later
        // model in the chain is refused too. Stop here (see the pre-loop gate).
        if (e && e.budgetExhausted) {
            this.logger.warn('llm: judge ' + jm + ' refused by the spend budget; stopping fallback chain');
            markInconclusive(options, 'budget_exhausted');
            return true;
        }
        if (e && (e.kind === 'refusal' || e.transient === false)) {
            this.logger.warn('llm: judge ' + jm + ' returned a non-transport outcome (' +
                (e.kind || 'hard_error') + '); deferring to no_quorum without advancing chain');
            // Three buckets, not two. The chain-advance
            // decision is the same for all of them, but the recorded reason is
            // the only place an operator sees WHY the round went inconclusive:
            // a 4xx from a deprecated model id, an auth misconfiguration, and a
            // non-zero claude CLI exit all arrive here with kind undefined, and
            // labelling those 'judge_refusal' makes vendor-contract drift
            // indistinguishable from real content moderation.
            let reason = 'judge_hard_error';
            if (e.kind === 'truncation')   reason = 'judge_truncation';
            else if (e.kind === 'refusal') reason = 'judge_refusal';
            markInconclusive(options, reason);
            return true;
        }
        return false;
    }

    // Judge fallback chain: pinned judge first, then the configured
    // alternates (deduped). Only TRANSPORT failures (vendor down, no creds,
    // timeout) advance the chain; a reachable judge's verdict, however
    // unparseable, is a judgment outcome and must not be re-asked of a
    // different model. Leader-local: followers adopt the leader's winner and
    // never re-judge, so this needs no cross-hub determinism.
    // Returns { stopped } when a failure ended the round, else { reached, judgeText }.
    async walkJudgeChain(judgeModel, judgeSystem, judgePrompt, options, judgeInfo) {
        let judgeChain = this.judgeChainFor(judgeModel);
        let judgeText  = null;
        let reached    = false;
        // Single deadline shared across the whole fallback chain. The caller's
        // timeoutMs is the round budget (see AttestationConsensus._checkAgree), so a
        // slow-drip vendor that times out per attempt must not let the chain consume
        // (chain length) x timeoutMs and overrun the attestation round window. Each
        // attempt gets the REMAINING budget, and the chain stops advancing once the
        // budget is exhausted. When no budget is supplied the chain runs on the
        // transport default per attempt, as before.
        let deadlineAt = Number(options.timeoutMs) > 0 ? Date.now() + Number(options.timeoutMs) : null;
        const REMAINING_FLOOR_MS = 250;
        let judgeCall  = this._judgeCall;
        // From here on a vendor call is dialled, which is what makes this round's
        // latency worth a log line at the wrapper's return.
        judgeInfo.attempted = true;
        for (let jm of judgeChain) {
            judgeInfo.model = jm;
            let attemptTimeoutMs = options.timeoutMs;
            if (deadlineAt !== null) {
                let remaining = deadlineAt - Date.now();
                if (remaining < REMAINING_FLOOR_MS) {
                    this.logger.warn('llm: judge budget exhausted before reaching model ' + jm + '; stopping fallback chain');
                    break;
                }
                attemptTimeoutMs = remaining;
            }
            try {
                judgeText = await judgeCall(judgeRequest(jm, judgeSystem, judgePrompt, attemptTimeoutMs, options));
                reached = true;
                judgeInfo.answered = jm;
                if (jm !== judgeModel)
                    this.logger.warn('llm: judge fell back to ' + jm + ' (pinned ' + judgeModel + ' unreachable)');
                break;
            } catch (e) {
                if (this.judgeFailureStopsChain(e, jm, options)) return { stopped: true };
                this.logger.warn('llm: judge model ' + jm + ' unreachable: ' + (e && e.message ? e.message : e));
            }
        }
        return { reached, judgeText };
    }

    // A parsed verdict to the canonical proposal, or null.
    pickCanonical(judgement, proposals, truncated, options) {
        if (judgement.equivalent === true && judgement.canonical_index !== null && judgement.canonical_index !== undefined) {
            let idx = Number(judgement.canonical_index) - 1;  // judge prompt is 1-indexed
            if (Number.isInteger(idx) && idx >= 0 && idx < proposals.length) {
                // The judge only ever saw the first MAX_JUDGE_CANDIDATE_CHARS bytes of
                // a truncated candidate. Finalizing its FULL untruncated body would
                // put bytes the judge never evaluated on-chain (a Byzantine validator
                // can craft a body whose visible prefix mimics honest output and whose
                // unseen tail carries arbitrary payload). Fail closed to no_quorum
                // rather than finalize an unjudged tail.
                if (truncated[idx]) {
                    this.logger.warn('llm: judge selected a truncated candidate (index ' + (idx + 1) +
                        '); failing to no_quorum to avoid finalizing bytes the judge never evaluated');
                    markInconclusive(options, 'truncated_pick');
                    return null;
                }
                // The judge vouched for the BODY it selected, never for that
                // proposal's meta. Gate the meta separately before it is canonicalized.
                let meta = this.metaGates.canonicalMeta(proposals, idx, options);
                if (meta === null) return null;
                return { body: proposals[idx].body, meta: meta };
            }
        }
        // Reached the end without a valid equivalent+canonical_index verdict: the
        // judge genuinely judged the candidates not equivalent (or gave an
        // out-of-range index). This IS a real verdict, not an inconclusive
        // could-not-judge outcome, so options.outcome is left as-is.
        return null;
    }

    // Consensus strategy: judge_model (spec §6).
    //
    // Single-proposal case (redundancy=1): trivial. Return the only proposal.
    // Multi-proposal case (redundancy>=3): build a judge prompt enumerating
    // candidate responses, run JUDGE_MODEL at temperature=0, parse JSON
    // verdict { equivalent, canonical_index } and return the canonical
    // proposal (or null on no_quorum).
    // When a caller supplies options.outcome, agree() populates it before every
    // inconclusive (could-not-judge) `return null` so the caller can distinguish
    // "judged not equivalent" from "could not judge" without changing the return
    // contract. Callers that ignore options.outcome keep today's null-only
    // semantics (e.g. byte_equality-style providers where null genuinely means
    // "bytes differ").
    //
    // The whole agree() call, ladder included, bounded from ENTRY by
    // options.timeoutMs. See agree() below for why the inner ladder deadline
    // is not enough on its own; `judgeInfo` is the telemetry channel that lets the
    // wrapper name the model that actually answered.
    async agreeJudged(proposals, options, judgeInfo) {
        let early = this.verdictWithoutJudge(proposals, options);
        if (early !== undefined) return early;

        // The judge model is supplied by the leader as options.pinnedJudgeModel,
        // resolved from the block-anchored provider config at the request's block, so
        // it does not depend on this hub's module-mutable JUDGE_MODEL (which a
        // governance hotReload can change mid-round). Fall back to JUDGE_MODEL only
        // when no pinned value is provided (e.g. a non-consensus caller).
        let judgeModel = options.pinnedJudgeModel || this.settings.JUDGE_MODEL;

        let candidates = proposals.map(p => Buffer.isBuffer(p.body) ? p.body.toString('utf8') : String(p.body || ''));
        let { system: judgeSystem, prompt: judgePrompt, truncated } = buildJudgePrompt(candidates);

        let { stopped, reached, judgeText } = await this.walkJudgeChain(judgeModel, judgeSystem, judgePrompt, options, judgeInfo);
        if (stopped) return null;
        if (!reached) {
            // Whole judge chain unreachable: defer to no_quorum. Validators will
            // retry on the next round. (Spec §6.4 ack residual risk.)
            markInconclusive(options, 'unreachable');
            return null;
        }

        if (!judgeText) {
            markInconclusive(options, 'empty_verdict');
            return null;
        }

        let judgement = parseJudgement(judgeText, options);
        if (judgement === null) return null;
        return this.pickCanonical(judgement, proposals, truncated, options);
    }

    // THE ROUND'S WHOLE JUDGE BUDGET, measured from entry rather than from the first
    // transport call. The ladder inside already gives each attempt the remaining
    // budget and stops advancing once it is gone, but that only bounds the calls it
    // actually reaches: the work before the first attempt, the verdict parse after
    // the last one, and above all a transport that does not honour the timeout it
    // was handed all sit outside it. The caller is an attestation round whose
    // effective_time and round timer are both sized against this number
    // (AttestationConsensus.maybeAdvanceFromProposals), so it needs a wall it can
    // reason about without auditing three transports: whatever the ladder is doing,
    // it gets an answer within options.timeoutMs of the call.
    //
    // A spent budget resolves through the existing inconclusive channel, under its
    // own reason so an operator can tell a TIME budget from the SPEND budget that
    // already reports 'budget_exhausted'. Inconclusive maps to no_quorum, which is
    // retryable, so the request survives to a later round.
    //
    // The losing inner promise is left running to completion: nothing can cancel a
    // spawned CLI or an in-flight request from here, and its own transport deadline
    // will end it. Its result is dropped and its rejection swallowed, because an
    // orphaned transport failure surfacing as an unhandled rejection takes the hub
    // process down.
    //
    // This is a wall against ASYNC overrun only. Synchronous work on this path (the
    // spend-audit fsync in appendLine, JSON of a large candidate set) blocks the
    // event loop, and a timer cannot fire while it does.
    async agree(proposals, options) {
        options = options || {};
        const startedAt = Date.now();
        // Filled in by the ladder: whether a judge call was attempted at all, the last
        // model it dialled, and the model that actually answered (the two differ when
        // the chain walked past an unreachable vendor, and only the second exists when
        // a verdict came back). Read back below so the latency line is usable even on
        // the paths that return no verdict.
        const judgeInfo = {};
        const budgetMs  = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 0;

        let timer  = null;
        let verdict;
        try {
            let inner = this.agreeJudged(proposals, options, judgeInfo);
            if (budgetMs > 0) {
                inner.catch(() => {});
                let spent = new Promise(resolve => {
                    timer = setTimeout(() => resolve(_AGREE_BUDGET_SPENT), budgetMs);
                    if (timer.unref) timer.unref();
                });
                verdict = await Promise.race([inner, spent]);
            } else {
                verdict = await inner;
            }
        } finally {
            if (timer) clearTimeout(timer);
        }

        if (verdict === _AGREE_BUDGET_SPENT) {
            this.logger.warn('llm: agree() budget of ' + budgetMs + 'ms spent before a verdict' +
                (judgeInfo.model ? ' (last judge dialled ' + judgeInfo.model + ')' : '') + '; inconclusive');
            markInconclusive(options, 'judge_timeout');
            verdict = null;
        }

        // One line per judge round so the fleet's judge latency is readable off the
        // logs. Only the multi-proposal path dials a vendor, and only that path has a
        // latency worth recording; the redundancy=1 short-circuit stays silent.
        if (judgeInfo.attempted) {
            this.logger.warn('llm: agree() returned in ' + (Date.now() - startedAt) + 'ms' +
                ' (judge=' + (judgeInfo.answered || (judgeInfo.model ? judgeInfo.model + ':no-answer' : 'none')) +
                ', verdict=' + (verdict ? 'winner' : 'null') + ')');
        }
        return verdict;
    }
}

module.exports = JudgeAgreement;
